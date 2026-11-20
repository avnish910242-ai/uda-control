import { startGitHubWebhookReceiver } from '../http/github-webhook-receiver.mjs';
import { createPostgresPool, closePostgresPool } from '../runtime/postgres.mjs';

const pool = await createPostgresPool();
try {
  const server = await startGitHubWebhookReceiver({ pool });
  process.stdout.write(`UDA GitHub webhook receiver listening on port ${server.address().port}.\n`);
  const shutdown = async () => {
    server.close();
    await closePostgresPool(pool);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch {
  await closePostgresPool(pool);
  process.stderr.write('UDA webhook receiver failed to start; check its configuration and database availability.\n');
  process.exitCode = 1;
}
