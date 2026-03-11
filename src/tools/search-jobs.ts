import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import { runJobSearchLoop } from '../ai/job-search-loop-agent';
import type { AppContext, MainAgentRequestContext } from '../lib/app-context';
import {
  findJobPostingByUrl,
  getSearchProfile,
  saveJobMatch,
  saveJobPosting,
} from '../db/store';
import { rankJobAgainstProfile } from '../lib/job-ranking';
import type { JobPosting, JobSearchCompletion, SearchProfile } from '../lib/types';
import { canonicalizeUrl, isoNow, sha256Text, truncate } from '../lib/utils';

export function createSearchJobsTool(app: AppContext, request: MainAgentRequestContext) {
  return tool({
    description:
      'Search for relevant jobs for the current user. Use this when the user asks for jobs, openings, listings, or daily search help.',
    inputSchema: zodSchema(
      z.object({
        prompt: z.string().optional(),
      }),
    ),
    execute: async ({ prompt }) => {
      const searchPrompt = prompt || request.text;
      const completion = await runSearchJobsWithFallback(app, {
        userId: request.userId,
        chatId: request.chatId,
        prompt: searchPrompt,
      });

      return {
        summary: completion.summary,
        queries: completion.queries,
        jobs: completion.jobs.map((item) => ({
          title: item.job.title,
          company: item.job.company,
          location: item.job.location,
          url: item.job.canonicalUrl,
          score: item.score,
          reasons: item.reasons,
        })),
      };
    },
  });
}

async function runSearchJobsWithFallback(
  app: AppContext,
  input: {
    userId: string;
    chatId: string;
    prompt: string;
  },
): Promise<JobSearchCompletion> {
  const loopPromise = runJobSearchLoop(app, input);

  try {
    return await Promise.race([
      loopPromise,
      Bun.sleep(20_000).then(() => {
        throw new Error('Hidden search loop timed out');
      }),
    ]);
  } catch (error) {
    void loopPromise.catch(() => undefined);
    app.logger.warn({ error }, 'Hidden search loop failed, using raw search fallback');
    return await runRawSearchFallback(app, input.userId, input.prompt);
  }
}

async function runRawSearchFallback(
  app: AppContext,
  userId: string,
  prompt: string,
): Promise<JobSearchCompletion> {
  const profile = await getSearchProfile(app.db, userId);

  const query = profile
    ? [
        profile.targetTitles[0],
        profile.skills.slice(0, 3).join(' '),
        profile.preferredLocations[0] ?? 'remote',
        'jobs',
      ]
        .filter(Boolean)
        .join(' ')
    : `${prompt} jobs`;

  const results = await app.searchProvider.search({ query, numResults: 4 });
  const rankingProfile: SearchProfile = profile ?? {
    userId,
    summary: prompt,
    targetTitles: [],
    relatedTitles: [],
    skills: [],
    preferredLocations: [],
    excludedKeywords: [],
    updatedAt: isoNow(),
  };

  const rankedJobs = [];

  for (const result of results.slice(0, 4)) {
    const canonicalUrl = canonicalizeUrl(result.url);
    const existing = await findJobPostingByUrl(app.db, canonicalUrl);
    const posting: JobPosting = {
      id: existing?.id ?? sha256Text(canonicalUrl),
      canonicalUrl,
      title: result.title,
      company: 'Unknown',
      location: 'Unknown',
      summary: truncate(
        result.highlights?.map((h) => h.text).join(' ') || result.text || result.title,
        500,
      ),
      description: result.text,
      source: 'exa-fallback',
      publishedAt: result.publishedAt,
      tags: [],
      updatedAt: isoNow(),
    };

    const savedPosting = await saveJobPosting(app.db, posting);
    const ranked = rankJobAgainstProfile(rankingProfile, savedPosting);

    await saveJobMatch(app.db, {
      id: `${userId}-${savedPosting.id}`,
      userId,
      jobId: savedPosting.id,
      score: ranked.score,
      reasons: ranked.reasons,
      matchedSkills: ranked.matchedSkills,
      missingSkills: ranked.missingSkills,
      status: 'new',
      createdAt: isoNow(),
      updatedAt: isoNow(),
    });

    rankedJobs.push(ranked);
  }

  rankedJobs.sort((a, b) => b.score - a.score);

  return {
    summary:
      rankedJobs.length > 0
        ? `Found ${rankedJobs.length} jobs from a direct search.`
        : 'No matching jobs were found.',
    queries: [query],
    jobs: rankedJobs,
  };
}
