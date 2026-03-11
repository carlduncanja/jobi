import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { generateObject, generateText } from 'ai';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

import { getMainAgentModel } from '../ai/models';
import type { AppContext, MainAgentRequestContext } from '../lib/app-context';
import { resumeProfileSchema } from '../lib/schemas';
import type { ResumeDocumentRecord, ResumeProfile, SearchProfile } from '../lib/types';
import { attachmentKindFromMime, isoNow, normalizeWhitespace, safeFilename } from '../lib/utils';
import {
  saveAttachmentRecord,
  saveResumeDocument,
  saveResumeProfile,
  saveSearchProfile,
} from '../db/store';

interface ExtractedAttachment {
  attachmentId: string;
  kind: 'document' | 'image' | 'text' | 'other';
  storagePath: string;
  text: string;
  ocrStatus: 'not-needed' | 'completed' | 'failed';
}

export async function ingestResumeFromRequest(
  app: AppContext,
  request: MainAgentRequestContext,
): Promise<{
  document: ResumeDocumentRecord;
  resumeProfile: ResumeProfile;
  searchProfile: SearchProfile;
}> {
  if (!request.attachments.length) {
    throw new Error('No attachments were provided to saveResume');
  }

  const extracted = await Promise.all(
    request.attachments.map((attachment, index) =>
      persistAndExtractAttachment(app, request, attachment, index),
    ),
  );

  const rawText = normalizeWhitespace(
    extracted
      .map((item, index) => `Attachment ${index + 1}\n${item.text}`)
      .join('\n\n'),
  );

  const structured = await parseResumeText(app, rawText);
  const now = isoNow();
  const sourceKinds = new Set(extracted.map((item) => item.kind));
  const source: 'document' | 'image' | 'mixed' =
    sourceKinds.size === 1 && sourceKinds.has('image')
      ? 'image'
      : sourceKinds.size === 1 && sourceKinds.has('document')
        ? 'document'
        : 'mixed';

  const resumeProfile: ResumeProfile = {
    userId: request.userId,
    fullName: nullableToUndefined(structured.fullName),
    email: nullableToUndefined(structured.email),
    phone: nullableToUndefined(structured.phone),
    location: nullableToUndefined(structured.location),
    summary: nullableToUndefined(structured.summary),
    titles: dedupeStrings(structured.titles),
    skills: dedupeStrings(structured.skills),
    preferredLocations: dedupeStrings(structured.preferredLocations),
    industries: dedupeStrings(structured.industries),
    yearsOfExperience: nullableToUndefined(structured.yearsOfExperience),
    seniority: nullableToUndefined(structured.seniority),
    rawText,
    sourceAttachmentIds: extracted.map((item) => item.attachmentId),
    updatedAt: now,
  };

  const searchProfile = buildSearchProfile(resumeProfile);
  const document: ResumeDocumentRecord = {
    id: `${request.userId}-${Date.now()}`,
    userId: request.userId,
    attachmentIds: extracted.map((item) => item.attachmentId),
    source,
    rawText,
    extractedAt: now,
    updatedAt: now,
  };

  await saveResumeDocument(app.db, document);
  await saveResumeProfile(app.db, resumeProfile);
  await saveSearchProfile(app.db, searchProfile);

  return {
    document,
    resumeProfile,
    searchProfile,
  };
}

export function buildSearchProfile(resumeProfile: ResumeProfile): SearchProfile {
  const targetTitles = dedupeStrings(resumeProfile.titles).slice(0, 5);
  const relatedTitles = dedupeStrings(
    resumeProfile.titles.flatMap((title) => expandTitleVariants(title)),
  ).slice(0, 8);
  const summaryParts = [
    resumeProfile.summary,
    targetTitles.length ? `Target titles: ${targetTitles.join(', ')}` : undefined,
    resumeProfile.skills.length ? `Skills: ${resumeProfile.skills.slice(0, 12).join(', ')}` : undefined,
    resumeProfile.preferredLocations.length
      ? `Preferred locations: ${resumeProfile.preferredLocations.join(', ')}`
      : undefined,
  ].filter(Boolean);

  return {
    userId: resumeProfile.userId,
    summary: summaryParts.join('. '),
    targetTitles,
    relatedTitles,
    skills: dedupeStrings(resumeProfile.skills),
    preferredLocations: dedupeStrings(resumeProfile.preferredLocations),
    remotePreference: inferRemotePreference(resumeProfile.rawText),
    excludedKeywords: [],
    updatedAt: isoNow(),
  };
}

