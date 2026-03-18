import { createHash } from 'node:crypto';
import { URL } from 'node:url';

import type { AttachmentKind, AgentRequestAttachmentInput, NormalizedAttachment } from './types';

const IMAGE_MIME_PREFIX = 'image/';
const TEXT_MIME_PREFIX = 'text/';
const AUDIO_MIME_PREFIX = 'audio/';
const VIDEO_MIME_PREFIX = 'video/';

export function isoNow(): string {
  return new Date().toISOString();
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }

  return `${input.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function safeFilename(filename: string | undefined, fallback: string): string {
  const base = filename?.trim() || fallback;
  return base.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Text(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function attachmentKindFromMime(mimeType: string, fallback: AttachmentKind = 'other'): AttachmentKind {
  if (mimeType.startsWith(IMAGE_MIME_PREFIX)) {
    return 'image';
  }

  if (mimeType.startsWith(TEXT_MIME_PREFIX)) {
    return 'text';
  }

  if (mimeType.startsWith(AUDIO_MIME_PREFIX)) {
    return 'audio';
  }

  if (mimeType.startsWith(VIDEO_MIME_PREFIX)) {
    return 'video';
  }

  if (
    mimeType === 'application/pdf' ||
    mimeType === 'application/msword' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'document';
  }

  return fallback;
}

export function normalizeIncomingAttachments(
  attachments: AgentRequestAttachmentInput[] | undefined,
): NormalizedAttachment[] {
  if (!attachments?.length) {
    return [];
  }

  return attachments.map((attachment, index) => {
    const bytes = Uint8Array.from(Buffer.from(attachment.base64, 'base64'));
    const id = `attachment:${sha256Hex(bytes)}`;

    return {
      id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      kind: attachment.kind ?? attachmentKindFromMime(attachment.mimeType),
      bytes,
      caption: attachment.caption,
      sha256: sha256Hex(bytes),
      source: 'api',
    };
  });
}

export function stableBucket(input: string, modulo: number): number {
  const digest = createHash('sha256').update(input).digest();
  const value = digest.readUInt32BE(0);
  return value % modulo;
}

export function canonicalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = '';

    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gh_jid',
      'gh_src',
      'fbclid',
    ];

    for (const key of trackingParams) {
      url.searchParams.delete(key);
    }

    if (url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.toString();
  } catch {
    return input;
  }
}

export async function parseJsonBody<T>(request: Request): Promise<T> {
  const body = await request.json();
  return body as T;
}

export async function retryAsync<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number; label?: string; logger?: { warn: (...args: any[]) => void } } = {},
): Promise<T> {
  const { maxRetries = 2, baseDelayMs = 2000, label = 'operation', logger } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isAbort =
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted'));

      if (isAbort) throw error;

      const isRetryable =
        error instanceof Error &&
        (error.message.includes('timed out') ||
          error.message.includes('timeout') ||
          error.message.includes('ECONNRESET') ||
          error.message.includes('500') ||
          error.message.includes('502') ||
          error.message.includes('503') ||
          error.message.includes('429'));

      if (!isRetryable || attempt >= maxRetries) {
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt);
      logger?.warn({ attempt: attempt + 1, maxRetries, delay, label }, `Retrying ${label} after transient error`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
