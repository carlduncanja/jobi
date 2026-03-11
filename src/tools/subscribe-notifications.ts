import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import { ensureUser, upsertNotificationPreference } from '../db/store';
import type { AppContext, MainAgentRequestContext } from '../lib/app-context';
import { isoNow } from '../lib/utils';
import { computeDeliverySlotMinute } from '../workflows/digest-batching';

export function createSubscribeNotificationsTool(
  app: AppContext,
  request: MainAgentRequestContext,
) {
  return tool({
    description: 'Subscribe the current user to the daily job notification window.',
    inputSchema: zodSchema(
      z.object({
        phoneNumber: z.string().optional(),
      }),
    ),
    execute: async ({ phoneNumber }) => {
      await ensureUser(app.db, {
        userId: request.userId,
        chatId: request.chatId,
        phoneNumber,
      });

      const slotMinute = computeDeliverySlotMinute(
        request.userId,
        app.env.broadcastWindow.durationMinutes,
      );

      const preference = await upsertNotificationPreference(app.db, {
        userId: request.userId,
        subscribed: true,
        slotMinute,
        updatedAt: isoNow(),
      });

      return {
        subscribed: preference.subscribed,
        slotMinute: preference.slotMinute,
        window: '10:00 AM - 12:00 PM EST',
      };
    },
  });
}
