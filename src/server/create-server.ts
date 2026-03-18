import { handleAgentApiRequest } from '../api/agent';
import { enqueueMessage } from '../bot/router';
import type { AppContext } from '../lib/app-context';
import type { WhatsAppProvider } from '../domain/ports/whatsapp-provider';
import { processDailyDigestWindow } from '../workflows/daily-digest';
import { handleStripeWebhook } from './stripe-webhook';
import { startMessageWorker } from '../queue/message-queue';

export interface CreateJobBotServerOptions {
  app: AppContext;
  whatsappProvider: WhatsAppProvider;
  hostname: string;
  port: number;
  enableScheduler?: boolean;
  schedulerIntervalMs?: number;
  startWhatsAppProvider?: boolean;
}

export interface JobBotServerHandle {
  server: ReturnType<typeof Bun.serve>;
  stop: () => Promise<void>;
}

export async function createJobBotServer(
  options: CreateJobBotServerOptions,
): Promise<JobBotServerHandle> {
  const {
    app,
    whatsappProvider,
    hostname,
    port,
    enableScheduler = true,
    schedulerIntervalMs = 60_000,
    startWhatsAppProvider = true,
  } = options;

  app.whatsappProvider = whatsappProvider;

  // Start BullMQ worker if Redis is configured
  const worker = app.env.redisUrl ? startMessageWorker(app) : null;
  if (worker) {
    app.logger.info('BullMQ worker started — messages will be processed via Redis queue');
  } else {
    app.logger.info('No REDIS_URL set — using in-memory queue');
  }

  const unsubscribe = whatsappProvider.subscribe((event) => {
    if (event.type === 'message') {
      void enqueueMessage(app, event.message);
      return;
    }

    app.logger.info({ session: event.session }, 'WhatsApp session update');
  });

  if (startWhatsAppProvider) {
    await whatsappProvider.start();
  }

  const scheduler =
    enableScheduler
      ? setInterval(() => {
          void processDailyDigestWindow(app).catch((error) => {
            app.logger.error({ err: error }, 'Daily digest scheduler tick failed');
          });
        }, schedulerIntervalMs)
      : undefined;

  if (enableScheduler) {
    void processDailyDigestWindow(app).catch((error) => {
      app.logger.error({ err: error }, 'Initial daily digest scheduler tick failed');
    });
  }

  const server = Bun.serve({
    hostname,
    port,
    routes: {
      '/health': () =>
        Response.json({
          ok: true,
        }),
      '/api/agent': {
        POST: (request: Request) => handleAgentApiRequest(app, request),
      },
      '/api/whatsapp/session': {
        GET: async () => Response.json(await whatsappProvider.getSessionStatus()),
      },
      '/qr': {
        GET: async () => {
          const status = await whatsappProvider.getSessionStatus();
          if (status.state === 'open') {
            return new Response('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>Already connected!</h1></body></html>', { headers: { 'Content-Type': 'text/html' } });
          }
          if (!status.qr) {
            return new Response('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>No QR code available yet</h1><p>Refresh in a few seconds...</p><script>setTimeout(()=>location.reload(),3000)</script></body></html>', { headers: { 'Content-Type': 'text/html' } });
          }
          const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(status.qr)}`;
          return new Response(
            `<html><body style="font-family:sans-serif;text-align:center;padding:40px">` +
            `<h1>Scan with WhatsApp</h1>` +
            `<p>Open WhatsApp > Linked Devices > Link a Device</p>` +
            `<img src="${qrUrl}" width="400" height="400" />` +
            `<script>setTimeout(()=>location.reload(),20000)</script>` +
            `</body></html>`,
            { headers: { 'Content-Type': 'text/html' } },
          );
        },
      },
      '/webhooks/stripe': {
        POST: (request: Request) => handleStripeWebhook(app, request),
      },
      '/api/whatsapp/pairing-code': {
        POST: async (request: Request) => {
          const body = (await request.json()) as { phoneNumber?: string };
          const phoneNumber = body.phoneNumber ?? app.env.whatsapp.pairingPhoneNumber;

          if (!phoneNumber) {
            return Response.json(
              {
                error: 'phoneNumber is required',
              },
              { status: 400 },
            );
          }

          const code = await whatsappProvider.requestPairingCode(phoneNumber);
          return Response.json({ code });
        },
      },
    },
    fetch: () =>
      Response.json(
        {
          error: 'Not found',
        },
        { status: 404 },
      ),
    error(error) {
      app.logger.error({ err: error }, 'Unhandled HTTP error');
      return Response.json(
        {
          error: 'Internal server error',
        },
        { status: 500 },
      );
    },
  });

  app.logger.info(
    {
      url: `http://${hostname}:${server.port}`,
    },
    'Job Bot is running',
  );

  return {
    server,
    stop: async () => {
      unsubscribe();

      if (scheduler) {
        clearInterval(scheduler);
      }

      if (worker) {
        await worker.close();
      }

      if (startWhatsAppProvider) {
        await whatsappProvider.stop();
      }

      server.stop(true);
    },
  };
}
