/**
 * Seeds operators and an intake API key for local development.
 *
 * Credentials are printed once. They are development defaults and the script
 * refuses to run against a non-local database without an explicit opt-in.
 */
import 'dotenv/config';
import { closeDb, getDb } from '../src/db/client';
import { apiKeys, operators } from '../src/db/schema';
import { generateToken, hashPassword, hashToken } from '../src/lib/crypto';

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'ops-dev-password';

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
  if (!isLocal && process.env.ALLOW_REMOTE_SEED !== 'true') {
    throw new Error(
      'Refusing to seed a non-local database. Set ALLOW_REMOTE_SEED=true if you really mean it.',
    );
  }

  const db = getDb();
  const passwordHash = await hashPassword(SEED_PASSWORD);

  const people = [
    { email: 'admin@example.com', name: 'Ada Admin', role: 'admin' as const },
    { email: 'agent@example.com', name: 'Sam Agent', role: 'agent' as const },
    { email: 'viewer@example.com', name: 'Val Viewer', role: 'viewer' as const },
  ];

  for (const person of people) {
    await db.insert(operators).values({ ...person, passwordHash }).onConflictDoNothing({ target: operators.email });
  }

  const token = generateToken('opsk');
  await db.insert(apiKeys).values({
    name: 'local-n8n',
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 12),
    scopes: ['intake'],
  });

  console.log('\n  Seeded operators (password for all three):');
  for (const person of people) console.log(`    ${person.email.padEnd(22)} ${person.role}`);
  console.log(`\n    password: ${SEED_PASSWORD}`);
  console.log(`\n  Intake API key (shown once — store it now):\n    ${token}\n`);

  await closeDb();
}

main().catch(async (error) => {
  console.error(`\n  ${error instanceof Error ? error.message : error}\n`);
  await closeDb().catch(() => {});
  process.exit(1);
});
