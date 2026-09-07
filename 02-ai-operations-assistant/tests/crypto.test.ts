import { describe, expect, it } from 'vitest';
import { constantTimeEqual, generateToken, hashPassword, hashRequestBody, hashToken, verifyPassword } from '@/lib/crypto';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('stores its cost parameters, so they can be raised later without a reset', async () => {
    const [n, r, p] = (await hashPassword('x')).split('$');
    expect(Number(n)).toBeGreaterThanOrEqual(16_384);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'a$b$c$d$e')).toBe(false);
  });

  it('treats unicode-equivalent passwords as equal', async () => {
    // "é" composed vs decomposed — a user typing on a different keyboard layout
    // must still be able to sign in.
    const hash = await hashPassword('café');
    expect(await verifyPassword('café', hash)).toBe(true);
  });
});

describe('tokens', () => {
  it('generates high-entropy prefixed tokens', () => {
    const a = generateToken('opsk');
    expect(a.startsWith('opsk_')).toBe(true);
    expect(a.length).toBeGreaterThan(40);
    expect(a).not.toBe(generateToken('opsk'));
  });

  it('hashes deterministically, so a token can be looked up but not recovered', () => {
    const token = generateToken('sess');
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toHaveLength(64);
  });
});

describe('helpers', () => {
  it('compares in constant time without throwing on length mismatch', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('hashes request bodies stably for idempotency-key comparison', () => {
    expect(hashRequestBody({ a: 1 })).toBe(hashRequestBody({ a: 1 }));
    expect(hashRequestBody({ a: 1 })).not.toBe(hashRequestBody({ a: 2 }));
    expect(hashRequestBody(null)).toBe(hashRequestBody(null));
  });
});