async function persistAndExtractAttachment(
  app: AppContext,
  request: MainAgentRequestContext,
  attachment: MainAgentRequestContext['attachments'][number],
  index: number,
): Promise<ExtractedAttachment> {
  const attachmentDir = join(app.env.dataDir, 'attachments', request.userId);
  await mkdir(attachmentDir, { recursive: true });

  const extension = inferFileExtension(attachment.mimeType, attachment.filename);
  const safeName = safeFilename(
    attachment.filename,
    `${Date.now()}-${index}.${extension}`,
  );
  const storagePath = join(attachmentDir, safeName);

  await writeFile(storagePath, attachment.bytes);

  const extracted = await extractAttachmentText(app, attachment);

  await saveAttachmentRecord(app.db, {
    userId: request.userId,
    chatId: request.chatId,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    storagePath,
    sha256: attachment.sha256 ?? attachment.id,
    textContent: extracted.text,
    ocrStatus: extracted.ocrStatus,
  });

  return {
    attachmentId: attachment.id,
    kind: extracted.kind,
    storagePath,
    text: extracted.text,
    ocrStatus: extracted.ocrStatus,
  };
}

async function extractAttachmentText(
  app: AppContext,
  attachment: MainAgentRequestContext['attachments'][number],
): Promise<Pick<ExtractedAttachment, 'kind' | 'text' | 'ocrStatus'>> {
  const detectedKind = attachment.kind ?? attachmentKindFromMime(attachment.mimeType);

  if (detectedKind === 'text') {
    return {
      kind: 'text',
      text: normalizeWhitespace(Buffer.from(attachment.bytes).toString('utf8')),
      ocrStatus: 'not-needed',
    };
  }

  if (
    detectedKind === 'document' &&
    attachment.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(attachment.bytes) });

    return {
      kind: 'document',
      text: normalizeWhitespace(result.value),
      ocrStatus: 'not-needed',
    };
  }

  if (detectedKind === 'document' && attachment.mimeType === 'application/pdf') {
    const parser = new PDFParse({ data: attachment.bytes });
    const result = await parser.getText();
    await parser.destroy();

    return {
      kind: 'document',
      text: normalizeWhitespace(result.text),
      ocrStatus: 'not-needed',
    };
  }

  if (detectedKind === 'image') {
    const text = await extractImageResumeText(app, attachment.bytes, attachment.mimeType);

    return {
      kind: 'image',
      text: normalizeWhitespace(text),
      ocrStatus: 'completed',
    };
  }

  const fallback = Buffer.from(attachment.bytes).toString('utf8');

  return {
    kind: 'other',
    text: normalizeWhitespace(fallback),
    ocrStatus: 'not-needed',
  };
}

async function extractImageResumeText(
  app: AppContext,
  bytes: Uint8Array,
  mimeType: string,
): Promise<string> {
  const result = await generateText({
    model: getMainAgentModel(app),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Extract all readable text from this resume image. Return plain text only. Preserve section headings when possible and do not add commentary.',
          },
          {
            type: 'image',
            image: bytes,
            mediaType: mimeType,
          },
        ],
      },
    ],
  });

  return result.text;
}

async function parseResumeText(app: AppContext, rawText: string) {
  const result = await generateObject({
    model: getMainAgentModel(app),
    schema: resumeProfileSchema,
    schemaName: 'resume_profile',
    schemaDescription: 'Structured resume profile extracted from a candidate resume.',
    prompt: [
      'Parse the following resume text into structured JSON.',
      'Prefer precision over recall.',
      'Return only skills and titles that are strongly supported by the resume.',
      'Return every key in the schema.',
      'Use null for unknown scalar values and [] for unknown arrays.',
      '',
      rawText,
    ].join('\n'),
  });

  return result.object;
}

function expandTitleVariants(title: string): string[] {
  const normalized = title.toLowerCase();
  const variants = new Set<string>([title]);

  if (normalized.includes('backend')) {
    variants.add('Backend Engineer');
    variants.add('Software Engineer');
    variants.add('Platform Engineer');
  }

  if (normalized.includes('full stack') || normalized.includes('fullstack')) {
    variants.add('Full Stack Engineer');
    variants.add('Software Engineer');
  }

  if (normalized.includes('software')) {
    variants.add('Software Engineer');
  }

  return [...variants];
}

function inferRemotePreference(rawText: string): string | undefined {
  const lower = rawText.toLowerCase();

  if (lower.includes('remote')) {
    return 'remote-friendly';
  }

  if (lower.includes('hybrid')) {
    return 'hybrid';
  }

  return undefined;
}

function inferFileExtension(mimeType: string, filename?: string): string {
  const filenameExtension = filename?.split('.').pop()?.toLowerCase();

  if (filenameExtension) {
    return filenameExtension;
  }

  switch (mimeType) {
    case 'application/pdf':
      return 'pdf';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeWhitespace(value)).filter(Boolean))];
}

function nullableToUndefined<T>(value: T | null): T | undefined {
  return value ?? undefined;
}
