import pino from 'pino';

export function createLogger() {
  return pino({
    name: 'job-bot',
    level: process.env.LOG_LEVEL ?? 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
