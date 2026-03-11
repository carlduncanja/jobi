import { describe, expect, it } from 'bun:test';

import { rankJobAgainstProfile } from '../src/lib/job-ranking';
import type { JobPosting, SearchProfile } from '../src/lib/types';

const profile: SearchProfile = {
  userId: 'user-1',
  summary: 'Backend engineer focused on TypeScript, Node.js, APIs, and remote roles.',
  targetTitles: ['Backend Engineer'],
  relatedTitles: ['Software Engineer', 'Platform Engineer'],
  skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'APIs'],
  preferredLocations: ['Remote', 'Jamaica'],
  remotePreference: 'remote-friendly',
  excludedKeywords: ['sales'],
  updatedAt: new Date().toISOString(),
};

function createJob(overrides: Partial<JobPosting>): JobPosting {
  return {
    id: 'job-1',
    canonicalUrl: 'https://example.com/jobs/1',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    summary: 'Build APIs with TypeScript and Node.js.',
    description: 'Looking for a Backend Engineer with TypeScript, Node.js, PostgreSQL, and APIs experience.',
    source: 'web',
    tags: ['TypeScript', 'Node.js'],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('job ranking', () => {
  it('scores strong profile matches higher', () => {
    const strong = rankJobAgainstProfile(profile, createJob({}));
    const weak = rankJobAgainstProfile(
      profile,
      createJob({
        id: 'job-2',
        canonicalUrl: 'https://example.com/jobs/2',
        title: 'Sales Associate',
        location: 'Kingston',
        summary: 'Drive outbound sales and partnership growth.',
        description: 'Sales role for outbound partnerships.',
        tags: ['Sales'],
      }),
    );

    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.matchedSkills).toContain('TypeScript');
    expect(weak.reasons).toContain('Contains excluded keywords');
  });

  it('rewards fresh postings with listed compensation', () => {
    const ranked = rankJobAgainstProfile(
      profile,
      createJob({
        salary: '$80k-$100k',
        publishedAt: new Date().toISOString(),
      }),
    );

    expect(ranked.reasons).toContain('Compensation listed');
    expect(ranked.reasons).toContain('Fresh posting');
    expect(ranked.score).toBeGreaterThan(0.8);
  });
});
