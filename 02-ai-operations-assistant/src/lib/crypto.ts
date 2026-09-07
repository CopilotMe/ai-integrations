import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

// `promisify` resolves to scrypt's 3-argument overload and drops the options
// parameter, so the cost parameters would be silently ignored. Wrap it by hand.
function scrypt(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (error, derivedKey) =>
      error ? reject(error) : resolve(derivedKey),
    );
  });
}

const N = 16_384;
const R = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 32;

/**
 * Password hashing with scrypt.
 *
 * scrypt rather than bcrypt because it is in Node's standard library — no
 * native build step, which matters on a serverless deploy — and memory-hard,
 * which bcrypt is not. Argon2id would be the better choice if a dependency
 * were acceptable; see docs/decisions.md.
 *
 * The parameters are stored alongside the hash so they can be raised later
 * without invalidating existing passwords.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: PARALLELISM,
    maxmem: 64 * 1024 * 1024,
  });
  return [N, R, PARALLELISM, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5) return false;

  const [nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [string, string, string, string, string];
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const expected = Buffer.from(hashB64, 'base64');
  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
      N: n,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Opaque bearer token for API keys and sessions. 32 bytes of entropy. */
export function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

/**
 * Tokens are stored hashed so a database dump does not hand over live
 * credentials. SHA-256 is right here (unlike for passwords): the token is
 * already high-entropy, so there is nothing to brute-force and no reason to pay
 * for a slow KDF on every request.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Stable hash of a request body, for detecting idempotency-key reuse. */
export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}
