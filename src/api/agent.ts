import { ensureUser, listRecentMessages, saveMessage } from '../db/store';
import { mainAgentRequestSchema } from '../lib/schemas';
import type { AppContext, ChatHistoryMessage } from '../lib/app-context';
import { normalizeIncomingAttachments, parseJsonBody } from '../lib/utils';
import { runMainAgent } from '../ai/main-agent';

export async function handleAgentApiRequest(app: AppContext, request: Request): Promise<Response> {
  try {
    const rawBody = await parseJsonBody<unknown>(request);
    const parsed = mainAgentRequestSchema.parse(rawBody);
    const attachments = normalizeIncomingAttachments(parsed.attachments);

    await ensureUser(app.db, {
      userId: parsed.userId,
      chatId: parsed.chatId,
    });

    await saveMessage(app.db, {
      userId: parsed.userId,
      chatId: parsed.chatId,
      direction: 'inbound',
      text: parsed.text,
      attachmentIds: attachments.map((attachment) => attachment.id),
    });

    const recentMessages = await listRecentMessages(app.db, parsed.chatId, 20);
    const history: ChatHistoryMessage[] = recentMessages
      .filter((m) => m.text.trim().length > 0)
      .map((m) => ({
        role: m.direction === 'inbound' ? 'user' as const : 'assistant' as const,
        content: m.text,
      }));

    const result = await runMainAgent(app, {
      sessionId: parsed.sessionId,
      userId: parsed.userId,
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      text: parsed.text,
      attachments,
      allowSending: parsed.allowSending ?? false,
      sentMessages: [],
      history,
    });

    return Response.json(result);
  } catch (error) {
    app.logger.error({ err: error }, 'Agent API request failed');
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      {
        status: 400,
      },
    );
  }
}
