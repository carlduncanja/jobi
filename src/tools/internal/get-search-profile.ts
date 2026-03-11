import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import type { AppContext } from '../../lib/app-context';
import type { SearchLoopRuntime } from '../../ai/search-loop-runtime';
import { getSearchProfile } from '../../db/store';

export function createGetSearchProfileTool(app: AppContext, runtime: SearchLoopRuntime) {
  return tool({
    description:
      'Load the user search profile built from their resume and preferences. Always call this before searching jobs.',
    inputSchema: zodSchema(
      z.object({
        note: z.string().optional(),
      }),
    ),
    execute: async () => {
      const profile =
        (await getSearchProfile(app.db, runtime.userId)) ?? {
          userId: runtime.userId,
          summary: runtime.prompt,
          targetTitles: [],
          relatedTitles: [],
          skills: [],
          preferredLocations: [],
          remotePreference: undefined,
          excludedKeywords: [],
          updatedAt: new Date().toISOString(),
        };

      runtime.profile = profile;
      return profile;
    },
  });
}
