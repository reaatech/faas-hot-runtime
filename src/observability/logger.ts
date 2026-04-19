import pino from 'pino';

const enablePrettyLogging = process.env.FAAS_ENABLE_PRETTY_LOGS === 'true';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: enablePrettyLogging
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'faas-hot-runtime',
    version: process.env.SERVICE_VERSION ?? '0.1.0',
  },
});

export type { Logger } from 'pino';
