import type { JobPosting, JobSearchCompletion, RankedJob, SearchProfile } from '../lib/types';

export interface SearchLoopRuntime {
  userId: string;
  chatId: string;
  prompt: string;
  profile?: SearchProfile;
  queries: string[];
  discoveredJobs: JobPosting[];
  rankedJobs: RankedJob[];
  completion?: JobSearchCompletion;
}
