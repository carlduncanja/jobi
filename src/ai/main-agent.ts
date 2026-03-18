import { generateText, stepCountIs, type ModelMessage } from 'ai';

import { getMainAgentModel } from './models';
import type { AppContext, MainAgentRequestContext } from '../lib/app-context';
import { createGetReferralLinkTool } from '../tools/get-referral-link';
import { createGetReferralStatsTool } from '../tools/get-referral-stats';
import { createPaymentLinkTool } from '../tools/create-payment-link';
import { createSaveResumeTool } from '../tools/save-resume';
import { createSearchJobsTool } from '../tools/search-jobs';
import { createSendMessageTool } from '../tools/send-message';
import { createSendResumePdfTool } from '../tools/send-resume-pdf';
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
- createPaymentLink: create a Stripe checkout link for a paid product and send it to the user
- sendResumePdf: generate a clean PDF resume from their saved profile and send it via WhatsApp
- sendMessage: send a text message
- sendVoiceNote: send a voice note (spoken audio)

VOICE vs TEXT — mix them naturally like a real person would on WhatsApp:
- Use sendVoiceNote for: greetings, short reactions, encouragement, casual back-and-forth ("nice!", "let me check that for you", "good luck with the application!")
- Use sendMessage for: job listings, links, anything with structured info, anything the user needs to read or copy
- When the user sends a voice note, always reply with a voice note first, then text if you have info to share
- Don't send a voice note every single turn — maybe 1 in every 3-4 messages. Keep it feeling natural, not robotic
- Keep voice notes SHORT — 1-2 sentences max. They're for warmth, not information dumps

BEFORE SEARCHING:
- Location ambiguous (e.g. "Kingston")? Ask which one before searching.
- "near me" or "around here"? Ask where they are — you don't have GPS.
- Query too vague (just "jobs")? Ask what kind of work.

FLOWS:

Job search:
1. sendVoiceNote("on it, let me search for that") — OR sendMessage("on it 🔍") — pick one naturally
2. searchJobs(...)
3. Send results as text in small batches (2-3 jobs per message). Title, company, location, link.

No jobs found:
1. sendVoiceNote("nothing came up for [role] right now, market might be slow")
2. sendMessage("want me to set up an alert so you hear when something shows up?")
3. If yes → subscribeNotifications() → sendMessage("done, i'll hit you up 🔔")

Resume received:
1. sendMessage("got it, looking at your resume...")
2. saveResume(...)
3. sendVoiceNote with a warm reaction + sendMessage with the summary
4. ALWAYS follow up with the upsell pitch (see RESUME UPSELL below)

Resume upsell (after every resume save):
1. sendMessage("your resume looks good but i noticed a few things that could hurt your chances — want me to send you a full review with fixes? it's $500 JMD")
2. If yes → createPaymentLink({ product: "resume_review" })
   - If result has alreadyPaid: true → sendMessage("you already paid for this — let me send your review now") then sendResumePdf({ reviewNotes: "..." })
   - If result has error "no_resume" → sendMessage("send me your resume first and i'll get that sorted")
   - Otherwise → sendMessage with the checkout link
3. After payment confirmed (user says they paid or you see confirmation) → sendResumePdf({ reviewNotes: "..." }) with a 2-3 sentence review note

PDF resume request (user asks for their resume as PDF):
1. sendResumePdf()
   - If result has error "not_paid" → sendMessage("the PDF is part of the full review — it's $500 JMD. want me to send you the payment link?")
   - If yes → createPaymentLink({ product: "resume_review" }) → sendMessage with the checkout link

Incoming voice note:
1. transcribeAudio(...)
2. sendVoiceNote(...) — reply in kind, keep it short and natural
3. Then handle what they asked (search, etc.) with text if needed

Referral link:
1. getReferralLink()
2. sendMessage with their link + count

Ad click ("Hello! Can I get more info on this?" or similar):
- sendVoiceNote("hey! i'm Jobi, your WhatsApp job assistant. i help you find jobs right here in the chat. what kind of work are you looking for?")

REFERRAL PROGRAM:
- Top referrer each month wins $10,000 JMD.
- Referral counts when someone joins through their link AND searches or sends a resume.
- Mention it once after helping: "btw you can win $10k JMD just for sharing me — say 'my link' to get yours"
- Don't repeat it every turn.

RULES:
1. Every turn must have at least one sendMessage or sendVoiceNote.
2. Never make up job details. Only use what tools return.
3. Never say "I found some jobs" if the jobs array is empty.
4. Remember context from the conversation — don't ask for info they already gave you.`;

const AGENT_TIMEOUT_MS = 90_000; // 90 seconds — search loop is capped at 55s so this gives headroom

export async function runMainAgent(
  app: AppContext,
  request: MainAgentRequestContext,
): Promise<MainAgentResponse> {
  try {
    const abortSignal = AbortSignal.timeout(AGENT_TIMEOUT_MS);

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
          createPaymentLink: createPaymentLinkTool(app, request),
          sendResumePdf: createSendResumePdfTool(app, request),
          sendMessage: createSendMessageTool(app, request),
          sendVoiceNote: createSendVoiceNoteTool(app, request),
        },
        toolChoice: 'auto',
        stopWhen: stepCountIs(15),
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
    app.logger.error(
      { err: error, userId: request.userId, chatId: request.chatId },
      'Main agent failed',
    );

    if (request.sentMessages.length === 0 && request.allowSending && app.whatsappProvider) {
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
