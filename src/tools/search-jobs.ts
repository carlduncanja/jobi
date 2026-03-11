import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import { runJobSearchLoop } from '../ai/job-search-loop-agent';
import type { AppContext, MainAgentRequestContext } from '../lib/app-context';

export function createSearchJobsTool(app: AppContext, request: MainAgentRequestContext) {
  return tool({
    description:
      'Search for relevant jobs for the current user. Use this when the user asks for jobs, openings, listings, or daily search help.',
    inputSchema: zodSchema(
      z.object({
        prompt: z.string().optional(),
      }),
    ),
    execute: async ({ prompt }) => {
      const completion = await runJobSearchLoop(app, {
        userId: request.userId,
        chatId: request.chatId,
        prompt: prompt || request.text,
      });

      return {
        summary: completion.summary,
        queries: completion.queries,
        jobs: completion.jobs.map((item) => ({
          title: item.job.title,
          company: item.job.company,
          location: item.job.location,
          url: item.job.canonicalUrl,
          score: item.score,
          reasons: item.reasons,
        })),
      };
    },
  });
}
