import { startLiveHarness } from './live-harness';
import { ingestResumeFromRequest } from '../../src/workflows/resume-ingestion';
import { normalizeIncomingAttachments } from '../../src/lib/utils';

const harness = await startLiveHarness();

try {
  const resumeText = [
    'Jordan Lee',
    'Backend Engineer',
    'Email: jordan.lee@example.com',
    'Location: Remote',
    'Summary: Backend engineer with 6 years of experience building APIs with TypeScript, Bun, and SurrealDB.',
    'Skills: TypeScript, Bun, SurrealDB, Node.js, APIs',
    'Preferred locations: Remote, United States',
  ].join('\n');

  const attachments = normalizeIncomingAttachments([
    {
      filename: 'resume.txt',
      mimeType: 'text/plain',
      kind: 'text',
      base64: Buffer.from(resumeText).toString('base64'),
    },
  ]);

  try {
    const workflowResult = await ingestResumeFromRequest(harness.app, {
      sessionId: 'test-session',
      userId: 'integration-user',
      chatId: 'integration-chat',
      text: 'save this resume',
      attachments,
      allowSending: false,
      sentMessages: [],
    });

    console.log('WORKFLOW_OK');
    console.log(JSON.stringify(workflowResult, null, 2));
  } catch (error) {
    console.log('WORKFLOW_ERROR');
    console.log(error);
  }

  const result = await harness.callAgent({
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

  console.log('AGENT_RESULT');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await harness.stop();
}
