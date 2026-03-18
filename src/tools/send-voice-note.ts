import { spawn } from 'node:child_process';
import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import type { AppContext, MainAgentRequestContext } from '../lib/app-context';

const GROQ_TTS_URL = 'https://api.groq.com/openai/v1/audio/speech';
const GROQ_API_KEY = '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';

export function createSendVoiceNoteTool(app: AppContext, request: MainAgentRequestContext) {
  return tool({
    description:
      'Send a voice note to the user. Use when the user asks you to reply with audio, sends a voice note themselves, or when a spoken reply feels more natural. Keep the text short and conversational — it will be spoken aloud.',
    inputSchema: zodSchema(
      z.object({
        text: z.string().min(1).describe('The text to speak in the voice note. Keep it short and natural.'),
      }),
    ),
    execute: async ({ text }) => {
      if (!request.allowSending || !app.whatsappProvider) {
        return { delivered: false };
      }

      const audioBytes = await synthesizeSpeech(app, text);
      if (!audioBytes) {
        // TTS failed — fall back to text so the user still gets a reply
        app.logger.warn({ userId: request.userId }, 'TTS failed, falling back to text message');
        await app.whatsappProvider.sendText({ chatId: request.chatId, text });
        request.sentMessages.push({ text });
        return { delivered: true, fallbackToText: true };
      }

      const result = await app.whatsappProvider.sendAudio({
        chatId: request.chatId,
        audioBytes,
        mimeType: 'audio/ogg; codecs=opus',
      });

      app.logger.info(
        { userId: request.userId, chatId: request.chatId, textLength: text.length },
        'Outgoing voice note sent',
      );

      return { delivered: result.delivered, providerMessageId: result.providerMessageId };
    },
  });
}

async function synthesizeSpeech(app: AppContext, text: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(GROQ_TTS_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'canopylabs/orpheus-v1-english',
        input: text,
        voice: 'hannah',
        response_format: 'wav',
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      app.logger.error({ status: response.status, body }, 'Groq TTS failed');
      return null;
    }

    const wavBytes = new Uint8Array(await response.arrayBuffer());
    return await convertWavToOgg(wavBytes);
  } catch (err) {
    app.logger.error({ err }, 'Groq TTS error');
    return null;
  }
}

function convertWavToOgg(wavBytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-vbr', 'on',
      '-f', 'ogg',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stdout.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    ffmpeg.on('error', reject);
    ffmpeg.stderr.on('data', () => {}); // suppress ffmpeg logs

    ffmpeg.stdin.write(Buffer.from(wavBytes));
    ffmpeg.stdin.end();
  });
}
