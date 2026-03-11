import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import type { AppContext } from '../../lib/app-context';
import type { SearchLoopRuntime } from '../../ai/search-loop-runtime';

export function createSearchWebTool(app: AppContext, runtime: SearchLoopRuntime) {
  return tool({
    description:
      'Search the public web for job listings. Use focused job-title and location queries. Keep queries diverse but relevant.',
    inputSchema: zodSchema(
      z.object({
        query: z.string().min(3),
        numResults: z.number().int().min(1).max(6).default(4),
      }),
    ),
    execute: async ({ query, numResults }) => {
      runtime.queries.push(query);
      const results = await app.searchProvider.search({
        query,
        numResults,
      });

      return {
        query,
        results,
      };
    },
  });
}
