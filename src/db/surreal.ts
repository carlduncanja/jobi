import { mkdir } from 'node:fs/promises';

import { RecordId, Surreal } from 'surrealdb';

import type { Logger } from '../config/logger';
import type { Env } from '../config/env';

export type Database = Surreal;

export function recordId(table: string, id: string) {
  return new RecordId(table, id);
}

export async function connectSurreal(env: Env, logger: Logger): Promise<Database> {
  const db = new Surreal();

  await db.connect(env.surreal.url);
  await db.signin({
    username: env.surreal.username,
    password: env.surreal.password,
  });
  await db.use({
    namespace: env.surreal.namespace,
    database: env.surreal.database,
  });

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
