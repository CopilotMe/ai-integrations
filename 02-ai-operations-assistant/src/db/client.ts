import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let database: Database | undefined;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Run `npm run db:up` for local Postgres, or point it at Supabase/Neon.',
    );
  }
  return url;
}

/**
 * One pool per process.
 *
 * Serverless matters here: on Vercel a function instance is reused across
 * requests, so a pool created per request would exhaust Postgres connections
 * under any real load. Small `max` for the same reason — with a managed
 * Postgres, use the pooler endpoint and keep this low.
 */
export function getDb(): Database {
  if (!database) {
    pool = new Pool({
      connectionString: databaseUrl(),
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: databaseUrl().includes('localhost') ? undefined : { rejectUnauthorized: false },
    });
    database = drizzle(pool, { schema });
  }
  return database;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  database = undefined;
}

export { schema };
