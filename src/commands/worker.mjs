import { createDeploymentWorker } from '../worker/deployment-worker.mjs';
import { createPostgresPool, closePostgresPool } from '../runtime/postgres.mjs';

const pool = await createPostgresPool();
const worker = createDeploymentWorker({ pool });
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

try {
  await worker.run({ signal: controller.signal });
} catch {
  process.stderr.write('UDA deployment worker stopped after a sanitized internal error.\n');
  process.exitCode = 1;
} finally {
  await closePostgresPool(pool);
}
