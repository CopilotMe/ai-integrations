import { pino, type Logger } from 'pino';

/** Scripts print their own tables; the pipeline's logs would only be noise. */
export function createLoggerForScript(level = 'silent'): Logger {
  return pino({ level });
}
