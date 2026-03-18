import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { tool, zodSchema } from 'ai';
import { z } from 'zod/v4';

import type { AppContext, MainAgentRequestContext } from '../lib/app-context';
import { getResumeProfile, hasPaidForProduct } from '../db/store';

// ── Page geometry ────────────────────────────────────────────────────────────
const W = 595;          // A4 width  (pt)
const H = 842;          // A4 height (pt)
const ML = 48;          // left margin
const MR = 48;          // right margin
const BODY_W = W - ML - MR;
const FOOTER_H = 28;
const HEADER_H = 110;   // solid colour header band

// ── Palette ──────────────────────────────────────────────────────────────────
const INK       = rgb(0.10, 0.10, 0.10);
const INK_LIGHT = rgb(0.38, 0.38, 0.38);
const WHITE     = rgb(1, 1, 1);
const NAVY      = rgb(0.09, 0.18, 0.34);   // header bg
const TEAL      = rgb(0.07, 0.60, 0.56);   // accent / section rule
const RULE      = rgb(0.88, 0.88, 0.88);   // thin dividers
const TAG_BG    = rgb(0.93, 0.97, 0.96);   // skill pill background
const TAG_BORDER= rgb(0.07, 0.60, 0.56);
const REVIEW_BG = rgb(0.95, 0.99, 0.97);

export function createSendResumePdfTool(app: AppContext, request: MainAgentRequestContext) {
  return tool({
    description:
      "Generate a clean, formatted PDF resume from the user's saved resume profile and send it to them on WhatsApp. " +
      'Use this after the user has paid for the resume review or explicitly asks for their resume as a PDF.',
    inputSchema: zodSchema(
      z.object({
        reviewNotes: z
          .string()
          .optional()
          .describe(
            'Optional short review notes to include at the top of the PDF (e.g. "Strengthened summary, added missing skills section")',
          ),
      }),
    ),
    execute: async ({ reviewNotes }) => {
      if (!request.allowSending || !app.whatsappProvider) {
        return { error: 'sending not allowed' };
      }

      const paid = await hasPaidForProduct(app.db, request.userId, 'resume_review');
      if (!paid) {
        return { error: 'not_paid', message: 'user has not paid for the resume review yet' };
      }

      const profile = await getResumeProfile(app.db, request.userId);
      if (!profile) {
        return { error: 'no resume on file — ask the user to send their resume first' };
      }

      const pdfBytes = await buildResumePdf(profile, reviewNotes);

      const filename = profile.fullName
        ? `${profile.fullName.replace(/\s+/g, '_')}_Resume.pdf`
        : 'Resume.pdf';

      const result = await app.whatsappProvider.sendDocument({
        chatId: request.chatId,
        documentBytes: pdfBytes,
        mimeType: 'application/pdf',
        filename,
        caption: reviewNotes ? "here's your updated resume" : "here's your resume as a PDF",
      });

      app.logger.info(
        { userId: request.userId, chatId: request.chatId, filename },
        'Resume PDF sent',
      );

      return { delivered: result.delivered, filename };
    },
  });
}

interface ResumeProfileLike {
  fullName?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  titles: string[];
  skills: string[];
  preferredLocations: string[];
  industries: string[];
  yearsOfExperience?: number;
  seniority?: string;
  rawText: string;
}

// ── Text helpers ─────────────────────────────────────────────────────────────

function wrapWords(
  text: string,
  font: Awaited<ReturnType<PDFDocument['embedFont']>>,
  maxWidth: number,
  fontSize: number,
): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(test, fontSize) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── Main builder ─────────────────────────────────────────────────────────────

