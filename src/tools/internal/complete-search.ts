import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import type { SearchLoopRuntime } from '../../ai/search-loop-runtime';

export function createCompleteSearchTool(runtime: SearchLoopRuntime) {
  return tool({
    description:
      'Finalize the hidden job-search run after ranking the best jobs. Call this once when you have the final shortlist.',
    inputSchema: zodSchema(
      z.object({
        summary: z.string(),
        limit: z.number().int().min(1).max(10).default(5),
      }),
    ),
    execute: async ({ summary, limit }) => {
      runtime.completion = {
        summary,
        queries: [...runtime.queries],
        jobs: runtime.rankedJobs.slice(0, limit),
      };

      return runtime.completion;
    },
  });
}
