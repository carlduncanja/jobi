import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import type { AppContext, MainAgentRequestContext } from '../lib/app-context';
import { getLeaderboard, getReferralStats } from '../db/store';

export function createGetReferralStatsTool(app: AppContext, request: MainAgentRequestContext) {
  return tool({
    description:
      'Get the user\'s referral stats and the monthly leaderboard. Use when the user asks how many referrals they have, their rank, or about the leaderboard.',
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      const stats = await getReferralStats(app.db, request.userId);
      const leaderboard = await getLeaderboard(app.db, undefined, 3);

      return {
        myReferrals: stats.count,
        myRank: stats.rank,
        leaderboard: leaderboard.map((entry, i) => ({
          rank: i + 1,
          userId: entry.userId,
          referrals: entry.count,
        })),
      };
    },
  });
}
