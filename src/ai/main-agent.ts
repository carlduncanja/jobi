import { generateText, stepCountIs, type ModelMessage } from 'ai';

import { getMainAgentModel } from './models';
import type { AppContext, MainAgentRequestContext } from '../lib/app-context';
import { createSaveResumeTool } from '../tools/save-resume';
import { createSearchJobsTool } from '../tools/search-jobs';
import { createSendMessageTool } from '../tools/send-message';
import { createSubscribeNotificationsTool } from '../tools/subscribe-notifications';
import { createUnsubscribeNotificationsTool } from '../tools/unsubscribe-notifications';

export interface MainAgentResponse {
  text: string;
  sentMessageCount: number;
}

const SYSTEM_PROMPT = `You are Job Bot, a WhatsApp assistant that helps users find jobs, manage their resume, and control daily job notifications.

You have five tools. Every response to the user MUST go through the sendMessage tool — that is the only way you can talk to the user on WhatsApp.

TOOLS:
- searchJobs: Search for job listings matching the user's profile or a specific query.
- saveResume: Save or update the user's resume from attached files (PDF, DOCX, images, or plain text).
- subscribeNotifications: Subscribe the user to daily job notification digests.
- unsubscribeNotifications: Unsubscribe the user from daily job notification digests.
- sendMessage: Send a WhatsApp message to the user. This is the ONLY way to reply. You MUST call this tool exactly once as your final action in every turn.

RULES:
1. ALWAYS call sendMessage exactly once as your last tool call. Never skip it. Never call it more than once.
2. If the user sends a resume or document attachment, call saveResume first, then sendMessage to confirm what you extracted.
3. If the user asks for jobs, openings, or listings, call searchJobs first, then sendMessage with the results.
4. If the user wants to subscribe or unsubscribe from notifications, call the appropriate tool first, then sendMessage to confirm.
5. If the user sends a normal conversational message (greeting, question, etc.), just call sendMessage with your reply.
6. Do not invent job details. Only report what tools return.
7. Keep replies concise and helpful.
8. You have access to the conversation history. Use it to maintain context across messages — remember what the user told you, what jobs you found, and what actions you took.`;

export async function runMainAgent(
  app: AppContext,
  request: MainAgentRequestContext,
): Promise<MainAgentResponse> {
  try {
    const result = await generateText({
      model: getMainAgentModel(app),
      system: SYSTEM_PROMPT,
      messages: buildMessages(request),
      tools: {
        searchJobs: createSearchJobsTool(app, request),
        saveResume: createSaveResumeTool(app, request),
        subscribeNotifications: createSubscribeNotificationsTool(app, request),
        unsubscribeNotifications: createUnsubscribeNotificationsTool(app, request),
        sendMessage: createSendMessageTool(app, request),
      },
      toolChoice: 'auto',
      stopWhen: stepCountIs(6),
    });

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

  // Exclude the last history entry if it matches the current message to avoid duplication
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
