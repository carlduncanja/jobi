import * as qrcode from 'qrcode-terminal';
import pino from 'pino';
import makeWASocket, {
  BufferJSON,
  Browsers,
  DisconnectReason,
  addTransactionCapability,
  downloadMediaMessage,
  extractMessageContent,
  fetchLatestBaileysVersion,
  getContentType,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  type AuthenticationState,
  type ConnectionState,
  type SignalDataSet,
  type SignalKeyStore,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';

import { clearSessionAuthState, getSessionRecord, saveSessionAuthState, saveSessionStatus } from '../../db/store';
import type { WhatsAppProvider } from '../../domain/ports/whatsapp-provider';
import type { AppContext } from '../../lib/app-context';
import type {
  NormalizedAttachment,
  NormalizedIncomingMessage,
  OutboundAudioMessage,
  OutboundDocumentMessage,
  OutboundTextMessage,
  SendMessageResult,
  WhatsAppProviderEvent,
  WhatsAppSessionStatus,
} from '../../lib/types';
import { attachmentKindFromMime, normalizeWhitespace } from '../../lib/utils';

export class BaileysWhatsAppProvider implements WhatsAppProvider {
  private readonly listeners = new Set<(event: WhatsAppProviderEvent) => Promise<void> | void>();
  private readonly baileysLogger = pino({ level: 'silent' }) as any;
  private socket: WASocket | null = null;
  private status: WhatsAppSessionStatus;
  private stopped = false;
  private pairingCodeRequested = false;
  private pendingSyncMessages: WAMessage[] = [];
  private pendingSyncChats: Array<{ id: string; unreadCount?: number }> = [];
  private syncDone = false;
  private processedMessageIds = new Set<string>();

  constructor(private readonly app: AppContext, private readonly sessionId: string) {
    this.status = {
      sessionId,
      state: 'close',
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket?.end(undefined);
    this.socket = null;
    this.status = {
      ...this.status,
      state: 'close',
    };
  }

  subscribe(listener: (event: WhatsAppProviderEvent) => Promise<void> | void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Wait up to `timeoutMs` for the socket to be available (handles brief
   * reconnect windows where socket is null for a few seconds).
   */
  private async waitForSocket(timeoutMs = 15_000): Promise<WASocket> {
    const start = Date.now();
    while (!this.socket) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('WhatsApp socket is not connected');
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return this.socket;
  }

  async sendText(message: OutboundTextMessage): Promise<SendMessageResult> {
    const socket = await this.waitForSocket();

    const sent = await socket.sendMessage(
      message.chatId,
      { text: message.text },
      message.quotedMessageId
        ? { quoted: { key: { remoteJid: message.chatId, id: message.quotedMessageId }, message: {} } as any }
        : undefined,
    );

    return {
      delivered: true,
      providerMessageId: sent?.key?.id ?? undefined,
    };
  }

  async sendAudio(message: OutboundAudioMessage): Promise<SendMessageResult> {
    const socket = await this.waitForSocket();

    const sent = await socket.sendMessage(message.chatId, {
      audio: Buffer.from(message.audioBytes),
      mimetype: message.mimeType,
      ptt: true,
    });

    return {
      delivered: true,
      providerMessageId: sent?.key?.id ?? undefined,
    };
  }

  async sendDocument(message: OutboundDocumentMessage): Promise<SendMessageResult> {
    const socket = await this.waitForSocket();

    const sent = await socket.sendMessage(message.chatId, {
      document: Buffer.from(message.documentBytes),
      mimetype: message.mimeType,
      fileName: message.filename,
      caption: message.caption,
    });

    return {
      delivered: true,
      providerMessageId: sent?.key?.id ?? undefined,
    };
  }

  async getSessionStatus(): Promise<WhatsAppSessionStatus> {
    return this.status;
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.socket) {
      throw new Error('WhatsApp socket is not connected');
    }

    const pairingCode = (await this.socket.requestPairingCode(phoneNumber)) ?? undefined;
    this.status = {
      ...this.status,
      pairingCode,
    };
    await saveSessionStatus(this.app.db, this.sessionId, this.status);
    await this.emit({
      type: 'connection',
      session: this.status,
    });

    if (!pairingCode) {
      throw new Error('WhatsApp pairing code was not returned');
    }

    return pairingCode;
  }

  private async connect(): Promise<void> {
    const auth = await createAuthState(this.app, this.sessionId, this.baileysLogger);
    const { version } = await fetchLatestBaileysVersion();

    this.socket = makeWASocket({
      auth: auth.state,
      version,
      browser: Browsers.macOS('Desktop'),
      logger: this.baileysLogger,
      markOnlineOnConnect: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
    });

    this.socket.ev.on('creds.update', async () => {
      await auth.save();
    });

    this.socket.ev.on('connection.update', async (update) => {
      await this.handleConnectionUpdate(update);
    });

    this.socket.ev.on('messaging-history.set', ({ messages }) => {
      if (!this.syncDone) {
        this.pendingSyncMessages.push(...messages);
      }
    });

    this.socket.ev.on('chats.upsert', (chats) => {
      if (!this.syncDone) {
        for (const chat of chats) {
          this.pendingSyncChats.push({
            id: chat.id ?? '',
            unreadCount: chat.unreadCount ?? undefined,
          });
          const historyMsgs = (chat as any).messages as Array<{ message?: WAMessage }> | undefined;
          if (historyMsgs) {
            for (const hMsg of historyMsgs) {
              if (hMsg.message) {
                this.pendingSyncMessages.push(hMsg.message);
              }
            }
          }
        }
      }
    });

    this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (!this.syncDone && type === 'append') {
        this.pendingSyncMessages.push(...messages);
        return;
      }

      if (type !== 'notify') {
        return;
      }

      for (const message of messages) {
        if (this.processedMessageIds.has(message.key.id ?? '')) {
          continue;
        }
        this.trackMessageId(message.key.id ?? '');

        const normalized = await this.normalizeMessage(message);

        if (!normalized) {
          continue;
        }

        await this.emit({
          type: 'message',
          message: normalized,
        });
      }
    });

    if (
      this.app.env.whatsapp.usePairingCode &&
      this.app.env.whatsapp.pairingPhoneNumber &&
      !this.pairingCodeRequested
    ) {
      this.pairingCodeRequested = true;

      setTimeout(() => {
        void this.requestPairingCode(this.app.env.whatsapp.pairingPhoneNumber!);
      }, 3_000);
    }
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const reason = getDisconnectReason(update.lastDisconnect?.error);

    if (update.qr) {
      this.app.logger.info('Scan this QR code with WhatsApp on your phone:');
      qrcode.generate(update.qr, { small: true });
    }

    this.status = {
      sessionId: this.sessionId,
      state: update.connection ?? this.status.state,
      qr: update.qr ?? this.status.qr,
      pairingCode: this.status.pairingCode,
      lastDisconnectReason: reason,
    };

    if (update.connection === 'open') {
      this.app.logger.info('WhatsApp connected successfully!');
      this.status.qr = undefined;
      this.status.lastDisconnectReason = undefined;

      setTimeout(() => {
        void this.processUnrepliedMessages();
      }, 5_000);
    }

    await saveSessionStatus(this.app.db, this.sessionId, this.status);
    await this.emit({
      type: 'connection',
      session: this.status,
    });

    if (update.connection === 'close' && !this.stopped) {
      if (reason === 'logged_out') {
        this.app.logger.warn('WhatsApp logged out, clearing auth state and reconnecting fresh');
        await clearSessionAuthState(this.app.db, this.sessionId);
        this.pairingCodeRequested = false;
      } else {
        this.app.logger.warn({ reason }, 'WhatsApp connection closed, reconnecting');
      }
      setTimeout(() => {
        void this.connect();
      }, 3_000);
    }
  }

  private trackMessageId(id: string): void {
    this.processedMessageIds.add(id);
    if (this.processedMessageIds.size > 5000) {
      const first = this.processedMessageIds.values().next().value;
      if (first) this.processedMessageIds.delete(first);
    }
  }

  private getOwnJid(): string | undefined {
    return this.socket?.user?.id;
  }

  private isOwnChat(jid: string): boolean {
    const ownJid = this.getOwnJid();
    if (!ownJid) return false;
    const ownNumber = ownJid.split('@')[0].split(':')[0];
    const chatNumber = jid.split('@')[0].split(':')[0];
    return ownNumber === chatNumber;
  }

  private async processUnrepliedMessages(): Promise<void> {
    this.syncDone = true;
    const synced = this.pendingSyncMessages;
    const syncedChats = this.pendingSyncChats;
    this.pendingSyncMessages = [];
    this.pendingSyncChats = [];

    this.app.logger.info(
      { messageCount: synced.length, chatCount: syncedChats.length },
      'Catchup: collected sync data',
    );

    const chatMessages = new Map<string, WAMessage[]>();
    for (const msg of synced) {
      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;
      if (this.isOwnChat(jid)) continue;
      const list = chatMessages.get(jid) ?? [];
      list.push(msg);
      chatMessages.set(jid, list);
    }

    const unreadChatIds = new Set<string>();
    for (const chat of syncedChats) {
      if (!chat.id || chat.id === 'status@broadcast') continue;
      if (this.isOwnChat(chat.id)) continue;
      if (chat.unreadCount && chat.unreadCount > 0) {
        unreadChatIds.add(chat.id);
      }
    }

    let catchupCount = 0;

    for (const [chatId, messages] of chatMessages) {
      messages.sort((a, b) => {
        const tsA = Number(a.messageTimestamp ?? 0);
        const tsB = Number(b.messageTimestamp ?? 0);
        return tsA - tsB;
      });

      const lastMsg = messages[messages.length - 1];
      if (!lastMsg || lastMsg.key.fromMe) continue;

      if (this.processedMessageIds.has(lastMsg.key.id ?? '')) continue;
      this.trackMessageId(lastMsg.key.id ?? '');

      const normalized = await this.normalizeMessage(lastMsg);
      if (!normalized) continue;

      this.app.logger.info(
        { chatId, text: normalized.text, userId: normalized.userId },
        'Catching up on unreplied message',
      );

      await this.emit({ type: 'message', message: normalized });
      unreadChatIds.delete(chatId);
      catchupCount++;
    }

    if (unreadChatIds.size > 0) {
      this.app.logger.info(
        { chats: [...unreadChatIds] },
        'Chats with unread messages but no synced message content (will reply on next message)',
      );
    }

    this.app.logger.info({ catchupCount }, 'Catchup complete');
  }

  private async normalizeMessage(message: WAMessage): Promise<NormalizedIncomingMessage | null> {
    if (message.key.fromMe || !message.key.remoteJid || !message.message) {
      return null;
    }

    if (message.key.remoteJid === 'status@broadcast') {
      return null;
    }

    if (this.isOwnChat(message.key.remoteJid)) {
      return null;
    }

    const content = extractMessageContent(message.message);

    if (!content) {
      return null;
    }

    const text = extractTextFromMessage(content);
    const attachments = await this.extractAttachments(message, content).catch((err) => {
      this.app.logger.warn({ err, messageId: message.key.id }, 'Failed to extract attachments, skipping');
      return [] as NormalizedAttachment[];
    });

    // Drop messages with no text and no attachments — these are Baileys
    // duplicate/update events (e.g. read receipts) that have nothing to process.
    if (!text.trim() && attachments.length === 0) {
      return null;
    }

    const rawUserId = (message.key.participant ?? message.key.remoteJid).split('@')[0];
    const userId = rawUserId || message.key.remoteJid.split('@')[0];
    const timestampSeconds = Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000));

    return {
      sessionId: this.sessionId,
      chatId: message.key.remoteJid,
      userId,
      messageId: message.key.id ?? crypto.randomUUID(),
      text,
      attachments,
      receivedAt: new Date(timestampSeconds * 1_000).toISOString(),
    };
  }

  private async extractAttachments(
    message: WAMessage,
    content: NonNullable<WAMessage['message']>,
  ): Promise<NormalizedAttachment[]> {
    if (!this.socket) {
      return [];
    }

    const contentType = getContentType(content);

    const supported = ['imageMessage', 'documentMessage', 'audioMessage'];
    if (!contentType || !supported.includes(contentType)) {
      return [];
    }

    let buffer: Buffer;
    try {
      buffer = await downloadMediaMessage(
        message,
        'buffer',
        {},
        {
          logger: this.baileysLogger,
          reuploadRequest: this.socket.updateMediaMessage,
        },
      ) as Buffer;
    } catch (err) {
      this.app.logger.warn({ err, messageId: message.key.id }, 'Media download failed, skipping attachment');
      return [];
    }

    if (contentType === 'imageMessage' && content.imageMessage) {
      return [
        {
          id: `wa-${message.key.id}-image`,
          filename: `${message.key.id}.jpg`,
          mimeType: content.imageMessage.mimetype ?? 'image/jpeg',
          kind: 'image',
          bytes: Uint8Array.from(buffer),
          caption: content.imageMessage.caption ?? undefined,
          source: 'whatsapp',
        },
      ];
    }

    if (contentType === 'documentMessage' && content.documentMessage) {
      return [
        {
          id: `wa-${message.key.id}-document`,
          filename: content.documentMessage.fileName ?? `${message.key.id}.bin`,
          mimeType: content.documentMessage.mimetype ?? 'application/octet-stream',
          kind: attachmentKindFromMime(
            content.documentMessage.mimetype ?? 'application/octet-stream',
            'document',
          ),
          bytes: Uint8Array.from(buffer),
          caption: content.documentMessage.caption ?? undefined,
          source: 'whatsapp',
        },
      ];
    }

    if (contentType === 'audioMessage' && content.audioMessage) {
      const mime = content.audioMessage.mimetype ?? 'audio/ogg; codecs=opus';
      const ext = mime.includes('ogg') ? 'ogg' : 'mp4';
      return [
        {
          id: `wa-${message.key.id}-audio`,
          filename: `${message.key.id}.${ext}`,
          mimeType: mime,
          kind: 'audio',
          bytes: Uint8Array.from(buffer),
          source: 'whatsapp',
        },
      ];
    }

    return [];
  }

  private async emit(event: WhatsAppProviderEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}

