import { handleAgentApiRequest } from '../api/agent';
import { handleIncomingWhatsAppMessage } from '../bot/router';
import type { AppContext } from '../lib/app-context';
import type { WhatsAppProvider } from '../domain/ports/whatsapp-provider';
import { processDailyDigestWindow } from '../workflows/daily-digest';

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

  const unsubscribe = whatsappProvider.subscribe(async (event) => {
    if (event.type === 'message') {
      await handleIncomingWhatsAppMessage(app, event.message);
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
            app.logger.error({ error }, 'Daily digest scheduler tick failed');
          });
        }, schedulerIntervalMs)
      : undefined;

  if (enableScheduler) {
    void processDailyDigestWindow(app).catch((error) => {
      app.logger.error({ error }, 'Initial daily digest scheduler tick failed');
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
      app.logger.error({ error }, 'Unhandled HTTP error');
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

      if (startWhatsAppProvider) {
        await whatsappProvider.stop();
      }

      server.stop(true);
    },
  };
}
