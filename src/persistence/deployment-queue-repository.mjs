import { randomUUID } from 'node:crypto';

const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const EXECUTION_STAGES = new Set(['triggering', 'polling', 'verifying', 'reporting', 'reconciling']);
const FINISH_STATUSES = new Set(['succeeded', 'failed', 'needs_reconciliation']);
const DEFAULT_LEASE_SECONDS = 300;
const MAX_LEASE_SECONDS = 3600;

export class DeploymentQueueError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DeploymentQueueError';
    this.code = code;
  }
}

function fail(code) {
  throw new DeploymentQueueError(code);
}

function normalizeVerifiedPush(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      typeof event.deliveryId !== 'string' || !DELIVERY_ID_PATTERN.test(event.deliveryId) ||
      !Number.isSafeInteger(event.repositoryId) || event.repositoryId <= 0 ||
      typeof event.repositoryName !== 'string' || !REPOSITORY_NAME_PATTERN.test(event.repositoryName) ||
      typeof event.branchRef !== 'string' || !BRANCH_REF_PATTERN.test(event.branchRef) ||
      typeof event.commitSha !== 'string' || !COMMIT_SHA_PATTERN.test(event.commitSha) || /^0+$/.test(event.commitSha)) {
    fail('invalid_verified_push');
  }

  return Object.freeze({
    deliveryId: event.deliveryId.toLowerCase(),
    repositoryId: event.repositoryId,
    repositoryName: event.repositoryName,
    branchRef: event.branchRef,
    commitSha: event.commitSha.toLowerCase(),
  });
}

function assertPool(pool) {
  if (!pool || typeof pool.connect !== 'function') fail('invalid_database_pool');
}

function assertSingleRow(result, errorCode) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) fail(errorCode);
  return result.rows[0];
}

function sameDelivery(existing, event) {
  return String(existing.repository_id) === String(event.repositoryId) &&
    existing.repository_name === event.repositoryName &&
    existing.branch_ref === event.branchRef &&
    String(existing.commit_sha).toLowerCase() === event.commitSha;
}

async function rollbackQuietly(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original failure; database errors are not returned to callers.
  }
}

function sanitizeOperationError(error) {
  return error instanceof DeploymentQueueError
    ? error
    : new DeploymentQueueError('database_operation_failed');
}

export async function enqueueVerifiedPush(pool, verifiedPush) {
  assertPool(pool);
  const event = normalizeVerifiedPush(verifiedPush);
  const proposedJobId = randomUUID();
  let client;
  let transactionStarted = false;
  let operationError;
  let operationResult;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    const deliveryInsert = await client.query(
      `INSERT INTO uda_webhook_deliveries
         (delivery_id, repository_id, repository_name, branch_ref, commit_sha)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING delivery_id`,
      [event.deliveryId, event.repositoryId, event.repositoryName, event.branchRef, event.commitSha],
    );

    if (deliveryInsert.rows.length === 0) {
      const existingResult = await client.query(
        `SELECT delivery_id, repository_id, repository_name, branch_ref, commit_sha, job_id, delivery_status
         FROM uda_webhook_deliveries
         WHERE delivery_id = $1`,
        [event.deliveryId],
      );
      const existing = assertSingleRow(existingResult, 'delivery_record_missing');
      if (!sameDelivery(existing, event)) fail('delivery_id_conflict');
      if (!existing.job_id) fail('delivery_record_incomplete');

      await client.query('COMMIT');
      transactionStarted = false;
      operationResult = Object.freeze({
        deliveryId: event.deliveryId,
        jobId: existing.job_id,
        duplicateDelivery: true,
        duplicateJob: existing.delivery_status === 'duplicate_commit',
      });
    } else {
      const jobInsert = await client.query(
        `INSERT INTO uda_deployment_jobs
           (job_id, repository_id, repository_name, branch_ref, commit_sha)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (repository_id, branch_ref, commit_sha) DO NOTHING
         RETURNING job_id`,
        [proposedJobId, event.repositoryId, event.repositoryName, event.branchRef, event.commitSha],
      );

      let jobId;
      let duplicateJob;
      if (jobInsert.rows.length === 1) {
        jobId = jobInsert.rows[0].job_id;
        duplicateJob = false;
      } else {
        const existingJobResult = await client.query(
          `SELECT job_id
           FROM uda_deployment_jobs
           WHERE repository_id = $1 AND branch_ref = $2 AND commit_sha = $3`,
          [event.repositoryId, event.branchRef, event.commitSha],
        );
        jobId = assertSingleRow(existingJobResult, 'deployment_job_missing').job_id;
        duplicateJob = true;
      }

      const deliveryStatus = duplicateJob ? 'duplicate_commit' : 'queued';
      await client.query(
        `UPDATE uda_webhook_deliveries
         SET job_id = $2, delivery_status = $3
         WHERE delivery_id = $1`,
        [event.deliveryId, jobId, deliveryStatus],
      );

      await client.query('COMMIT');
      transactionStarted = false;
      operationResult = Object.freeze({
        deliveryId: event.deliveryId,
        jobId,
        duplicateDelivery: false,
        duplicateJob,
      });
    }
  } catch (error) {
    if (transactionStarted) await rollbackQuietly(client);
    operationError = sanitizeOperationError(error);
  }

  if (client) {
    try {
      client.release();
    } catch {
      if (!operationError) operationError = new DeploymentQueueError('database_operation_failed');
    }
  }

  if (operationError) throw operationError;
  return operationResult;
}

