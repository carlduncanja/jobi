import { mkdir } from 'node:fs/promises';

import { RecordId, Surreal } from 'surrealdb';

import type { Logger } from '../config/logger';
import type { Env } from '../config/env';

export type Database = Surreal;

export function recordId(table: string, id: string) {
  return new RecordId(table, id);
}

async function doConnect(db: Surreal, env: Env): Promise<void> {
  await db.connect(env.surreal.url);
  await db.signin({
    username: env.surreal.username,
    password: env.surreal.password,
  });
  await db.use({
    namespace: env.surreal.namespace,
    database: env.surreal.database,
  });
}

export async function connectSurreal(env: Env, logger: Logger): Promise<Database> {
  const db = new Surreal();

  await doConnect(db, env);

  // Periodically verify the connection is still authenticated and reconnect if not
  setInterval(async () => {
    try {
      await db.query('RETURN 1');
    } catch {
      logger.warn('SurrealDB connection lost, reconnecting...');
      for (let attempt = 1; attempt <= 10; attempt++) {
        await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 10_000)));
        try {
          await doConnect(db, env);
          logger.info('SurrealDB reconnected');
          return;
        } catch (err) {
          logger.warn({ err, attempt }, 'SurrealDB reconnect attempt failed');
        }
      }
      logger.error('SurrealDB reconnect failed after 10 attempts, exiting');
      process.exit(1);
    }
  }, 30_000);

  await mkdir(env.dataDir, { recursive: true });
  logger.info({ url: env.surreal.url }, 'Connected to SurrealDB');
  return db;
}

export async function applySchema(db: Database, logger: Logger): Promise<void> {
  const schemaUrl = new URL('./schema/init.surql', import.meta.url);
  const schema = await Bun.file(schemaUrl).text();

  await db.query(schema).collect();
  logger.info('Applied SurrealDB schema');
}
