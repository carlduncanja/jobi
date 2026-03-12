import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import type { AppContext, MainAgentRequestContext } from '../lib/app-context';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_API_KEY = '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';

export function createTranscribeAudioTool(app: AppContext, request: MainAgentRequestContext) {
  return tool({
    description:
      'Transcribe a voice message / audio attachment to text. Call this when the user sends a voice note or audio file. Pass the attachment filename to identify which audio to transcribe.',
    inputSchema: zodSchema(
      z.object({
        filename: z.string().describe('The filename of the audio attachment to transcribe'),
      }),
    ),
    execute: async ({ filename }) => {
      const attachment = request.attachments.find(
        (a) => a.kind === 'audio' && (a.filename === filename || a.id.includes('audio')),
      );

      if (!attachment) {
        const audioAttachment = request.attachments.find((a) => a.kind === 'audio');
        if (!audioAttachment) {
          return { error: 'No audio attachment found in this message' };
        }
        return await transcribe(app, audioAttachment.bytes, audioAttachment.mimeType);
      }

      return await transcribe(app, attachment.bytes, attachment.mimeType);
    },
  });
}

async function transcribe(
  app: AppContext,
  audioBytes: Uint8Array,
  mimeType: string,
): Promise<{ text: string } | { error: string }> {
  try {
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'wav';
    const blob = new Blob([audioBytes], { type: mimeType });

    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'json');

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text();
      app.logger.error({ status: response.status, body }, 'Groq transcription failed');
      return { error: `Transcription failed (${response.status})` };
    }

    const result = (await response.json()) as { text?: string };
    return { text: result.text ?? '' };
  } catch (err) {
    app.logger.error({ err }, 'Groq transcription error');
    return { error: 'Transcription failed unexpectedly' };
  }
}
