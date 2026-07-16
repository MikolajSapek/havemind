// Server entrypoint used by the container CMD (apps/server/Dockerfile).
//
// It parses configuration from the process environment, builds the Fastify app
// and starts listening. Wiring the auth/sync repositories into `buildApp` is
// owned by the server bootstrap/setup work (F7-03); this entrypoint keeps the
// discovery, liveness and readiness surface serving so the hardened Compose
// package has a real, health-checkable process to run.

import { buildApp } from './app.js';
import { parseServerConfig } from './config.js';

async function main(): Promise<void> {
  const config = parseServerConfig(process.env);
  const app = buildApp({ config });

  const close = (): void => {
    void app.close().finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Failed to start Havemind server: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
