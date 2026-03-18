import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';

import type { AppContext } from '../lib/app-context';
import type { NormalizedAttachment, NormalizedIncomingMessage } from '../lib/types';
import { handleMessage } from './message-handler';

export const QUEUE_NAME = 'whatsapp-messages';

// ── Serialisable job payload ──────────────────────────────────────────────────
// NormalizedAttachment contains Uint8Array which isn't JSON-safe — convert to
// base64 strings for storage in Redis and back on the worker side.

interface SerializedAttachment {
  id: string;
  filename?: string;
  mimeType: string;
  kind: NormalizedAttachment['kind'];
  bytesBase64: string;
  caption?: string;
  sha256?: string;
  source: NormalizedAttachment['source'];
}

export interface MessageJobData {
  sessionId: string;
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  attachments: SerializedAttachment[];
  receivedAt: string;
}

export function serializeMessage(msg: NormalizedIncomingMessage): MessageJobData {
  return {
    sessionId: msg.sessionId,
    chatId: msg.chatId,
    userId: msg.userId,
    messageId: msg.messageId,
    text: msg.text,
    receivedAt: msg.receivedAt,
    attachments: msg.attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      kind: a.kind,
      bytesBase64: Buffer.from(a.bytes).toString('base64'),
      caption: a.caption,
      sha256: a.sha256,
      source: a.source,
    })),
  };
}

export function deserializeMessage(data: MessageJobData): NormalizedIncomingMessage {
  return {
    sessionId: data.sessionId,
    chatId: data.chatId,
    userId: data.userId,
    messageId: data.messageId,
    text: data.text,
    receivedAt: data.receivedAt,
    attachments: data.attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      kind: a.kind,
      bytes: new Uint8Array(Buffer.from(a.bytesBase64, 'base64')),
      caption: a.caption,
      sha256: a.sha256,
      source: a.source,
    })),
  };
}

// ── Connection ────────────────────────────────────────────────────────────────
// BullMQ accepts a plain URL string as ConnectionOptions — no separate ioredis
// instance needed (it bundles its own copy).

function makeConnection(redisUrl: string): ConnectionOptions {
  return {
    url: redisUrl,
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
  } as ConnectionOptions;
}

// ── Queue (producer) ──────────────────────────────────────────────────────────

let _queue: Queue<MessageJobData> | null = null;

export function getMessageQueue(redisUrl: string): Queue<MessageJobData> {
  if (!_queue) {
    _queue = new Queue<MessageJobData>(QUEUE_NAME, {
      connection: makeConnection(redisUrl),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: 200,
      },
    });
  }
  return _queue;
}

// ── Worker (consumer) ─────────────────────────────────────────────────────────

const MESSAGE_DEADLINE_MS = 2 * 60_000;

export function startMessageWorker(app: AppContext): Worker<MessageJobData> {
  const redisUrl = app.env.redisUrl!;

  const worker = new Worker<MessageJobData>(
    QUEUE_NAME,
    async (job: Job<MessageJobData>) => {
      const message = deserializeMessage(job.data);

      app.logger.info(
        { jobId: job.id, userId: message.userId, chatId: message.chatId, text: message.text },
        'Processing queued message',
      );

      const deadline = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('message_deadline_exceeded')),
          MESSAGE_DEADLINE_MS,
        ),
      );

      await Promise.race([handleMessage(app, message), deadline]);
    },
    {
      connection: makeConnection(redisUrl),
      // SurrealDB (surrealkv) is single-node — high concurrency causes transaction
      // conflicts that crash the process. 8 concurrent jobs is a safe ceiling.
      concurrency: 8,
    },
  );

  worker.on('failed', async (job, err) => {
    const isDeadline = err.message === 'message_deadline_exceeded';
    app.logger.error({ jobId: job?.id, err, isDeadline }, 'Message job failed');

    // On final failure send a fallback so the user isn't left hanging
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1) && app.whatsappProvider) {
      const data = job.data as MessageJobData;
      await app.whatsappProvider.sendText({
        chatId: data.chatId,
        text: "sorry, something went wrong on my end 😔 try again in a moment!",
      }).catch(() => {});
    }
  });

  worker.on('error', (err) => {
    app.logger.error({ err }, 'BullMQ worker error');
  });

  app.logger.info('BullMQ message worker started');
  return worker;
}
