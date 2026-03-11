import { ensureUser, listRecentMessages, saveMessage } from '../db/store';
import type { AppContext } from '../lib/app-context';
import type { ChatHistoryMessage } from '../lib/app-context';
import type { NormalizedIncomingMessage } from '../lib/types';
import { runMainAgent } from '../ai/main-agent';

const chatQueues = new Map<string, Promise<void>>();

export function enqueueMessage(app: AppContext, message: NormalizedIncomingMessage): void {
  const chatId = message.chatId;
  const previous = chatQueues.get(chatId) ?? Promise.resolve();

  const next = previous
    .then(() => handleIncomingWhatsAppMessage(app, message))
    .catch((error) => {
      app.logger.error(
        { err: error, chatId: message.chatId, userId: message.userId },
        'Failed to handle incoming WhatsApp message',
      );
    })
    .finally(() => {
      if (chatQueues.get(chatId) === next) {
        chatQueues.delete(chatId);
      }
    });

  chatQueues.set(chatId, next);
}

async function handleIncomingWhatsAppMessage(
  app: AppContext,
  message: NormalizedIncomingMessage,
): Promise<void> {
  app.logger.info(
    { userId: message.userId, chatId: message.chatId, text: message.text, attachments: message.attachments.length },
    'Incoming WhatsApp message',
  );

  await ensureUser(app.db, {
    userId: message.userId,
    chatId: message.chatId,
  });

  await saveMessage(app.db, {
    userId: message.userId,
    chatId: message.chatId,
    direction: 'inbound',
    text: message.text,
    attachmentIds: message.attachments.map((attachment) => attachment.id),
    createdAt: message.receivedAt,
  });

  const recentMessages = await listRecentMessages(app.db, message.chatId, 20);
  const history: ChatHistoryMessage[] = recentMessages
    .filter((m) => m.text.trim().length > 0)
    .map((m) => ({
      role: m.direction === 'inbound' ? 'user' as const : 'assistant' as const,
      content: m.text,
    }));

  await runMainAgent(app, {
    sessionId: message.sessionId,
    userId: message.userId,
    chatId: message.chatId,
    messageId: message.messageId,
    text: message.text,
    attachments: message.attachments,
    allowSending: true,
    sentMessages: [],
    history,
  });
}
