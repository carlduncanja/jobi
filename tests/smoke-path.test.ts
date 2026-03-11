import { describe, expect, it } from 'bun:test';

import { rankJobAgainstProfile } from '../src/lib/job-ranking';
import type { JobPosting, ResumeProfile } from '../src/lib/types';
import { buildSearchProfile } from '../src/workflows/resume-ingestion';
import { formatDigestMessage } from '../src/workflows/daily-digest';

describe('smoke path', () => {
  it('covers resume to profile to ranked digest output', () => {
    const resumeProfile: ResumeProfile = {
      userId: 'user-1',
      fullName: 'Jordan Lee',
      summary: 'Full stack engineer with strong backend experience.',
      titles: ['Full Stack Engineer'],
      skills: ['TypeScript', 'Bun', 'SurrealDB'],
      preferredLocations: ['Remote'],
      industries: ['Software'],
      rawText: 'Remote full stack engineer with Bun and TypeScript experience.',
      sourceAttachmentIds: ['attachment:resume'],
      updatedAt: new Date().toISOString(),
    };

    const searchProfile = buildSearchProfile(resumeProfile);
    const job: JobPosting = {
      id: 'job-1',
      canonicalUrl: 'https://jobs.example.com/backend-1',
      title: 'Full Stack Engineer',
      company: 'Example Co',
      location: 'Remote',
      summary: 'Build product features with Bun and TypeScript.',
      description: 'We need Bun, TypeScript, and database experience.',
      source: 'web',
      tags: ['TypeScript', 'Bun'],
      updatedAt: new Date().toISOString(),
    };
    const ranked = rankJobAgainstProfile(searchProfile, job);
    const digest = formatDigestMessage({
      summary: 'Found one strong match for today.',
      queries: ['remote full stack engineer Bun'],
      jobs: [ranked],
    });

    expect(ranked.score).toBeGreaterThan(0.6);
    expect(digest).toContain('Daily Job Bot update');
    expect(digest).toContain('Full Stack Engineer at Example Co');
    expect(digest).toContain('https://jobs.example.com/backend-1');
  });
});
