import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    // Lead enquiries are personal data. The correlation id and contact id are
    // enough to trace a request without putting the content in a log store.
    redact: {
      paths: ['lead.email', 'lead.inquiry', 'lead.first_name', 'lead.last_name', '*.email', '*.inquiry'],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } } : {}),
  });
}