export async function claimNextJob(pool, options = {}) {
  if (!pool || typeof pool.query !== 'function') fail('invalid_database_pool');
  const workerId = options.workerId;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (typeof workerId !== 'string' || workerId.length < 1 || workerId.length > 128 || /[\x00-\x1f\x7f]/.test(workerId)) {
    fail('invalid_worker_id');
  }
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > MAX_LEASE_SECONDS) {
    fail('invalid_lease_duration');
  }

  const leaseToken = randomUUID();
  try {
    const result = await pool.query(
      `WITH candidate AS (
         SELECT job_id, job_status AS prior_status
         FROM uda_deployment_jobs
         WHERE job_status IN ('queued', 'needs_reconciliation')
            OR (job_status = 'processing' AND lease_expires_at <= clock_timestamp())
         ORDER BY created_at, job_id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       ), claimed AS (
         UPDATE uda_deployment_jobs AS job
         SET job_status = 'processing',
             execution_stage = CASE WHEN candidate.prior_status = 'queued' THEN 'triggering' ELSE 'reconciling' END,
             attempt_count = job.attempt_count + 1,
             worker_id = $1,
             lease_token = $2,
             lease_expires_at = clock_timestamp() + make_interval(secs => $3::double precision),
             claimed_at = clock_timestamp(),
             updated_at = clock_timestamp()
         FROM candidate
         WHERE job.job_id = candidate.job_id
         RETURNING job.*, candidate.prior_status
       )
       SELECT claimed.*,
              CASE WHEN claimed.prior_status = 'queued' THEN 'process' ELSE 'reconcile' END AS recovery_mode
       FROM claimed`,
      [workerId, leaseToken, leaseSeconds],
    );
    if (!result || !Array.isArray(result.rows) || result.rows.length === 0) return null;
    const row = result.rows[0];
    return Object.freeze({ ...row, leaseToken: row.lease_token });
  } catch {
    throw new DeploymentQueueError('database_operation_failed');
  }
}

export async function renewJobLease(pool, options) {
  if (!pool || typeof pool.query !== 'function') fail('invalid_database_pool');
  const { jobId, leaseToken, executionStage, leaseSeconds = DEFAULT_LEASE_SECONDS, renderDeployId = null } = options ?? {};
  if (typeof jobId !== 'string' || !DELIVERY_ID_PATTERN.test(jobId) ||
      typeof leaseToken !== 'string' || !DELIVERY_ID_PATTERN.test(leaseToken) ||
      !EXECUTION_STAGES.has(executionStage) ||
      !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > MAX_LEASE_SECONDS ||
      (renderDeployId !== null && (typeof renderDeployId !== 'string' || renderDeployId.length > 128))) {
    fail('invalid_lease_update');
  }

  try {
    const result = await pool.query(
      `UPDATE uda_deployment_jobs
       SET execution_stage = $3,
           render_deploy_id = COALESCE($4, render_deploy_id),
           lease_expires_at = clock_timestamp() + make_interval(secs => $5::double precision),
           updated_at = clock_timestamp()
       WHERE job_id = $1 AND lease_token = $2 AND job_status = 'processing'
         AND lease_expires_at > clock_timestamp()
       RETURNING job_id`,
      [jobId, leaseToken, executionStage, renderDeployId, leaseSeconds],
    );
    return Boolean(result?.rows?.length);
  } catch {
    throw new DeploymentQueueError('database_operation_failed');
  }
}

export async function finishJob(pool, options) {
  if (!pool || typeof pool.query !== 'function') fail('invalid_database_pool');
  const { jobId, leaseToken, status, errorCode = null, renderDeployId = null } = options ?? {};
  if (typeof jobId !== 'string' || !DELIVERY_ID_PATTERN.test(jobId) ||
      typeof leaseToken !== 'string' || !DELIVERY_ID_PATTERN.test(leaseToken) ||
      !FINISH_STATUSES.has(status) ||
      (errorCode !== null && (typeof errorCode !== 'string' || !/^[a-z0-9_]{1,64}$/.test(errorCode))) ||
      (renderDeployId !== null && (typeof renderDeployId !== 'string' || renderDeployId.length > 128))) {
    fail('invalid_job_result');
  }

  try {
    const result = await pool.query(
      `UPDATE uda_deployment_jobs
       SET job_status = $3,
           execution_stage = CASE WHEN $3 = 'succeeded' THEN 'complete'
                                  WHEN $3 = 'failed' THEN 'failed'
                                  ELSE 'reconciling' END,
           last_error_code = $4,
           render_deploy_id = COALESCE($5, render_deploy_id),
           completed_at = CASE WHEN $3 IN ('succeeded', 'failed') THEN clock_timestamp() ELSE NULL END,
           worker_id = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = clock_timestamp()
       WHERE job_id = $1 AND lease_token = $2 AND job_status = 'processing'
         AND lease_expires_at > clock_timestamp()
       RETURNING job_id`,
      [jobId, leaseToken, status, errorCode, renderDeployId],
    );
    return Boolean(result?.rows?.length);
  } catch {
    throw new DeploymentQueueError('database_operation_failed');
  }
}
