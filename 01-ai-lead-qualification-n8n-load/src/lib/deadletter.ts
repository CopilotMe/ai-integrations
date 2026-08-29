import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DeadLetterEntry {
  at: string;
  correlationId: string;
  stage: string;
  error: { code?: string; message: string };
  payload: unknown;
}

export interface DeadLetterPort {
  record(entry: DeadLetterEntry): Promise<void>;
}

/**
 * Append-only JSONL dead-letter log.
 *
 * A file is the right amount of machinery for a single-node integration: it is
 * durable, greppable, and replayable with `scripts/replay.ts`. Swap this for
 * SQS/Postgres/Redis the day this runs on more than one instance — the port is
 * here so that is a one-file change.
 */
export class FileDeadLetter implements DeadLetterPort {
  constructor(private readonly path: string) {}

  async record(entry: DeadLetterEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

export class InMemoryDeadLetter implements DeadLetterPort {
  readonly entries: DeadLetterEntry[] = [];
  async record(entry: DeadLetterEntry): Promise<void> {
    this.entries.push(entry);
  }
}
