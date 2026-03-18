import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Document, Packer, Paragraph } from 'docx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Surreal } from 'surrealdb';

import { loadEnv } from '../../src/config/env';
import { createLogger } from '../../src/config/logger';
import { getNotificationPreference, getSearchProfile } from '../../src/db/store';
import { applySchema, connectSurreal, type Database } from '../../src/db/surreal';
import type { SearchProvider } from '../../src/domain/ports/search-provider';
import type { WhatsAppProvider } from '../../src/domain/ports/whatsapp-provider';
import { ExaSearchProvider } from '../../src/integrations/search/exa-search';
import type { AppContext } from '../../src/lib/app-context';
import type {
  AgentRequestAttachmentInput,
  OutboundAudioMessage,
  OutboundDocumentMessage,
  OutboundTextMessage,
  SendMessageResult,
  WhatsAppProviderEvent,
  WhatsAppSessionStatus,
} from '../../src/lib/types';
import { createJobBotServer, type JobBotServerHandle } from '../../src/server/create-server';
import { processDailyDigestWindow } from '../../src/workflows/daily-digest';

export interface FakeSentMessage {
  chatId: string;
  text: string;
  quotedMessageId?: string;
}

export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly sentMessages: FakeSentMessage[] = [];
  private readonly listeners = new Set<(event: WhatsAppProviderEvent) => Promise<void> | void>();
  private status: WhatsAppSessionStatus = {
    sessionId: 'test-session',
    state: 'close',
  };

  async start(): Promise<void> {
    this.status = {
      ...this.status,
      state: 'open',
    };
  }

  async stop(): Promise<void> {
    this.status = {
      ...this.status,
      state: 'close',
    };
  }

  subscribe(listener: (event: WhatsAppProviderEvent) => Promise<void> | void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async sendText(message: OutboundTextMessage): Promise<SendMessageResult> {
    this.sentMessages.push(message);

    return {
      delivered: true,
      providerMessageId: `fake-${this.sentMessages.length}`,
    };
  }

  async sendAudio(_message: OutboundAudioMessage): Promise<SendMessageResult> {
    return { delivered: true, providerMessageId: `fake-audio-${Date.now()}` };
  }

  async sendDocument(_message: OutboundDocumentMessage): Promise<SendMessageResult> {
    return { delivered: true, providerMessageId: `fake-doc-${Date.now()}` };
  }

  async getSessionStatus(): Promise<WhatsAppSessionStatus> {
    return this.status;
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    const code = `PAIR-${phoneNumber.slice(-4).padStart(4, '0')}`;

    this.status = {
      ...this.status,
      pairingCode: code,
    };

    for (const listener of this.listeners) {
      await listener({
        type: 'connection',
        session: this.status,
      });
    }

    return code;
  }
}

export interface LiveHarness {
  app: AppContext;
  db: Database;
  baseUrl: string;
  whatsappProvider: FakeWhatsAppProvider;
  stop: () => Promise<void>;
  requestJson: <T>(path: string, init?: RequestInit) => Promise<{ status: number; body: T }>;
  callAgent: (input: {
    text: string;
    userId?: string;
    chatId?: string;
    sessionId?: string;
    allowSending?: boolean;
    attachments?: AgentRequestAttachmentInput[];
  }) => Promise<{ status: number; body: { text?: string; sentMessageCount?: number; error?: string } }>;
}

