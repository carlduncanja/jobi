import { loadEnv } from './config/env';
import { createLogger } from './config/logger';
import { applySchema, connectSurreal } from './db/surreal';
import { ExaSearchProvider } from './integrations/search/exa-search';
import { BaileysWhatsAppProvider } from './integrations/whatsapp/baileys-provider';
import type { AppContext } from './lib/app-context';
import { createJobBotServer } from './server/create-server';

const env = loadEnv();
const logger = createLogger();

// Prevent a single unhandled error from crashing the entire process.
// Individual message jobs already have their own try/catch — these are a
// last-resort safety net for anything that slips through.
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception — process kept alive');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection — process kept alive');
});
const db = await connectSurreal(env, logger);

if (env.applySchemaOnBoot) {
  await applySchema(db, logger);
}

const searchProvider = new ExaSearchProvider({
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

const whatsappProvider = new BaileysWhatsAppProvider(app, env.whatsapp.sessionId);
await createJobBotServer({
  app,
  whatsappProvider,
  hostname: env.host,
  port: env.port,
});
