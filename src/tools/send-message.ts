import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import { saveMessage } from '../db/store';
import type { AppContext, MainAgentRequestContext } from '../lib/app-context';

export function createSendMessageTool(app: AppContext, request: MainAgentRequestContext) {
  return tool({
    description:
      'Send a reply back to the current WhatsApp chat. This is the ONLY way to talk to the user. Call this exactly once as your final action.',
    inputSchema: zodSchema(
      z.object({
        text: z.string().min(1),
      }),
    ),
    execute: async ({ text }) => {
      if (!request.allowSending || !app.whatsappProvider) {
        request.sentMessages.push({ text });
        return { delivered: false };
      }

      const result = await app.whatsappProvider.sendText({
        chatId: request.chatId,
        text,
        quotedMessageId: request.messageId,
      });

      app.logger.info(
        { userId: request.userId, chatId: request.chatId, textLength: text.length },
        'Outgoing WhatsApp message sent',
      );

      await saveMessage(app.db, {
        userId: request.userId,
        chatId: request.chatId,
        direction: 'outbound',
        text,
        attachmentIds: [],
      });

      request.sentMessages.push({
        text,
        providerMessageId: result.providerMessageId,
      });

      return { delivered: true, providerMessageId: result.providerMessageId };
    },
  });
}
