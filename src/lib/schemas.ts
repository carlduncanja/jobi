import { z } from 'zod/v4';

export const resumeProfileSchema = z.object({
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  summary: z.string().nullable(),
  titles: z.array(z.string()),
  skills: z.array(z.string()),
  preferredLocations: z.array(z.string()),
  industries: z.array(z.string()),
  yearsOfExperience: z.number().nullable(),
  seniority: z.string().nullable(),
});

export const searchProfileSchema = z.object({
  summary: z.string(),
  targetTitles: z.array(z.string()).default([]),
  relatedTitles: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  preferredLocations: z.array(z.string()).default([]),
  remotePreference: z.string().optional(),
  excludedKeywords: z.array(z.string()).default([]),
});

export const normalizedJobSchema = z.object({
  title: z.string(),
  company: z.string(),
  location: z.string(),
  remoteType: z.string().nullable(),
  employmentType: z.string().nullable(),
  salary: z.string().nullable(),
  summary: z.string(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
});

export const rankedJobSchema = z.object({
  jobId: z.string(),
  score: z.number().min(0).max(1),
  reasons: z.array(z.string()).default([]),
  matchedSkills: z.array(z.string()).default([]),
  missingSkills: z.array(z.string()).default([]),
});

export const mainAgentRequestSchema = z.object({
  sessionId: z.string(),
  chatId: z.string(),
  userId: z.string(),
  messageId: z.string().optional(),
  text: z.string().default(''),
  attachments: z
    .array(
      z.object({
        filename: z.string().optional(),
        mimeType: z.string(),
        kind: z
          .enum(['document', 'image', 'text', 'audio', 'video', 'other'])
          .optional(),
        base64: z.string(),
        caption: z.string().optional(),
      }),
    )
    .optional(),
  allowSending: z.boolean().optional(),
});

export type ResumeProfileExtraction = z.infer<typeof resumeProfileSchema>;
export type SearchProfileExtraction = z.infer<typeof searchProfileSchema>;
export type NormalizedJobExtraction = z.infer<typeof normalizedJobSchema>;
export type RankedJobExtraction = z.infer<typeof rankedJobSchema>;
