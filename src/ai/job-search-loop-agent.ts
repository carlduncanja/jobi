import { ToolLoopAgent, stepCountIs } from 'ai';

import { getSearchAgentModel } from './models';
import type { SearchLoopRuntime } from './search-loop-runtime';
import { createCompleteSearchTool } from '../tools/internal/complete-search';
import { createFetchJobPageTool } from '../tools/internal/fetch-job-page';
import { createGetSearchProfileTool } from '../tools/internal/get-search-profile';
import { createNormalizeJobTool } from '../tools/internal/normalize-job';
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
      'You are a hidden job-search agent that works behind the searchJobs tool.',
      'Always load the search profile first.',
      'Use searchWeb with 2-3 diverse parallel queries to cast a wide net — vary job titles, locations, and keywords.',
      'You can call searchWeb multiple times if the first batch does not return enough results.',
      'Normalize the strongest 3-5 results from the search hits.',
      'Save all normalized jobs, then rank them against the user profile.',
      'Call completeSearch exactly once when you have the final shortlist.',
      'Aim for 5-10 quality job options in the final output.',
    ].join(' '),
    tools: {
      getSearchProfile: createGetSearchProfileTool(app, runtime),
      searchWeb: createSearchWebTool(app, runtime),
      fetchJobPage: createFetchJobPageTool(),
      normalizeJob: createNormalizeJobTool(app),
      saveJobCandidates: createSaveJobCandidatesTool(app, runtime),
      rankJobs: createRankJobsTool(app, runtime),
      completeSearch: createCompleteSearchTool(runtime),
    },
    stopWhen: stepCountIs(10),
  });

  try {
    const result = await retryAsync(
      () => agent.generate({
        abortSignal: AbortSignal.timeout(120_000),
        prompt: input.prompt,
      }),
      { maxRetries: 2, label: 'search-loop', logger: app.logger },
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
