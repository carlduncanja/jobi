import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import type { SearchLoopRuntime } from '../../ai/search-loop-runtime';
import { getJobMatch, saveJobMatch } from '../../db/store';
import type { AppContext } from '../../lib/app-context';
import { rankJobAgainstProfile } from '../../lib/job-ranking';
import { isoNow } from '../../lib/utils';

export function createRankJobsTool(app: AppContext, runtime: SearchLoopRuntime) {
  return tool({
    description: 'Rank saved job candidates against the user profile and persist the resulting matches.',
    inputSchema: zodSchema(
      z.object({
        jobIds: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(10).default(5),
      }),
    ),
    execute: async ({ jobIds, limit }) => {
      if (!runtime.profile) {
        throw new Error('Search profile must be loaded before ranking jobs');
      }

      const jobs = jobIds?.length
        ? runtime.discoveredJobs.filter((job) => jobIds.includes(job.id))
        : runtime.discoveredJobs;

      const ranked = jobs
        .map((job) => rankJobAgainstProfile(runtime.profile!, job))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);

      const now = isoNow();

      for (const item of ranked) {
        const matchId = `${runtime.userId}-${item.job.id}`;
        const existing = await getJobMatch(app.db, matchId);

        await saveJobMatch(app.db, {
          id: matchId,
          userId: runtime.userId,
          jobId: item.job.id,
          score: item.score,
          reasons: item.reasons,
          matchedSkills: item.matchedSkills,
          missingSkills: item.missingSkills,
          status: existing?.status === 'sent' ? 'sent' : existing?.status ?? 'new',
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
      }

      runtime.rankedJobs = ranked;
      return {
        count: ranked.length,
        jobs: ranked.map((item) => ({
          jobId: item.job.id,
          title: item.job.title,
          company: item.job.company,
          score: item.score,
          reasons: item.reasons,
        })),
      };
    },
  });
}
