import { ensureUser, saveMessage } from '../db/store';
import type { AppContext } from '../lib/app-context';
import type { NormalizedIncomingMessage } from '../lib/types';
import { runMainAgent } from '../ai/main-agent';

export async function handleIncomingWhatsAppMessage(
  app: AppContext,
  message: NormalizedIncomingMessage,
): Promise<void> {
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

  await runMainAgent(app, {
    sessionId: message.sessionId,
    userId: message.userId,
    chatId: message.chatId,
    messageId: message.messageId,
    text: message.text,
    attachments: message.attachments,
    allowSending: true,
    sentMessages: [],
  });
}