async function buildResumePdf(
  profile: ResumeProfileLike,
  reviewNotes?: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(profile.fullName ?? 'Resume');
  doc.setAuthor('Jobi');

  const page = doc.addPage([W, H]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg  = await doc.embedFont(StandardFonts.Helvetica);
  const obl  = await doc.embedFont(StandardFonts.HelveticaOblique);

  // cursor — moves downward
  let y = H;

  // ── Solid navy header band ──────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: H - HEADER_H, width: W, height: HEADER_H, color: NAVY });

  // left accent bar inside header
  page.drawRectangle({ x: 0, y: H - HEADER_H, width: 5, height: HEADER_H, color: TEAL });

  y = H - 26;

  // Name
  const name = profile.fullName ?? 'Resume';
  page.drawText(name, { x: ML, y, size: 26, font: bold, color: WHITE });
  y -= 32;

  // Job title
  if (profile.titles.length > 0) {
    page.drawText(profile.titles[0].toUpperCase(), {
      x: ML, y, size: 9, font: bold,
      color: rgb(0.55, 0.85, 0.80),
    });
    y -= 16;
  }

  // Contact line — right-aligned inside header
  const contactParts: string[] = [];
  if (profile.phone)    contactParts.push(profile.phone);
  if (profile.email)    contactParts.push(profile.email);
  if (profile.location) contactParts.push(profile.location);

  if (contactParts.length > 0) {
    const contactStr = contactParts.join('   |   ');
    const cw = reg.widthOfTextAtSize(contactStr, 8.5);
    page.drawText(contactStr, {
      x: W - MR - cw, y,
      size: 8.5, font: reg, color: rgb(0.78, 0.85, 0.90),
    });
  }

  // ── Jobi review banner (paid review notes) ──────────────────────────────────
  y = H - HEADER_H;
  if (reviewNotes) {
    const bannerH = 22;
    page.drawRectangle({ x: 0, y: y - bannerH, width: W, height: bannerH, color: REVIEW_BG });
    page.drawLine({
      start: { x: 0, y: y - bannerH }, end: { x: W, y: y - bannerH },
      thickness: 0.5, color: TAG_BORDER,
    });
    const noteLines = wrapWords(`Jobi Review: ${reviewNotes}`, reg, BODY_W - 12, 7.5);
    page.drawText(noteLines[0] ?? '', {
      x: ML, y: y - 14,
      size: 7.5, font: obl, color: TEAL,
    });
    y -= bannerH;
  }

  // ── Body starts here ────────────────────────────────────────────────────────
  y -= 22; // top padding below header

  const sectionGap  = 18;
  const lineHeight  = 14;
  const smallLine   = 12.5;
  const bodyBottom  = FOOTER_H + 16;

  const drawSectionHeader = (title: string) => {
    if (y < bodyBottom + 40) return;
    y -= sectionGap;
    page.drawText(title.toUpperCase(), {
      x: ML, y,
      size: 8, font: bold, color: TEAL,
    });
    y -= 6;
    page.drawLine({
      start: { x: ML, y }, end: { x: W - MR, y },
      thickness: 0.75, color: TEAL,
    });
    y -= 10;
  };

  const drawBodyText = (text: string, size = 9.5, font = reg, color = INK, indent = 0) => {
    if (y < bodyBottom) return;
    const lines = wrapWords(text, font, BODY_W - indent, size);
    for (const line of lines) {
      if (y < bodyBottom) break;
      page.drawText(line, { x: ML + indent, y, size, font, color });
      y -= size + 3.5;
    }
  };

  // ── Professional Summary ────────────────────────────────────────────────────
  if (profile.summary) {
    drawSectionHeader('Professional Summary');
    drawBodyText(profile.summary, 9.5, reg, INK_LIGHT);
  }

  // ── Skills ──────────────────────────────────────────────────────────────────
  if (profile.skills.length > 0) {
    drawSectionHeader('Core Skills');

    // Render skills as pill tags, wrapping across rows
    const TAG_FONT_SIZE = 8.5;
    const TAG_PAD_X = 8;
    const TAG_PAD_Y = 3.5;
    const TAG_H = TAG_FONT_SIZE + TAG_PAD_Y * 2;
    const TAG_GAP = 6;
    const ROW_STEP = TAG_H + 6;

    let tx = ML;
    let ty = y;

    for (const skill of profile.skills) {
      if (ty < bodyBottom) break;
      const tw = reg.widthOfTextAtSize(skill, TAG_FONT_SIZE) + TAG_PAD_X * 2;
      if (tx + tw > W - MR && tx > ML) {
        tx = ML;
        ty -= ROW_STEP;
      }
      page.drawRectangle({
        x: tx, y: ty - TAG_H + TAG_PAD_Y,
        width: tw, height: TAG_H,
        color: TAG_BG,
        borderColor: TAG_BORDER,
        borderWidth: 0.5,
        borderOpacity: 0.6,
      });
      page.drawText(skill, {
        x: tx + TAG_PAD_X,
        y: ty - TAG_FONT_SIZE + TAG_PAD_Y / 2,
        size: TAG_FONT_SIZE, font: reg, color: TEAL,
      });
      tx += tw + TAG_GAP;
    }
    y = ty - ROW_STEP - 2;
  }

  // ── Experience ──────────────────────────────────────────────────────────────
  if (profile.rawText) {
    drawSectionHeader('Experience');

    // Split on double newlines → each block is a job entry
    const blocks = profile.rawText
      .split(/\n{2,}/)
      .map((b) => b.trim())
      .filter(Boolean)
      .slice(0, 10);

    for (const block of blocks) {
      if (y < bodyBottom + 20) break;

      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) continue;

      // First line = job title / company — render bold
      const heading = lines[0];
      const rest    = lines.slice(1).join(' ');

      drawBodyText(heading, 9.5, bold, INK);
      if (rest) {
        drawBodyText(rest, 9, reg, INK_LIGHT, 10);
      }
      y -= 6; // gap between entries
    }
  }

  // ── Education (extracted from rawText if present) ───────────────────────────
  // Look for an "Education" block in rawText
  const eduMatch = profile.rawText.match(/education[\s\S]{0,600}/i);
  if (eduMatch && y > bodyBottom + 30) {
    drawSectionHeader('Education');
    const eduLines = eduMatch[0]
      .replace(/^education\s*/i, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4);
    for (const line of eduLines) {
      drawBodyText(line, 9.5, reg, INK);
    }
  }

  // ── Footer bar ───────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width: W, height: FOOTER_H, color: NAVY });
  page.drawRectangle({ x: 0, y: 0, width: 5, height: FOOTER_H, color: TEAL });
  page.drawText('Generated by Jobi  —  your WhatsApp job assistant', {
    x: ML, y: 9,
    size: 7, font: reg, color: rgb(0.6, 0.7, 0.75),
  });

  // Page number right-aligned
  const pageLabel = 'Page 1';
  const plw = reg.widthOfTextAtSize(pageLabel, 7);
  page.drawText(pageLabel, {
    x: W - MR - plw, y: 9,
    size: 7, font: reg, color: rgb(0.5, 0.6, 0.65),
  });

  // Thin rule above footer
  page.drawLine({
    start: { x: 5, y: FOOTER_H }, end: { x: W, y: FOOTER_H },
    thickness: 0.4, color: TEAL,
  });

  return doc.save();
}
