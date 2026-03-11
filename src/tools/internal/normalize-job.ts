import { tool, zodSchema } from 'ai';
import { generateObject } from 'ai';
import { z } from 'zod/v4';

import { getSearchAgentModel } from '../../ai/models';
import type { AppContext } from '../../lib/app-context';
import { normalizedJobSchema } from '../../lib/schemas';

export function createNormalizeJobTool(app: AppContext) {
  return tool({
    description:
      'Normalize a raw search hit or fetched page into canonical job fields such as title, company, location, summary, and tags.',
    inputSchema: zodSchema(
      z.object({
        url: z.string().url(),
        title: z.string(),
        snippet: z.string().optional(),
        pageText: z.string().optional(),
        publishedAt: z.string().optional(),
      }),
    ),
    execute: async ({ url, title, snippet, pageText, publishedAt }) => {
      const result = await generateObject({
        model: getSearchAgentModel(app),
        schema: normalizedJobSchema,
        schemaName: 'normalized_job',
        prompt: [
          'Normalize this job listing into structured fields.',
          'Use the provided data only and do not invent facts.',
          'Return every key in the schema.',
          'Use null for unknown optional-like text fields and [] for unknown arrays.',
          '',
          `URL: ${url}`,
          `Title: ${title}`,
          snippet ? `Snippet: ${snippet}` : '',
          pageText ? `Page text:\n${pageText}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      });

      return {
        ...sanitizeNormalizedJob(result.object),
        publishedAt,
      };
    },
  });
}

function sanitizeNormalizedJob(job: {
  title: string;
  company: string;
  location: string;
  remoteType: string | null;
  employmentType: string | null;
  salary: string | null;
  summary: string;
  description: string | null;
  tags: string[];
}) {
  return {
    title: job.title,
    company: job.company || 'Unknown',
    location: job.location || 'Unknown',
    remoteType: job.remoteType ?? undefined,
    employmentType: job.employmentType ?? undefined,
    salary: job.salary ?? undefined,
    summary: job.summary,
    description: job.description ?? undefined,
    tags: job.tags,
  };
}
