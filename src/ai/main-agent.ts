import { generateText, stepCountIs, type ModelMessage } from 'ai';

import { getMainAgentModel } from './models';
import type { AppContext, MainAgentRequestContext } from '../lib/app-context';
import { createSaveResumeTool } from '../tools/save-resume';
import { createSearchJobsTool } from '../tools/search-jobs';
import { createSendMessageTool } from '../tools/send-message';
import { createSubscribeNotificationsTool } from '../tools/subscribe-notifications';
import { createTranscribeAudioTool } from '../tools/transcribe-audio';
import { createUnsubscribeNotificationsTool } from '../tools/unsubscribe-notifications';
import { retryAsync } from '../lib/utils';

export interface MainAgentResponse {
  text: string;
  sentMessageCount: number;
}

const SYSTEM_PROMPT = `You are Job Bot, a WhatsApp assistant that helps people find jobs, manage their resume, and control daily job notifications. You talk like a real person — casual, friendly, and helpful. Think of yourself as a friend who's really good at finding jobs.

HOW YOU COMMUNICATE:
- You send messages through the sendMessage tool. That is the ONLY way you can talk to the user.
- You can call sendMessage as many times as you want in a single turn. Use it freely.
- Send short messages. This is WhatsApp, not email. Keep each message to 1-3 short paragraphs max.
- When you have a lot of info (like job results), break it into multiple messages — don't dump everything in one wall of text. For example, send 2-3 jobs per message.
- Acknowledge the user quickly before doing heavy work. If they ask you to search for jobs, send a quick "on it, let me look into that!" BEFORE calling searchJobs. Don't leave them hanging.
- After a tool finishes, tell the user what happened before moving on. "Found some great options!" then share the results.

YOUR TOOLS:
- searchJobs: Search for job listings. Use when the user asks about jobs, openings, or work.
- saveResume: Save or update the user's resume from attached files (PDF, DOCX, images, or text).
- transcribeAudio: Transcribe a voice message to text. ALWAYS call this FIRST when the user sends a voice note or audio attachment, before doing anything else. Pass the attachment filename.
- subscribeNotifications: Subscribe to daily job digests.
- unsubscribeNotifications: Unsubscribe from daily job digests.
- sendMessage: Send a WhatsApp message. Call this as many times as needed — for acks, updates, results, follow-ups.

CLARIFY BEFORE SEARCHING:
- If a location is ambiguous (e.g. "Kingston" could be Jamaica or Ontario, "Portland" could be Oregon or Maine, "Springfield" could be many places), ASK the user which one they mean BEFORE searching. Don't guess.
- If the job query is too vague (e.g. just "jobs" with no role or field), ask what kind of work they're looking for.
- Once you've clarified, remember the answer for future searches in this conversation.

FLOW EXAMPLES:
- User says "find me react jobs in NYC":
  1. sendMessage("let me search for that!")
  2. searchJobs(prompt: "react jobs in NYC")
  3. sendMessage("found some options for you!")
  4. sendMessage(first batch of 2-3 jobs with details)
  5. sendMessage(next batch if there are more)

- User says "jobs in Kingston":
  1. sendMessage("just to make sure — do you mean Kingston, Jamaica or Kingston, Ontario?")
  (wait for reply, then search with the right location)

- User says "hey what's up":
  1. sendMessage("hey! i'm here to help you find jobs...")

- User sends a resume:
  1. sendMessage("got your resume, let me take a look")
  2. saveResume(...)
  3. sendMessage("looks great! here's what i found in your resume: ...")

- User sends a voice note:
  1. transcribeAudio(filename from attachments)
  2. Now you know what they said — respond to it normally (search jobs, answer questions, etc.)

RULES:
1. Every turn MUST include at least one sendMessage call. Never end a turn without talking to the user.
2. Do not invent job details. Only report what tools return.
3. Use conversation history to remember context — what the user told you, what you found, what you did.
4. Be concise but warm. No corporate speak. Talk like a helpful friend on WhatsApp.
5. When in doubt about what the user means, ask. Don't assume.`;

export async function runMainAgent(
  app: AppContext,
  request: MainAgentRequestContext,
): Promise<MainAgentResponse> {
  try {
    const result = await retryAsync(
      () => generateText({
        model: getMainAgentModel(app),
        system: SYSTEM_PROMPT,
        messages: buildMessages(request),
        tools: {
          searchJobs: createSearchJobsTool(app, request),
          saveResume: createSaveResumeTool(app, request),
          transcribeAudio: createTranscribeAudioTool(app, request),
          subscribeNotifications: createSubscribeNotificationsTool(app, request),
          unsubscribeNotifications: createUnsubscribeNotificationsTool(app, request),
          sendMessage: createSendMessageTool(app, request),
        },
        toolChoice: 'auto',
        stopWhen: stepCountIs(12),
      }),
      { maxRetries: 2, label: 'main-agent', logger: app.logger },
    );

    const sentText =
      request.sentMessages.at(-1)?.text ??
      result.text ??
      '';

    return {
      text: sentText,
      sentMessageCount: request.sentMessages.length,
    };
  } catch (error) {
    app.logger.error(
      { err: error, userId: request.userId, chatId: request.chatId },
      'Main agent failed',
    );
    throw error;
  }
}

function buildMessages(request: MainAgentRequestContext): ModelMessage[] {
  const messages: ModelMessage[] = [];

  const history = request.history;
  const priorHistory = history.length > 0 && history[history.length - 1].role === 'user'
    && history[history.length - 1].content === request.text
    ? history.slice(0, -1)
    : history;

  for (const entry of priorHistory) {
    messages.push({ role: entry.role, content: entry.content });
  }

  const parts: string[] = [];
  parts.push(request.text || '(empty)');

  if (request.attachments.length > 0) {
    const list = request.attachments
      .map((a, i) => `- ${a.filename ?? `attachment-${i + 1}`} (${a.mimeType}, ${a.kind})`)
      .join('\n');
    parts.push(`\nAttachments:\n${list}`);
  }

  messages.push({ role: 'user', content: parts.join('') });

  return messages;
}
