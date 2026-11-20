import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  claimNextJob,
  DeploymentQueueError,
  enqueueVerifiedPush,
  finishJob,
  renewJobLease,
} from '../../src/persistence/deployment-queue-repository.mjs';

const PUSH_EVENT = Object.freeze({
  deliveryId: '0b989ba4-242f-11e5-81e1-c7b6966d2516',
  repositoryId: 81234567,
  repositoryName: 'safe-owner/safe-repository',
  branchRef: 'refs/heads/main',
  commitSha: '0123456789abcdef0123456789abcdef01234567',
});
const JOB_ID = '2bbd6b3c-08c0-4d78-8a48-a38176607be0';

function response(rows = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function scriptedPool(steps) {
  const client = {
    calls: [],
    released: false,
    async query(sql, values = []) {
      this.calls.push({ sql, values });
      const step = steps.shift();
      assert.ok(step, `Unexpected query: ${sql}`);
      if (step.error) throw step.error;
      return step.result;
    },
    release() {
      this.released = true;
    },
  };
  return { client, async connect() { return client; } };
}

function assertParameterized(calls, values) {
  for (const call of calls) {
    assert.ok(Array.isArray(call.values));
    for (const value of values) {
      if (typeof value === 'string') assert.equal(call.sql.includes(value), false);
    }
  }
}

test('inserts a delivery and job in one transaction using parameterized SQL', async () => {
  const pool = scriptedPool([
    { result: response() },
    { result: response([{ delivery_id: PUSH_EVENT.deliveryId }]) },
    { result: response([{ job_id: JOB_ID }]) },
    { result: response([], 1) },
    { result: response() },
  ]);

  const result = await enqueueVerifiedPush(pool, PUSH_EVENT);

  assert.deepEqual(result, {
    deliveryId: PUSH_EVENT.deliveryId,
    jobId: JOB_ID,
    duplicateDelivery: false,
    duplicateJob: false,
  });
  assert.equal(pool.client.calls[0].sql, 'BEGIN');
  assert.match(pool.client.calls[1].sql, /ON CONFLICT \(delivery_id\) DO NOTHING/);
  assert.match(pool.client.calls[2].sql, /ON CONFLICT \(repository_id, branch_ref, commit_sha\) DO NOTHING/);
  assert.equal(pool.client.calls.at(-1).sql, 'COMMIT');
  assertParameterized(pool.client.calls, Object.values(PUSH_EVENT));
  assert.equal(pool.client.released, true);
});

test('deduplicates a repeated delivery without creating another job', async () => {
  const pool = scriptedPool([
    { result: response() },
    { result: response() },
    { result: response([{
      delivery_id: PUSH_EVENT.deliveryId,
      repository_id: String(PUSH_EVENT.repositoryId),
      repository_name: PUSH_EVENT.repositoryName,
      branch_ref: PUSH_EVENT.branchRef,
      commit_sha: PUSH_EVENT.commitSha,
      job_id: JOB_ID,
      delivery_status: 'queued',
    }]) },
    { result: response() },
  ]);

  const result = await enqueueVerifiedPush(pool, PUSH_EVENT);

  assert.deepEqual(result, {
    deliveryId: PUSH_EVENT.deliveryId,
    jobId: JOB_ID,
    duplicateDelivery: true,
    duplicateJob: false,
  });
  assert.equal(pool.client.calls.some(call => /INSERT INTO uda_deployment_jobs/.test(call.sql)), false);
});

test('rejects a reused delivery ID with different event identity and rolls back', async () => {
  const conflictingEvent = { ...PUSH_EVENT, commitSha: 'a'.repeat(40) };
  const pool = scriptedPool([
    { result: response() },
    { result: response() },
    { result: response([{
      delivery_id: PUSH_EVENT.deliveryId,
      repository_id: String(PUSH_EVENT.repositoryId),
      repository_name: PUSH_EVENT.repositoryName,
      branch_ref: PUSH_EVENT.branchRef,
      commit_sha: PUSH_EVENT.commitSha,
      job_id: JOB_ID,
      delivery_status: 'queued',
    }]) },
    { result: response() },
  ]);

  await assert.rejects(enqueueVerifiedPush(pool, conflictingEvent), error => {
    assert.equal(error.code, 'delivery_id_conflict');
    return true;
  });
  assert.equal(pool.client.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(pool.client.calls.some(call => /INSERT INTO uda_deployment_jobs/.test(call.sql)), false);
});

test('links a new delivery to the existing job for the same repository, branch, and commit', async () => {
  const event = { ...PUSH_EVENT, deliveryId: randomUUID() };
  const pool = scriptedPool([
    { result: response() },
    { result: response([{ delivery_id: event.deliveryId }]) },
    { result: response() },
    { result: response([{ job_id: JOB_ID }]) },
    { result: response([], 1) },
    { result: response() },
  ]);

  const result = await enqueueVerifiedPush(pool, event);

  assert.equal(result.duplicateDelivery, false);
  assert.equal(result.duplicateJob, true);
  assert.equal(result.jobId, JOB_ID);
  assert.deepEqual(pool.client.calls.at(-2).values, [event.deliveryId, JOB_ID, 'duplicate_commit']);
});

test('rolls back the whole insertion when job creation fails', async () => {
  const pool = scriptedPool([
    { result: response() },
    { result: response([{ delivery_id: PUSH_EVENT.deliveryId }]) },
    { error: new Error('database detail must not escape') },
    { result: response() },
  ]);

  await assert.rejects(enqueueVerifiedPush(pool, PUSH_EVENT), error => {
    assert.ok(error instanceof DeploymentQueueError);
    assert.equal(error.code, 'database_operation_failed');
    assert.equal(error.message.includes('database detail'), false);
    return true;
  });
  assert.equal(pool.client.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(pool.client.released, true);
});

test('sanitizes pool connection-acquisition errors', async () => {
  const pool = {
    async connect() {
      throw new Error('postgres connection detail and secret');
    },
  };

  await assert.rejects(enqueueVerifiedPush(pool, PUSH_EVENT), error => {
    assert.equal(error.code, 'database_operation_failed');
    assert.equal(error.message.includes('secret'), false);
    assert.equal(error.message.includes('connection detail'), false);
    return true;
  });
});

test('rollback and release failures do not mask the original repository error', async () => {
  const pool = scriptedPool([
    { result: response() },
    { result: response() },
    { result: response([{
      delivery_id: PUSH_EVENT.deliveryId,
      repository_id: String(PUSH_EVENT.repositoryId),
      repository_name: PUSH_EVENT.repositoryName,
      branch_ref: PUSH_EVENT.branchRef,
      commit_sha: PUSH_EVENT.commitSha,
      job_id: JOB_ID,
      delivery_status: 'queued',
    }]) },
    { error: new Error('rollback database secret') },
  ]);
  pool.client.release = () => {
    throw new Error('release database secret');
  };
  const conflictingEvent = { ...PUSH_EVENT, commitSha: 'a'.repeat(40) };

  await assert.rejects(enqueueVerifiedPush(pool, conflictingEvent), error => {
    assert.equal(error.code, 'delivery_id_conflict');
    assert.equal(error.message.includes('rollback database secret'), false);
    assert.equal(error.message.includes('release database secret'), false);
    return true;
  });
  assert.equal(pool.client.calls.at(-1).sql, 'ROLLBACK');
});

test('sanitizes a client release failure after a successful commit', async () => {
  const pool = scriptedPool([
    { result: response() },
    { result: response([{ delivery_id: PUSH_EVENT.deliveryId }]) },
    { result: response([{ job_id: JOB_ID }]) },
    { result: response([], 1) },
    { result: response() },
  ]);
  pool.client.release = () => {
    throw new Error('release detail with secret');
  };

  await assert.rejects(enqueueVerifiedPush(pool, PUSH_EVENT), error => {
    assert.equal(error.code, 'database_operation_failed');
    assert.equal(error.message.includes('release detail'), false);
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  assert.equal(pool.client.calls.at(-1).sql, 'COMMIT');
});

test('rejects an event that does not match the verifier output contract before connecting', async () => {
  let connected = false;
  const pool = { async connect() { connected = true; throw new Error('must not connect'); } };

  await assert.rejects(enqueueVerifiedPush(pool, { ...PUSH_EVENT, commitSha: '0'.repeat(40) }), error => {
    assert.equal(error.code, 'invalid_verified_push');
    return true;
  });
  assert.equal(connected, false);
});

test('claims one job with a single atomic SKIP LOCKED statement and lease token', async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return response([{
        job_id: JOB_ID,
        job_status: 'processing',
        prior_status: 'processing',
        recovery_mode: 'reconcile',
        lease_token: values[1],
      }]);
    },
  };

  const claimed = await claimNextJob(pool, { workerId: 'n8n-local', leaseSeconds: 120 });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FOR UPDATE\s+SKIP LOCKED/);
  assert.match(calls[0].sql, /lease_expires_at <= clock_timestamp\(\)/);
  assert.match(calls[0].sql, /attempt_count = job\.attempt_count \+ 1/);
  assert.deepEqual(calls[0].values.slice(0, 2), ['n8n-local', claimed.leaseToken]);
  assert.equal(calls[0].values[2], 120);
  assert.equal(claimed.recovery_mode, 'reconcile');
});

test('concurrent claim calls receive distinct jobs from the atomic queue operation', async () => {
  const jobs = [JOB_ID, '83a42245-35ce-4714-9021-1748f7cd9af7'];
  const pool = {
    async query(sql, values) {
      assert.match(sql, /FOR UPDATE\s+SKIP LOCKED/);
      const jobId = jobs.shift();
      return response(jobId ? [{ job_id: jobId, lease_token: values[1] }] : []);
    },
  };

  const claims = await Promise.all([
    claimNextJob(pool, { workerId: 'worker-a' }),
    claimNextJob(pool, { workerId: 'worker-b' }),
  ]);

  assert.notEqual(claims[0].job_id, claims[1].job_id);
  assert.notEqual(claims[0].leaseToken, claims[1].leaseToken);
});

test('renews a lease only through parameterized, unexpired claim-token matching', async () => {
  let captured;
  const pool = {
    async query(sql, values) {
      captured = { sql, values };
      return response([{ job_id: JOB_ID }]);
    },
  };
  const token = randomUUID();

  const renewed = await renewJobLease(pool, {
    jobId: JOB_ID,
    leaseToken: token,
    executionStage: 'polling',
    leaseSeconds: 90,
    renderDeployId: 'dep-safe123',
  });

  assert.equal(renewed, true);
  assert.match(captured.sql, /lease_token = \$2/);
  assert.match(captured.sql, /lease_expires_at > clock_timestamp\(\)/);
  assert.deepEqual(captured.values, [JOB_ID, token, 'polling', 'dep-safe123', 90]);
  assert.equal(captured.sql.includes(JOB_ID), false);
});

test('a stale worker cannot finish a job after its lease expires or changes', async () => {
  let captured;
  const pool = {
    async query(sql, values) {
      captured = { sql, values };
      return response();
    },
  };

  const updated = await finishJob(pool, {
    jobId: JOB_ID,
    leaseToken: randomUUID(),
    status: 'succeeded',
    renderDeployId: 'dep-safe123',
  });

  assert.equal(updated, false);
  assert.match(captured.sql, /lease_token = \$2/);
  assert.match(captured.sql, /lease_expires_at > clock_timestamp\(\)/);
  assert.equal(captured.values[2], 'succeeded');
});

test('moves a failed or ambiguous result into the configured safe state', async () => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return response([{ job_id: JOB_ID }]);
    },
  };
  const leaseToken = randomUUID();

  assert.equal(await finishJob(pool, {
    jobId: JOB_ID,
    leaseToken,
    status: 'needs_reconciliation',
    errorCode: 'render_response_lost',
  }), true);
  assert.match(calls[0].sql, /ELSE 'reconciling' END/);
  assert.equal(calls[0].values[2], 'needs_reconciliation');
  assert.equal(calls[0].values[3], 'render_response_lost');
});
