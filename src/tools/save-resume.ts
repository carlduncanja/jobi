import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import type { AppContext, MainAgentRequestContext } from '../lib/app-context';
import { qualifyReferral } from '../db/store';
import { ingestResumeFromRequest } from '../workflows/resume-ingestion';

export function createSaveResumeTool(app: AppContext, request: MainAgentRequestContext) {
  return tool({
    description:
      'Save resume attachments from the current message, extract text or OCR images, and update the user search profile.',
    inputSchema: zodSchema(
      z.object({
        note: z.string().optional(),
      }),
    ),
    execute: async () => {
      const result = await ingestResumeFromRequest(app, request);

      qualifyReferral(app.db, request.userId).catch((err) =>
        app.logger.error({ err }, 'Failed to qualify referral'),
      );

      return {
        summary: result.searchProfile.summary,
        skills: result.searchProfile.skills,
        targetTitles: result.searchProfile.targetTitles,
        attachmentCount: request.attachments.length,
      };
    },
  });
}
