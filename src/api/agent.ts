import { ensureUser, saveMessage } from '../db/store';
import { mainAgentRequestSchema } from '../lib/schemas';
import type { AppContext } from '../lib/app-context';
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

    const result = await runMainAgent(app, {
      sessionId: parsed.sessionId,
      userId: parsed.userId,
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      text: parsed.text,
      attachments,
      allowSending: parsed.allowSending ?? false,
      sentMessages: [],
    });

    return Response.json(result);
  } catch (error) {
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
