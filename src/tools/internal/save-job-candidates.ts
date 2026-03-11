import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import type { SearchLoopRuntime } from '../../ai/search-loop-runtime';
import { findJobPostingByUrl, saveJobPosting } from '../../db/store';
import type { AppContext } from '../../lib/app-context';
import type { JobPosting } from '../../lib/types';
import { canonicalizeUrl, isoNow, sha256Text } from '../../lib/utils';

export function createSaveJobCandidatesTool(app: AppContext, runtime: SearchLoopRuntime) {
  return tool({
    description: 'Save job candidates from search results. Pass the raw search hits — title, url, company, location, and a short summary extracted from highlights or snippets.',
    inputSchema: zodSchema(
      z.object({
        jobs: z.array(
          z.object({
            url: z.string().url(),
            title: z.string(),
            company: z.string().default('Unknown'),
            location: z.string().default('Unknown'),
            remoteType: z.string().optional(),
            salary: z.string().optional(),
            summary: z.string(),
            source: z.string().default('web'),
            publishedAt: z.string().optional(),
            tags: z.array(z.string()).default([]),
          }),
        ),
      }),
    ),
    execute: async ({ jobs }) => {
      const saved: JobPosting[] = [];

      for (const job of jobs) {
        const canonicalUrl = canonicalizeUrl(job.url);
        const existing = await findJobPostingByUrl(app.db, canonicalUrl);
        const posting: JobPosting = {
          id: existing?.id ?? sha256Text(canonicalUrl),
          canonicalUrl,
          title: job.title,
          company: job.company,
          location: job.location,
          remoteType: job.remoteType,
          employmentType: undefined,
          salary: job.salary,
          summary: job.summary,
          description: undefined,
          source: job.source,
          publishedAt: job.publishedAt,
          tags: job.tags,
          updatedAt: isoNow(),
        };

        const persisted = await saveJobPosting(app.db, posting);
        saved.push(persisted);
      }

      runtime.discoveredJobs = dedupeJobs([...runtime.discoveredJobs, ...saved]);
      return {
        count: saved.length,
        jobIds: saved.map((job) => job.id),
      };
    },
  });
}

function dedupeJobs(jobs: JobPosting[]): JobPosting[] {
  const map = new Map<string, JobPosting>();
  for (const job of jobs) {
    map.set(job.id, job);
  }
  return [...map.values()];
}