async function createAuthState(
  app: AppContext,
  sessionId: string,
  logger: any,
): Promise<{
  state: AuthenticationState;
  save: () => Promise<void>;
}> {
  const existing = await getSessionRecord(app.db, sessionId);
  const creds =
    deserialize<AuthStateStorage['creds']>(existing?.creds) ?? initAuthCreds();
  const keys = deserialize<AuthStateStorage['keys']>(existing?.keys) ?? {};

  const keyStoreBase: SignalKeyStore = {
    get(type, ids) {
      const bucket = keys[type] ?? {};
      const data: Record<string, unknown> = {};

      for (const id of ids) {
        if (bucket[id] !== undefined) {
          data[id] = bucket[id];
        }
      }

      return data as any;
    },
    async set(data) {
      for (const category of Object.keys(data) as Array<keyof SignalDataSet>) {
        const values = data[category];

        if (!values) {
          continue;
        }

        keys[category] ??= {};

        for (const [id, value] of Object.entries(values)) {
          if (value === null) {
            delete keys[category]?.[id];
          } else {
            keys[category]![id] = value;
          }
        }
      }

      await persist();
    },
  };

  const keyStore = addTransactionCapability(
    makeCacheableSignalKeyStore(keyStoreBase, logger),
    logger,
    {
      maxCommitRetries: 3,
      delayBetweenTriesMs: 50,
    },
  );

  const state: AuthenticationState = {
    creds,
    keys: keyStore,
  };

  const persist = async () => {
    await saveSessionAuthState(app.db, sessionId, {
      creds: serialize(state.creds),
      keys: serialize(keys),
    });
  };

  return {
    state,
    save: persist,
  };
}

type AuthStateStorage = {
  creds: AuthenticationState['creds'];
  keys: Record<string, Record<string, unknown>>;
};

function serialize(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer)) as Record<string, unknown>;
}

function deserialize<T>(value: unknown): T | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T;
}

function extractTextFromMessage(content: NonNullable<WAMessage['message']>): string {
  const directText =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.documentMessage?.caption ??
    content.videoMessage?.caption ??
    '';

  return normalizeWhitespace(directText);
}

function getDisconnectReason(error: unknown): string | undefined {
  const statusCode = (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

  switch (statusCode) {
    case DisconnectReason.loggedOut:
      return 'logged_out';
    case DisconnectReason.restartRequired:
      return 'restart_required';
    case DisconnectReason.connectionClosed:
      return 'connection_closed';
    case DisconnectReason.connectionLost:
      return 'connection_lost';
    case DisconnectReason.connectionReplaced:
      return 'connection_replaced';
    default:
      return statusCode ? `disconnect_${statusCode}` : undefined;
  }
}
