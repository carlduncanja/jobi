import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
  generateResumeImageAttachment,
  getStoredNotificationPreference,
  getStoredSearchProfile,
  runDigestNow,
  startLiveHarness,
  type LiveHarness,
} from './helpers/live-harness';

const REQUIRED_ENV_VARS = ['AI_GATEWAY_API_KEY', 'EXA_API_KEY'];

describe('live end-to-end integration', () => {
  let harness: LiveHarness;

  beforeAll(async () => {
    const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

    if (missing.length > 0) {
      throw new Error(`Missing required env vars for live integration test: ${missing.join(', ')}`);
    }

    harness = await startLiveHarness();
  }, 60_000);

  afterAll(async () => {
    if (harness) {
      await harness.stop();
    }
  });

  it(
    'exercises the real API, AI agents, search, database, and digest flow',
    async () => {
      console.log('STEP: health');
      const health = await harness.requestJson<{ ok: boolean }>('/health');
      expect(health.status).toBe(200);
      expect(health.body.ok).toBe(true);

      console.log('STEP: whatsapp session');
      const session = await harness.requestJson<{ sessionId: string; state: string }>('/api/whatsapp/session');
      expect(session.status).toBe(200);
      expect(session.body.sessionId).toBe('test-session');
      expect(session.body.state).toBe('open');

      console.log('STEP: pairing code');
      const pairing = await harness.requestJson<{ code: string }>('/api/whatsapp/pairing-code', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          phoneNumber: '15551234567',
        }),
      });
      expect(pairing.status).toBe(200);
      expect(pairing.body.code).toContain('4567');

      const resumeText = [
        'Jordan Lee',
        'Backend Engineer',
        'Email: jordan.lee@example.com',
        'Location: Remote',
        'Summary: Backend engineer with 6 years of experience building APIs with TypeScript, Bun, and SurrealDB.',
        'Skills: TypeScript, Bun, SurrealDB, Node.js, APIs',
        'Preferred locations: Remote, United States',
      ].join('\n');

      console.log('STEP: save text resume');
      const saveResume = await harness.callAgent({
        text: 'Use your saveResume tool to save this resume attachment and confirm the extracted profile.',
        attachments: [
          {
            filename: 'resume.txt',
            mimeType: 'text/plain',
            kind: 'text',
            base64: Buffer.from(resumeText).toString('base64'),
          },
        ],
      });
      expect(saveResume.status).toBe(200);
      expect(saveResume.body.error).toBeUndefined();

      const searchProfileAfterText = await getStoredSearchProfile(harness);
      expect(searchProfileAfterText).toBeDefined();
      expect(searchProfileAfterText?.skills).toContain('TypeScript');
      expect(searchProfileAfterText?.targetTitles.length).toBeGreaterThan(0);

      const imageAttachment = await generateResumeImageAttachment(
        [
          'Jordan Lee',
          'Full Stack Engineer',
          'Skills: React, TypeScript, Bun, APIs',
          'Summary: Full stack engineer building web apps and backend services.',
          'Preferred locations: Remote',
        ].join('\n'),
      );

      console.log('STEP: save image resume');
      const saveImageResume = await harness.callAgent({
        text: 'Use your saveResume tool to update my profile from this image resume and confirm what you extracted.',
        attachments: [imageAttachment],
      });
      expect(saveImageResume.status).toBe(200);
      expect(saveImageResume.body.error).toBeUndefined();

      const searchProfileAfterImage = await getStoredSearchProfile(harness);
      expect(searchProfileAfterImage).toBeDefined();
      expect(
        searchProfileAfterImage?.skills.some((skill) => skill.toLowerCase().includes('react')) ||
          searchProfileAfterImage?.summary.toLowerCase().includes('react'),
      ).toBe(true);

      console.log('STEP: search jobs');
      const search = await harness.callAgent({
        text:
          'Use your searchJobs tool to find 2 remote TypeScript backend engineer jobs that match my profile and summarize the strongest matches.',
      });
      expect(search.status).toBe(200);
      expect(search.body.error).toBeUndefined();
      expect(search.body.text).toBeTruthy();

      const [jobs] = await harness.db
        .query<[Array<{ id: unknown }>]>(
          'SELECT id FROM job_postings LIMIT 10',
        )
        .collect();
      const [matches] = await harness.db
        .query<[Array<{ id: unknown }>]>(
          'SELECT id FROM job_matches LIMIT 10',
        )
        .collect();
      expect((jobs ?? []).length).toBeGreaterThan(0);
      expect((matches ?? []).length).toBeGreaterThan(0);

      console.log('STEP: subscribe notifications');
      const subscribe = await harness.callAgent({
        text: 'Use your subscribeNotifications tool to subscribe me to daily job notifications.',
      });
      expect(subscribe.status).toBe(200);
      expect(subscribe.body.error).toBeUndefined();

      const notificationPreference = await getStoredNotificationPreference(harness);
      expect(notificationPreference?.subscribed).toBe(true);

      console.log('STEP: send message');
      const send = await harness.callAgent({
        text: 'Use your sendMessage tool to send exactly this text and nothing else: integration send ok',
        allowSending: true,
      });
      expect(send.status).toBe(200);
      expect(send.body.error).toBeUndefined();
      expect(
        harness.whatsappProvider.sentMessages.some((message) =>
          message.text.toLowerCase().includes('integration send ok'),
        ),
      ).toBe(true);

      const sentMessageCountBeforeDigest = harness.whatsappProvider.sentMessages.length;

      console.log('STEP: run digest');
      await runDigestNow(harness, new Date('2026-03-11T16:59:00.000Z'));

      const [deliveries] = await harness.db
        .query<[Array<{ id: unknown; status: string }>]>(
          'SELECT id, status FROM broadcast_deliveries LIMIT 20',
        )
        .collect();

      expect((deliveries ?? []).length).toBeGreaterThan(0);
      expect(
        harness.whatsappProvider.sentMessages.length,
      ).toBeGreaterThan(sentMessageCountBeforeDigest);
      expect(
        harness.whatsappProvider.sentMessages.some((message) =>
          message.text.includes('Daily Job Bot update:'),
        ),
      ).toBe(true);

      console.log('STEP: unsubscribe notifications');
      const unsubscribe = await harness.callAgent({
        text: 'Use your unsubscribeNotifications tool to unsubscribe me from daily job notifications.',
      });
      expect(unsubscribe.status).toBe(200);
      expect(unsubscribe.body.error).toBeUndefined();

      const unsubscribedPreference = await getStoredNotificationPreference(harness);
      expect(unsubscribedPreference?.subscribed).toBe(false);
    },
    360_000,
  );
});
