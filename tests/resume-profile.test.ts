import { describe, expect, it } from 'bun:test';

import { buildSearchProfile } from '../src/workflows/resume-ingestion';
import { normalizeIncomingAttachments } from '../src/lib/utils';
import type { ResumeProfile } from '../src/lib/types';

describe('resume profile pipeline helpers', () => {
  it('builds a search profile from parsed resume data', () => {
    const resumeProfile: ResumeProfile = {
      userId: 'user-1',
      fullName: 'Alex Brown',
      email: 'alex@example.com',
      phone: '555-0100',
      location: 'Kingston, Jamaica',
      summary: 'Backend engineer with remote experience.',
      titles: ['Backend Engineer', 'Backend Engineer', 'Software Engineer'],
      skills: ['TypeScript', 'Node.js', 'TypeScript', 'SurrealDB'],
      preferredLocations: ['Remote', 'Jamaica'],
      industries: ['SaaS'],
      seniority: 'mid-senior',
      yearsOfExperience: 6,
      rawText: 'Experienced backend engineer seeking remote work.',
      sourceAttachmentIds: ['attachment:1'],
      updatedAt: new Date().toISOString(),
    };

    const searchProfile = buildSearchProfile(resumeProfile);

    expect(searchProfile.targetTitles).toContain('Backend Engineer');
    expect(searchProfile.relatedTitles).toContain('Platform Engineer');
    expect(searchProfile.skills).toEqual(['TypeScript', 'Node.js', 'SurrealDB']);
    expect(searchProfile.summary).toContain('Target titles');
    expect(searchProfile.remotePreference).toBe('remote-friendly');
  });

  it('normalizes API attachments and detects image kinds', () => {
    const attachments = normalizeIncomingAttachments([
      {
        filename: 'resume.png',
        mimeType: 'image/png',
        base64: Buffer.from('fake-image').toString('base64'),
      },
    ]);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.kind).toBe('image');
    expect(attachments[0]?.filename).toBe('resume.png');
    expect(typeof attachments[0]?.sha256).toBe('string');
  });
});
