import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
  generateResumeDocxAttachment,
  generateResumePdfAttachment,
  getStoredSearchProfile,
  startLiveHarness,
  type LiveHarness,
} from './helpers/live-harness';

const REQUIRED_ENV_VARS = ['AI_GATEWAY_API_KEY'];

describe('live document resume ingestion', () => {
  let harness: LiveHarness;

  beforeAll(async () => {
    const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

    if (missing.length > 0) {
      throw new Error(`Missing required env vars for live document test: ${missing.join(', ')}`);
    }

    harness = await startLiveHarness();
  }, 60_000);

  afterAll(async () => {
    if (harness) {
      await harness.stop();
    }
  });

  it(
    'ingests a live PDF resume through the real API',
    async () => {
      const attachment = await generateResumePdfAttachment(
        [
          'Priya Patel',
          'Platform Engineer',
          'Summary: Platform engineer building Bun and TypeScript APIs at scale.',
          'Skills: TypeScript, Bun, Kubernetes, APIs',
          'Preferred locations: Remote',
        ].join('\n'),
      );

      const response = await harness.callAgent({
        userId: 'pdf-user',
        chatId: 'pdf-chat',
        text: 'Use your saveResume tool to save this PDF resume and confirm the profile.',
        attachments: [attachment],
      });

      expect(response.status).toBe(200);
      expect(response.body.error).toBeUndefined();

      const profile = await getStoredSearchProfile(harness, 'pdf-user');
      expect(profile).toBeDefined();
      expect(profile?.skills).toContain('TypeScript');
      expect(profile?.skills).toContain('Bun');
      expect(profile?.targetTitles.some((title) => title.toLowerCase().includes('platform'))).toBe(true);
    },
    180_000,
  );

  it(
    'ingests a live DOCX resume through the real API',
    async () => {
      const attachment = await generateResumeDocxAttachment(
        [
          'Devon Brooks',
          'Frontend Engineer',
          'Summary: Frontend engineer building React and TypeScript applications.',
          'Skills: React, TypeScript, Design Systems, Accessibility',
          'Preferred locations: Remote',
        ].join('\n'),
      );

      const response = await harness.callAgent({
        userId: 'docx-user',
        chatId: 'docx-chat',
        text: 'Use your saveResume tool to save this DOCX resume and confirm the profile.',
        attachments: [attachment],
      });

      expect(response.status).toBe(200);
      expect(response.body.error).toBeUndefined();

      const profile = await getStoredSearchProfile(harness, 'docx-user');
      expect(profile).toBeDefined();
      expect(profile?.skills).toContain('React');
      expect(profile?.skills).toContain('TypeScript');
      expect(profile?.targetTitles.some((title) => title.toLowerCase().includes('frontend'))).toBe(true);
    },
    180_000,
  );
});
