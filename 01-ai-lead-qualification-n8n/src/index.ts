import 'dotenv/config';
import { loadConfig } from './config.js';
import { buildDeps } from './container.js';
import { buildServer } from './http/server.js';
import { createLogger } from './logger.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');
  const deps = buildDeps(config, logger);
  const app = buildServer({ config, deps, logger });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, 'shutting down');
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info(
    { providers: { llm: deps.llm.name, crm: deps.crm.name, notifier: deps.notifier.name } },
    `listening on :${config.PORT}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
