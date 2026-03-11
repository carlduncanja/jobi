import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import type { AppContext } from '../../lib/app-context';
import type { SearchLoopRuntime } from '../../ai/search-loop-runtime';

export function createSearchWebTool(app: AppContext, runtime: SearchLoopRuntime) {
  return tool({
    description:
      'Search the web with 1-3 diverse queries in parallel. Returns combined, deduplicated results from all queries. Use varied queries covering different job titles, locations, and keywords for broader coverage.',
    inputSchema: zodSchema(
      z.object({
        queries: z.array(z.string().min(3)).min(1).max(3),
        numResults: z.number().int().min(1).max(8).default(5),
      }),
    ),
    execute: async ({ queries, numResults }) => {
      runtime.queries.push(...queries);

      const allResults = await Promise.all(
        queries.map((query) =>
          app.searchProvider.search({ query, numResults: numResults ?? 5 }),
        ),
      );

      const seen = new Set<string>();
      const deduped = allResults.flat().filter((r) => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });

      return {
        queries,
        resultCount: deduped.length,
        results: deduped.map((r) => ({
          title: r.title,
          url: r.url,
          highlights: r.highlights?.map((h) => h.text) ?? [],
          snippet: r.text?.slice(0, 300),
          publishedAt: r.publishedAt,
        })),
      };
    },
  });
}
