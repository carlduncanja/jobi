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
      'Use 1-2 focused web queries to find relevant software and technology jobs.',
      'Fetch and normalize only the strongest 1-2 results before saving them.',
      'Prefer speed and decisiveness over broad exploration.',
      'Rank the saved jobs against the user profile.',
      'Call completeSearch exactly once when you have the final shortlist.',
      'Keep the final shortlist concise and high quality.',
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
    stopWhen: stepCountIs(4),
  });

  const result = await agent.generate({
    abortSignal: AbortSignal.timeout(60_000),
    prompt: input.prompt,
  });

  return (
    runtime.completion ?? {
      summary: result.text || 'No matching jobs were found.',
      queries: runtime.queries,
      jobs: runtime.rankedJobs,
    }
  );
}
