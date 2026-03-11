import pino from 'pino';

export function createLogger() {
  return pino({
    name: 'job-bot',
    level: process.env.LOG_LEVEL ?? 'info',
  });
}

export type Logger = ReturnType<typeof createLogger>;
