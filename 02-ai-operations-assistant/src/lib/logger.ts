import { pino, type Logger } from 'pino';
import { config } from './config';

export type { Logger };

let cached: Logger | undefined;

export function logger(): Logger {
  cached ??= pino({
    level: config().LOG_LEVEL,
    // Inbound email is personal data and frequently contains more (order ids,
    // addresses, occasionally card fragments). The correlation id is enough to
    // trace a request; the content lives in Postgres with access control, not
    // in a log aggregator.
    redact: {
      paths: [
        'message.body',
        'message.from_email',
        'message.from_name',
        'body',
        'password',
        'token',
        '*.password',
        '*.token',
        'req.headers.authorization',
        'req.headers.cookie',
      ],
      censor: '[redacted]',
    },
  });
  return cached;
}
