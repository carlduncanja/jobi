import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import { getNotificationPreference, upsertNotificationPreference } from '../db/store';
import type { AppContext, MainAgentRequestContext } from '../lib/app-context';
import { isoNow } from '../lib/utils';

export function createUnsubscribeNotificationsTool(
  app: AppContext,
  request: MainAgentRequestContext,
) {
  return tool({
    description: 'Unsubscribe the current user from daily job notifications.',
    inputSchema: zodSchema(
      z.object({
        reason: z.string().optional(),
      }),
    ),
    execute: async () => {
      const existing = await getNotificationPreference(app.db, request.userId);

      const preference = await upsertNotificationPreference(app.db, {
        userId: request.userId,
        subscribed: false,
        slotMinute: existing?.slotMinute ?? 0,
        updatedAt: isoNow(),
      });

      return {
        subscribed: preference.subscribed,
      };
    },
  });
}
