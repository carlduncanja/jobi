import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { startLiveHarness, type LiveHarness } from './helpers/live-harness';

const REQUIRED_ENV_VARS = ['AI_GATEWAY_API_KEY'];

describe('normal message integration', () => {
  let harness: LiveHarness;

  beforeAll(async () => {
    const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

    if (missing.length > 0) {
      throw new Error(`Missing required env vars for normal message test: ${missing.join(', ')}`);
    }

    harness = await startLiveHarness();
  }, 60_000);

  afterAll(async () => {
    if (harness) {
      await harness.stop();
    }
  });

  it(
    'model calls sendMessage for a plain greeting (dry-run)',
    async () => {
      const result = await harness.callAgent({
        text: 'Hey there! What can you do?',
      });

      expect(result.status).toBe(200);
      expect(result.body.error).toBeUndefined();
      expect(result.body.text).toBeTruthy();
      expect(result.body.sentMessageCount).toBe(1);
    },
    120_000,
  );

  it(
    'model calls sendMessage for a plain greeting (live-send)',
    async () => {
      const beforeCount = harness.whatsappProvider.sentMessages.length;

      const result = await harness.callAgent({
        text: 'Hi, just checking in.',
        userId: 'live-chat-user',
        chatId: 'live-chat-room',
        allowSending: true,
      });

      expect(result.status).toBe(200);
      expect(result.body.error).toBeUndefined();
      expect(result.body.text).toBeTruthy();
      expect(result.body.sentMessageCount).toBe(1);

      expect(harness.whatsappProvider.sentMessages.length).toBe(beforeCount + 1);
      const lastSent = harness.whatsappProvider.sentMessages.at(-1)!;
      expect(lastSent.chatId).toBe('live-chat-room');
      expect(lastSent.text).toBe(result.body.text!);
    },
    120_000,
  );
});
