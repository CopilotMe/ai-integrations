export interface IdempotencyStore {
  /**
   * Records the key and reports whether this caller won the race.
   * `false` means someone already claimed it — do not repeat the side effect.
   */
  claim(key: string): Promise<boolean>;
  get(key: string): Promise<unknown | undefined>;
  complete(key: string, value: unknown): Promise<void>;
  release(key: string): Promise<void>;
}

interface Entry {
  value: unknown | undefined;
  expiresAt: number;
}

/**
 * In-memory idempotency store with a TTL.
 *
 * GoHighLevel fires `ContactCreate` and then `ContactUpdate` for the same
 * contact, and retries any non-2xx delivery — so the same lead arrives more
 * than once as a matter of routine, not as an edge case. Keying on the event
 * id collapses redeliveries of *one* event while still letting a genuinely new
 * event for the same contact through.
 *
 * Claiming happens *before* the model call, so two concurrent deliveries cannot
 * both pay for a classification.
 *
 * Single-process only, and that is a real limit: two instances would each keep
 * their own map. Swap for Redis (`SET key NX PX ttl`) behind this interface
 * before scaling out — see docs/decisions.md.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  async claim(key: string): Promise<boolean> {
    this.purge();
    if (this.entries.has(key)) return false;
    this.entries.set(key, { value: undefined, expiresAt: this.now() + this.ttlMs });
    return true;
  }

  async get(key: string): Promise<unknown | undefined> {
    this.purge();
    return this.entries.get(key)?.value;
  }

  async complete(key: string, value: unknown): Promise<void> {
    const entry = this.entries.get(key);
    if (entry) entry.value = value;
    else this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  /** Releases a claim so a transient failure can be retried by the sender. */
  async release(key: string): Promise<void> {
    this.entries.delete(key);
  }

  get size(): number {
    this.purge();
    return this.entries.size;
  }

  private purge(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
