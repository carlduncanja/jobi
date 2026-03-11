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

import { getSessionRecord, saveSessionAuthState, saveSessionStatus } from '../../db/store';
import type { WhatsAppProvider } from '../../domain/ports/whatsapp-provider';
import type { AppContext } from '../../lib/app-context';
import type {
  NormalizedAttachment,
  NormalizedIncomingMessage,
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

  async sendText(message: OutboundTextMessage): Promise<SendMessageResult> {
    if (!this.socket) {
      throw new Error('WhatsApp socket is not connected');
    }

    const sent = await this.socket.sendMessage(message.chatId, {
      text: message.text,
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
      printQRInTerminal: false,
      logger: this.baileysLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    this.socket.ev.on('creds.update', async () => {
      await auth.save();
    });

    this.socket.ev.on('connection.update', async (update) => {
      await this.handleConnectionUpdate(update);
    });

    this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') {
        return;
      }

      for (const message of messages) {
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

    this.status = {
      sessionId: this.sessionId,
      state: update.connection ?? this.status.state,
      qr: update.qr ?? this.status.qr,
      pairingCode: this.status.pairingCode,
      lastDisconnectReason: reason,
    };

    if (update.connection === 'open') {
      this.status.qr = undefined;
      this.status.lastDisconnectReason = undefined;
    }

    await saveSessionStatus(this.app.db, this.sessionId, this.status);
    await this.emit({
      type: 'connection',
      session: this.status,
    });

    if (update.connection === 'close' && !this.stopped && reason !== 'logged_out') {
      this.app.logger.warn({ reason }, 'WhatsApp connection closed, reconnecting');
      setTimeout(() => {
        void this.connect();
      }, 3_000);
    }
  }

  private async normalizeMessage(message: WAMessage): Promise<NormalizedIncomingMessage | null> {
    if (message.key.fromMe || !message.key.remoteJid || !message.message) {
      return null;
    }

    if (message.key.remoteJid === 'status@broadcast') {
      return null;
    }

    const content = extractMessageContent(message.message);

    if (!content) {
      return null;
    }

    const text = extractTextFromMessage(content);
    const attachments = await this.extractAttachments(message, content);
    const userId = (message.key.participant ?? message.key.remoteJid).split('@')[0];
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

    if (contentType !== 'imageMessage' && contentType !== 'documentMessage') {
      return [];
    }

    const buffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger: this.baileysLogger,
        reuploadRequest: this.socket.updateMediaMessage,
      },
    );

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
