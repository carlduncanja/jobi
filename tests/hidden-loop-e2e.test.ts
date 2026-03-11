import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ToolLoopAgent, stepCountIs } from 'ai';

import { getSearchAgentModel } from '../src/ai/models';
import type { SearchLoopRuntime } from '../src/ai/search-loop-runtime';
import { saveSearchProfile } from '../src/db/store';
import type { SearchProvider } from '../src/domain/ports/search-provider';
import { createCompleteSearchTool } from '../src/tools/internal/complete-search';
import { createGetSearchProfileTool } from '../src/tools/internal/get-search-profile';
import { createRankJobsTool } from '../src/tools/internal/rank-jobs';
import { createSaveJobCandidatesTool } from '../src/tools/internal/save-job-candidates';
import { createSearchWebTool } from '../src/tools/internal/search-web';
import { startLiveHarness, type LiveHarness } from './helpers/live-harness';

const REQUIRED_ENV_VARS = ['AI_GATEWAY_API_KEY'];

describe('hidden tool loop integration', () => {
  let harness: LiveHarness;

  beforeAll(async () => {
    const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

    if (missing.length > 0) {
      throw new Error(`Missing required env vars for hidden loop test: ${missing.join(', ')}`);
    }

    harness = await startLiveHarness();
  }, 60_000);

  afterAll(async () => {
    if (harness) {
      await harness.stop();
    }
  });

  it(
    'runs the hidden ToolLoopAgent path directly',
    async () => {
      await saveSearchProfile(harness.db, {
        userId: 'loop-user',
        summary: 'Backend engineer focused on TypeScript, Bun, and APIs.',
        targetTitles: ['Backend Engineer'],
        relatedTitles: ['Software Engineer'],
        skills: ['TypeScript', 'Bun', 'APIs'],
        preferredLocations: ['Remote'],
        remotePreference: 'remote-friendly',
        excludedKeywords: [],
        updatedAt: new Date().toISOString(),
      });

      const originalSearchProvider = harness.app.searchProvider;

      const fakeSearchProvider: SearchProvider = {
        async search() {
          return [
            {
              title: 'Senior Backend Engineer at Example Labs',
              url: 'https://jobs.example.test/backend-engineer',
              text: 'Remote backend role building APIs with TypeScript, Bun, and SurrealDB.',
              publishedAt: new Date().toISOString(),
              highlights: [
                {
                  text: 'Build TypeScript and Bun APIs in a remote backend team.',
                },
              ],
            },
          ];
        },
      };

      harness.app.searchProvider = fakeSearchProvider;

      try {
        const runtime: SearchLoopRuntime = {
          userId: 'loop-user',
          chatId: 'loop-chat',
          prompt:
            'Find one strong remote backend engineer job that matches the current search profile. Use the tools and finish with completeSearch.',
          queries: [],
          discoveredJobs: [],
          rankedJobs: [],
        };

        const agent = new ToolLoopAgent({
          model: getSearchAgentModel(harness.app),
          instructions:
            'You are the hidden job-search loop. Load profile, search, save candidates, rank, then completeSearch.',
          tools: {
            getSearchProfile: createGetSearchProfileTool(harness.app, runtime),
            searchWeb: createSearchWebTool(harness.app, runtime),
            saveJobCandidates: createSaveJobCandidatesTool(harness.app, runtime),
            rankJobs: createRankJobsTool(harness.app, runtime),
            completeSearch: createCompleteSearchTool(runtime),
          },
          prepareStep: ({ stepNumber }) => {
            if (stepNumber === 0) {
              return {
                activeTools: ['getSearchProfile'],
                toolChoice: { type: 'tool', toolName: 'getSearchProfile' },
              };
            }

            if (stepNumber === 1) {
              return {
                activeTools: ['searchWeb'],
                toolChoice: { type: 'tool', toolName: 'searchWeb' },
              };
            }

            if (stepNumber === 2) {
              return {
                activeTools: ['saveJobCandidates'],
                toolChoice: { type: 'tool', toolName: 'saveJobCandidates' },
              };
            }

            if (stepNumber === 3) {
              return {
                activeTools: ['rankJobs'],
                toolChoice: { type: 'tool', toolName: 'rankJobs' },
              };
            }

            return {
              activeTools: ['completeSearch'],
              toolChoice: { type: 'tool', toolName: 'completeSearch' },
            };
          },
          stopWhen: stepCountIs(5),
        });

        await agent.generate({
          prompt: runtime.prompt,
          abortSignal: AbortSignal.timeout(60_000),
        });

        const result = runtime.completion;

        expect(result).toBeDefined();
        expect(result?.jobs.length).toBeGreaterThan(0);
        expect(result?.queries.length).toBeGreaterThan(0);
        expect(result?.summary.length).toBeGreaterThan(0);

        const [jobs] = await harness.db
          .query<[Array<{ id: unknown }>]>(
            'SELECT id FROM job_postings WHERE source = "web" OR source = "exa-fallback" LIMIT 10',
          )
          .collect();
        const [matches] = await harness.db
          .query<[Array<{ id: unknown }>]>(
            'SELECT id FROM job_matches WHERE userId = $userId LIMIT 10',
            { userId: 'loop-user' },
          )
          .collect();

        expect((jobs ?? []).length).toBeGreaterThan(0);
        expect((matches ?? []).length).toBeGreaterThan(0);
        expect(
          result?.jobs.some((job) => job.job.company.toLowerCase().includes('example')),
        ).toBe(true);
      } finally {
        harness.app.searchProvider = originalSearchProvider;
      }
    },
    120_000,
  );
});
