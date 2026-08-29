import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    // Leads are personal data. Keep them out of logs by default; the
    // correlation id is enough to trace a request end to end.
    redact: {
      paths: ['lead.email', 'lead.name', 'lead.message', '*.lead.email', '*.lead.name', '*.lead.message'],
      censor: '[redacted]',
    },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}
