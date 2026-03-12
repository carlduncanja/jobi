import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import type { AppContext, MainAgentRequestContext } from '../lib/app-context';
import { getOrCreateReferralCode, getReferralStats } from '../db/store';

const JOBI_PHONE = '18762217136';

export function createGetReferralLinkTool(app: AppContext, request: MainAgentRequestContext) {
  return tool({
    description:
      'Get the user\'s unique referral link and current month referral count. Use when the user asks for their referral link, wants to share Jobi, or asks about the referral program.',
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      const displayName = await getDisplayName(app, request.userId);
      const code = await getOrCreateReferralCode(app.db, request.userId, displayName);
      const stats = await getReferralStats(app.db, request.userId);

      const link = `https://wa.me/${JOBI_PHONE}?text=REF-${code}`;

      return {
        code: `REF-${code}`,
        link,
        referralCount: stats.count,
        rank: stats.rank,
      };
    },
  });
}

async function getDisplayName(app: AppContext, userId: string): Promise<string | undefined> {
  try {
    const [rows] = await app.db
      .query<[Array<{ fullName?: string }>]>(
        'SELECT fullName FROM resume_profiles WHERE userId = $userId LIMIT 1',
        { userId },
      )
      .collect();
    return rows?.[0]?.fullName ?? undefined;
  } catch {
    return undefined;
  }
}
