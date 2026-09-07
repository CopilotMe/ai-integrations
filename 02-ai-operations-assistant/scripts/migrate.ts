import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb } from '../src/db/client';

async function main() {
  console.log('  running migrations…');
  await migrate(getDb(), { migrationsFolder: './drizzle' });
  console.log('  migrations applied');
  await closeDb();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await closeDb().catch(() => {});
  process.exit(1);
});
