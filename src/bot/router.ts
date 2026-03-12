import {
  createReferral,
  ensureUser,
  getUser,
  getReferralStats,
  listRecentMessages,
  lookupReferralCode,
  saveMessage,
} from '../db/store';
import type { AppContext } from '../lib/app-context';
import type { ChatHistoryMessage } from '../lib/app-context';
import type { NormalizedIncomingMessage } from '../lib/types';
import { runMainAgent } from '../ai/main-agent';

const REFERRAL_CODE_RE = /\bREF-([A-Z0-9]+)\b/i;

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

  let messageText = message.text;

  const existingMessages = await listRecentMessages(app.db, message.chatId, 1);
  const isFirstMessage = existingMessages.length === 0;

  if (isFirstMessage) {
    const refMatch = messageText.match(REFERRAL_CODE_RE);
    if (refMatch) {
      const code = refMatch[1].toUpperCase();
      messageText = messageText.replace(REFERRAL_CODE_RE, '').trim() || 'Hi';

      try {
        const referrerId = await lookupReferralCode(app.db, code);
        if (referrerId && referrerId !== message.userId) {
          await createReferral(app.db, {
            referrerId,
            referredUserId: message.userId,
            referralCode: code,
          });
          app.logger.info(
            { referrerId, referredUserId: message.userId, code },
            'Referral recorded',
          );

          await notifyReferrer(app, referrerId, code);
        }
      } catch (err) {
        app.logger.error({ err, code }, 'Failed to process referral code');
      }
    }
  }

  await saveMessage(app.db, {
    userId: message.userId,
    chatId: message.chatId,
    direction: 'inbound',
    text: messageText,
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
    text: messageText,
    attachments: message.attachments,
    allowSending: true,
    sentMessages: [],
    history,
  });
}

async function notifyReferrer(app: AppContext, referrerId: string, code: string): Promise<void> {
  try {
    const referrer = await getUser(app.db, referrerId);
    if (!referrer || !app.whatsappProvider) return;

    const stats = await getReferralStats(app.db, referrerId);
    const text =
      `Someone just joined Jobi through your referral link! 🎉\n\n` +
      `You now have *${stats.count + 1}* referral${stats.count === 0 ? '' : 's'} this month. ` +
      `Keep sharing to win the $10,000 monthly prize!`;

    await app.whatsappProvider.sendText({ chatId: referrer.chatId, text });
  } catch (err) {
    app.logger.error({ err, referrerId }, 'Failed to notify referrer');
  }
}
