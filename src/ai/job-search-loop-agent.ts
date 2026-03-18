import { ToolLoopAgent, stepCountIs } from 'ai';

import { getSearchAgentModel } from './models';
import type { SearchLoopRuntime } from './search-loop-runtime';
import { createCompleteSearchTool } from '../tools/internal/complete-search';
import { createGetSearchProfileTool } from '../tools/internal/get-search-profile';
import { createRankJobsTool } from '../tools/internal/rank-jobs';
import { createSaveJobCandidatesTool } from '../tools/internal/save-job-candidates';
import { createSearchWebTool } from '../tools/internal/search-web';
import type { AppContext } from '../lib/app-context';
import type { JobSearchCompletion } from '../lib/types';
import { retryAsync } from '../lib/utils';

export async function runJobSearchLoop(
  app: AppContext,
  input: {
    userId: string;
    chatId: string;
    prompt: string;
  },
): Promise<JobSearchCompletion> {
  const runtime: SearchLoopRuntime = {
    userId: input.userId,
    chatId: input.chatId,
    prompt: input.prompt,
    queries: [],
    discoveredJobs: [],
    rankedJobs: [],
  };

  const agent = new ToolLoopAgent({
    model: getSearchAgentModel(app),
    instructions: [
      'You are a fast job-search agent.',
      '1. Load the search profile.',
      `2. searchWeb with 2-3 diverse queries. Always append the current year (${new Date().getFullYear()}) to each query to surface fresh listings (e.g. "nurse jobs Kingston Jamaica ${new Date().getFullYear()}").`,
      '3. From the results, extract title/company/location/summary and saveJobCandidates directly — do NOT fetch individual pages.',
      '4. rankJobs against the profile.',
      '5. completeSearch with the final shortlist.',
      'Be fast. Skip unnecessary steps. Aim for 5-10 results.',
    ].join(' '),
    tools: {
      getSearchProfile: createGetSearchProfileTool(app, runtime),
      searchWeb: createSearchWebTool(app, runtime),
      saveJobCandidates: createSaveJobCandidatesTool(app, runtime),
      rankJobs: createRankJobsTool(app, runtime),
      completeSearch: createCompleteSearchTool(runtime),
    },
    stopWhen: stepCountIs(8),
  });

  try {
    const result = await retryAsync(
      () => agent.generate({
        abortSignal: AbortSignal.timeout(90_000),
        prompt: input.prompt,
      }),
      { maxRetries: 1, label: 'search-loop', logger: app.logger },
    );

    return (
      runtime.completion ?? {
        summary: result.text || 'No matching jobs were found.',
        queries: runtime.queries,
        jobs: runtime.rankedJobs,
      }
    );
  } catch (error) {
    app.logger.error(
      { err: error, userId: input.userId, chatId: input.chatId },
      'Job search loop agent failed',
    );
    throw error;
  }
}
