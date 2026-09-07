/** Blocks until Postgres accepts connections, so `db:up && db:migrate` is safe. */
import { execSync } from 'node:child_process';

const deadline = Date.now() + 60_000;
process.stdout.write('  waiting for postgres');
for (;;) {
  try {
    execSync('docker compose exec -T db pg_isready -U ops -d ai_ops', { stdio: 'ignore' });
    console.log(' ready');
    process.exit(0);
  } catch {
    if (Date.now() > deadline) {
      console.error('\n  postgres did not become ready within 60s');
      process.exit(1);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