export async function startLiveHarness(): Promise<LiveHarness> {
  const port = 18_100 + Math.floor(Math.random() * 500);
  const surrealProcess = Bun.spawn(
    [
      'surreal',
      'start',
      'memory',
      '--bind',
      `127.0.0.1:${port}`,
      '--user',
      'root',
      '--pass',
      'root',
      '--no-banner',
      '-l',
      'error',
    ],
    {
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  await waitForSurreal(`ws://127.0.0.1:${port}/rpc`);

  const tmpDataDir = await mkdtemp(join(tmpdir(), 'job-bot-e2e-'));
  const namespace = `jobbot_e2e_${crypto.randomUUID().replace(/-/g, '')}`;
  const database = 'integration';

  process.env.LOG_LEVEL = 'error';
  process.env.SURREAL_URL = `ws://127.0.0.1:${port}/rpc`;
  process.env.SURREAL_NAMESPACE = namespace;
  process.env.SURREAL_DATABASE = database;
  process.env.SURREAL_USERNAME = 'root';
  process.env.SURREAL_PASSWORD = 'root';
  process.env.JOB_BOT_DATA_DIR = tmpDataDir;
  process.env.WHATSAPP_SESSION_ID = 'test-session';

  const env = loadEnv();
  const logger = createLogger();
  const db = await connectSurreal(env, logger);
  await applySchema(db, logger);

  const searchProvider: SearchProvider = new ExaSearchProvider({
    apiKey: env.exaApiKey,
    logger,
  });

  const app: AppContext = {
    env,
    logger,
    db,
    searchProvider,
    whatsappProvider: null,
  };

  const whatsappProvider = new FakeWhatsAppProvider();
  const serverHandle = await createJobBotServer({
    app,
    whatsappProvider,
    hostname: '127.0.0.1',
    port: 0,
    enableScheduler: false,
  });

  const baseUrl = `http://127.0.0.1:${serverHandle.server.port}`;

  return {
    app,
    db,
    baseUrl,
    whatsappProvider,
    stop: async () => {
      await serverHandle.stop();
      surrealProcess.kill();
      await rm(tmpDataDir, { recursive: true, force: true });
    },
    requestJson: async <T>(path: string, init?: RequestInit) => {
      const response = await fetch(`${baseUrl}${path}`, init);
      const body = (await response.json()) as T;
      return {
        status: response.status,
        body,
      };
    },
    callAgent: async ({
      text,
      userId = 'integration-user',
      chatId = 'integration-chat',
      sessionId = 'test-session',
      allowSending = false,
      attachments = [],
    }) => {
      return await fetchJson<{ text?: string; sentMessageCount?: number; error?: string }>(
        `${baseUrl}/api/agent`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            sessionId,
            chatId,
            userId,
            text,
            allowSending,
            attachments,
          }),
        },
      );
    },
  };
}

export async function getStoredSearchProfile(harness: LiveHarness, userId = 'integration-user') {
  return await getSearchProfile(harness.db, userId);
}

export async function getStoredNotificationPreference(
  harness: LiveHarness,
  userId = 'integration-user',
) {
  return await getNotificationPreference(harness.db, userId);
}

export async function runDigestNow(harness: LiveHarness, at: Date) {
  await processDailyDigestWindow(harness.app, at);
}

export async function generateResumeImageAttachment(text: string): Promise<AgentRequestAttachmentInput> {
  const script = `
import base64
import io
from PIL import Image, ImageDraw, ImageFont

text = ${JSON.stringify(text)}
lines = text.split("\\n")
font = ImageFont.load_default()
line_height = 20
width = 1000
height = max(200, 40 + len(lines) * line_height)
image = Image.new("RGB", (width, height), "white")
draw = ImageDraw.Draw(image)
y = 20
for line in lines:
    draw.text((20, y), line, fill="black", font=font)
    y += line_height
buffer = io.BytesIO()
image.save(buffer, format="PNG")
print(base64.b64encode(buffer.getvalue()).decode("ascii"))
`;

  const result = Bun.spawnSync(['python3', '-c', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to generate image fixture: ${new TextDecoder().decode(result.stderr)}`);
  }

  return {
    filename: 'resume-image.png',
    mimeType: 'image/png',
    kind: 'image',
    base64: new TextDecoder().decode(result.stdout).trim(),
  };
}

export async function generateResumePdfAttachment(text: string): Promise<AgentRequestAttachmentInput> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const lines = text.split('\n');
  let y = 760;

  for (const line of lines) {
    page.drawText(line, {
      x: 40,
      y,
      size: 12,
      font,
    });
    y -= 18;
  }

  const bytes = await pdf.save();

  return {
    filename: 'resume.pdf',
    mimeType: 'application/pdf',
    kind: 'document',
    base64: Buffer.from(bytes).toString('base64'),
  };
}

export async function generateResumeDocxAttachment(text: string): Promise<AgentRequestAttachmentInput> {
  const lines = text.split('\n');
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: lines.map((line) => new Paragraph({ text: line })),
      },
    ],
  });
  const buffer = await Packer.toBuffer(doc);

  return {
    filename: 'resume.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
    base64: buffer.toString('base64'),
  };
}

async function waitForSurreal(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const db = new Surreal();
      await db.connect(url);
      await db.signin({
        username: 'root',
        password: 'root',
      });
      await db.use({
        namespace: 'health',
        database: 'health',
      });
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(200);
    }
  }

  throw new Error(`Timed out waiting for SurrealDB: ${String(lastError)}`);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T;

  return {
    status: response.status,
    body,
  };
}
