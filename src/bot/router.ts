import type { AppContext } from '../lib/app-context';
import type { NormalizedIncomingMessage } from '../lib/types';
import { getMessageQueue, serializeMessage } from '../queue/message-queue';
import { handleMessage } from '../queue/message-handler';

// ── BullMQ path (Redis available) ─────────────────────────────────────────────

async function enqueueViaBullMQ(
  app: AppContext,
  message: NormalizedIncomingMessage,
): Promise<void> {
  const queue = getMessageQueue(app.env.redisUrl!);

  // Use chatId as the job name so BullMQ can deduplicate and order per-chat.
  // jobId is unique per message; the queue preserves FIFO order per chatId.
  await queue.add(message.chatId, serializeMessage(message), {
    jobId: `${message.chatId}:${message.messageId}`,
  });

  app.logger.info(
    { userId: message.userId, chatId: message.chatId },
    'Message enqueued via BullMQ',
  );
}

// ── In-memory fallback (no Redis) ─────────────────────────────────────────────
// Keeps the same per-chat sequential guarantee without Redis.

const chatQueues = new Map<string, Promise<void>>();
const MESSAGE_DEADLINE_MS = 2 * 60_000;

function enqueueInMemory(app: AppContext, message: NormalizedIncomingMessage): void {
  const chatId = message.chatId;
  const tail = chatQueues.get(chatId) ?? Promise.resolve();

  const next = tail
    .then(() => {
      const deadline = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('message_deadline_exceeded')),
          MESSAGE_DEADLINE_MS,
        ),
      );
      return Promise.race([handleMessage(app, message), deadline]);
    })
    .catch((err) => {
      const isDeadline = err instanceof Error && err.message === 'message_deadline_exceeded';
      app.logger.error(
        { err, chatId: message.chatId, userId: message.userId, isDeadline },
        'Failed to handle incoming WhatsApp message',
      );
      if (app.whatsappProvider) {
        app.whatsappProvider.sendText({
          chatId: message.chatId,
          text: "sorry, something went wrong on my end 😔 try again in a moment!",
        }).catch(() => {});
      }
    })
    .finally(() => {
      if (chatQueues.get(chatId) === next) {
        chatQueues.delete(chatId);
      }
    });

  chatQueues.set(chatId, next);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function enqueueMessage(app: AppContext, message: NormalizedIncomingMessage): void {
  if (app.env.redisUrl) {
    enqueueViaBullMQ(app, message).catch((err) => {
      app.logger.error({ err }, 'BullMQ enqueue failed, falling back to in-memory queue');
      enqueueInMemory(app, message);
    });
  } else {
    enqueueInMemory(app, message);
  }
}
