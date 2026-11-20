import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentWorker } from '../../src/worker/deployment-worker.mjs';

const JOB_ID = '2bbd6b3c-08c0-4d78-8a48-a38176607be0';
const LEASE = 'cb2fa821-f047-4e7b-8c23-dad180421951';

test('unregistered repository jobs fail closed without GitHub or Render calls', async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes('WITH candidate AS')) return { rows: [{ job_id: JOB_ID, repository_id: 123, repository_name: 'owner/site', branch_ref: 'refs/heads/main', commit_sha: 'a'.repeat(40), lease_token: LEASE, leaseToken: LEASE }] };
      if (sql.includes('FROM uda_deployment_targets')) return { rows: [] };
      if (sql.includes('UPDATE uda_deployment_jobs')) return { rows: [{ job_id: JOB_ID }] };
      throw new Error('Unexpected query');
    },
    async connect() { throw new Error('not used'); },
  };
  const worker = createDeploymentWorker({ pool, env: {}, workerId: 'test-worker', pollIntervalMs: 250 });
  assert.equal(await worker.runOnce(), true);
  assert.equal(statements.length, 3);
  assert.ok(statements[2].includes('job_status = $3'));
});
