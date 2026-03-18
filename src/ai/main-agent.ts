import { generateText, stepCountIs, type ModelMessage } from 'ai';

import { getMainAgentModel } from './models';
import type { AppContext, MainAgentRequestContext } from '../lib/app-context';
import { createGetReferralLinkTool } from '../tools/get-referral-link';
import { createGetReferralStatsTool } from '../tools/get-referral-stats';
import { createSaveResumeTool } from '../tools/save-resume';
import { createSearchJobsTool } from '../tools/search-jobs';
import { createSendMessageTool } from '../tools/send-message';
import { createSendVoiceNoteTool } from '../tools/send-voice-note';
import { createSubscribeNotificationsTool } from '../tools/subscribe-notifications';
import { createTranscribeAudioTool } from '../tools/transcribe-audio';
import { createUnsubscribeNotificationsTool } from '../tools/unsubscribe-notifications';
import { retryAsync } from '../lib/utils';

export interface MainAgentResponse {
  text: string;
  sentMessageCount: number;
}

const SYSTEM_PROMPT = `You are Jobi, a WhatsApp job assistant. You text like a real person — short, casual, no fluff.

TONE:
- Write like you're texting a friend. Short sentences. Lowercase is fine.
- No greetings on every message ("Great!", "Sure!", "Of course!" — cut all of that).
- No filler. Say the thing. "found 3 jobs" not "I was able to locate 3 job opportunities for you!"
- Use line breaks to separate info, not walls of text.
- 1-2 sentences per message is usually enough. Only go longer when sharing actual job details.

TOOLS:
- searchJobs: search for jobs
- saveResume: save resume from an attached file
- transcribeAudio: transcribe a voice note — ALWAYS call this first before anything else when there's an audio attachment
- subscribeNotifications: sign up for daily job alerts
- unsubscribeNotifications: turn off daily alerts
- getReferralLink: get the user's referral link
- getReferralStats: get referral count, rank, leaderboard
- sendMessage: send a text message — the main way to talk to the user
- sendVoiceNote: send a voice note. Use when the user sends a voice note (reply in kind) or asks for audio.

BEFORE SEARCHING:
- Location ambiguous (e.g. "Kingston")? Ask which one before searching.
- "near me" or "around here"? Ask where they are — you don't have GPS.
- Query too vague (just "jobs")? Ask what kind of work.

FLOWS:

Job search:
1. sendMessage("on it 🔍")
2. searchJobs(...)
3. Send results in small batches (2-3 jobs per message). For each job: title, company, location, link. Keep it tight.

No jobs found:
1. sendMessage("nothing came up for [role] right now")
2. sendMessage("want me to set up an alert so you hear when something shows up?")
3. If yes → subscribeNotifications() → sendMessage("done, i'll hit you up when i find something 🔔")

Resume:
1. sendMessage("got it, looking at your resume...")
2. saveResume(...)
3. Short summary of what was found

Voice note:
1. transcribeAudio(...)
2. sendVoiceNote(...) with a short spoken reply — match their energy, reply in audio since they did

Referral link:
1. getReferralLink()
2. Send their link + count in one clean message

Ad click ("Hello! Can I get more info on this?" or similar):
- They found you through an ad. Don't ask what they mean.
- sendMessage("hey! i'm Jobi 👋 i help you find jobs on WhatsApp. what kind of work are you looking for?")

REFERRAL PROGRAM:
- Top referrer each month wins $10,000 JMD.
- Referral counts when someone joins through their link AND searches or sends a resume.
- Mention it once after helping with a search or resume: "btw you can win $10k JMD just for sharing me — say 'my link' to get yours"
- Don't repeat it every turn.

RULES:
1. Every turn must have at least one sendMessage.
2. Never make up job details. Only use what tools return.
3. Never say "I found some jobs" if the jobs array is empty.
4. Remember context from the conversation — don't ask for info they already gave you.`;

const AGENT_TIMEOUT_MS = 3 * 60_000;

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  if (error.message.toLowerCase().includes('aborted')) return true;
  const cause = (error as any).cause;
  if (cause instanceof Error) return isAbortError(cause);
  return false;
}

export async function runMainAgent(
  app: AppContext,
  request: MainAgentRequestContext,
): Promise<MainAgentResponse> {
  try {
    const timeoutSignal = AbortSignal.timeout(AGENT_TIMEOUT_MS);
    const abortSignal = request.abortSignal
      ? AbortSignal.any([timeoutSignal, request.abortSignal])
      : timeoutSignal;

    const result = await retryAsync(
      () => generateText({
        model: getMainAgentModel(app),
        system: SYSTEM_PROMPT,
        messages: buildMessages(request),
        abortSignal,
        tools: {
          searchJobs: createSearchJobsTool(app, request),
          saveResume: createSaveResumeTool(app, request),
          transcribeAudio: createTranscribeAudioTool(app, request),
          subscribeNotifications: createSubscribeNotificationsTool(app, request),
          unsubscribeNotifications: createUnsubscribeNotificationsTool(app, request),
          getReferralLink: createGetReferralLinkTool(app, request),
          getReferralStats: createGetReferralStatsTool(app, request),
          sendMessage: createSendMessageTool(app, request),
          sendVoiceNote: createSendVoiceNoteTool(app, request),
        },
        toolChoice: 'auto',
        stopWhen: stepCountIs(12),
      }),
      { maxRetries: 1, label: 'main-agent', logger: app.logger },
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
    const wasCancelled = request.abortSignal?.aborted || isAbortError(error);

    if (!wasCancelled) {
      app.logger.error(
        { err: error, userId: request.userId, chatId: request.chatId },
        'Main agent failed',
      );
    }

    if (!wasCancelled && request.sentMessages.length === 0 && request.allowSending && app.whatsappProvider) {
      try {
        await app.whatsappProvider.sendText({
          chatId: request.chatId,
          text: "sorry, something went wrong on my end 😔 try again in a moment!",
          quotedMessageId: request.messageId,
        });
      } catch (sendErr) {
        app.logger.error({ err: sendErr }, 'Failed to send fallback error message');
      }
    }

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
