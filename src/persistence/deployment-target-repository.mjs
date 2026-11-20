import { DeploymentQueueError } from './deployment-queue-repository.mjs';
import { isProtectedRepositoryName } from '../security/repository-scope.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SERVICE_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

function invalid() { throw new DeploymentQueueError('invalid_deployment_target'); }
function dbError() { throw new DeploymentQueueError('database_operation_failed'); }

function validateTarget(target, requireApproval = false) {
  if (!target || !Number.isSafeInteger(target.repositoryId) || target.repositoryId <= 0 ||
      typeof target.repositoryName !== 'string' || !REPO_PATTERN.test(target.repositoryName) ||
      typeof target.branchRef !== 'string' || !REF_PATTERN.test(target.branchRef) ||
      !Number.isSafeInteger(target.installationId) || target.installationId <= 0 ||
      typeof target.renderOwnerId !== 'string' || !/^tea-[a-z0-9]+$/.test(target.renderOwnerId) ||
      typeof target.renderServiceName !== 'string' || !SERVICE_PATTERN.test(target.renderServiceName) ||
      target.runtimeProfile !== 'node-npm' || target.buildCommand !== 'npm ci && npm test --if-present && npm run build' ||
      target.startCommand !== 'npm start' || !UUID_PATTERN.test(target.approvalId || '') ||
      (requireApproval && target.targetStatus !== 'provisioning')) invalid();
}

export async function registerProvisioningTarget(pool, target) {
  if (!pool || typeof pool.query !== 'function') invalid();
  validateTarget(target, true);
  if (isProtectedRepositoryName(target.repositoryName)) invalid();
  try {
    const result = await pool.query(
      `INSERT INTO uda_deployment_targets
         (repository_id, repository_name, branch_ref, installation_id, target_status,
          render_owner_id, render_service_name, runtime_profile, build_command,
          start_command, approval_id, approved_at)
       VALUES ($1,$2,$3,$4,'provisioning',$5,$6,$7,$8,$9,$10,clock_timestamp())
       ON CONFLICT (repository_id, branch_ref) DO UPDATE
         SET approval_id=EXCLUDED.approval_id, approved_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE uda_deployment_targets.target_status='provisioning'
           AND uda_deployment_targets.repository_name=EXCLUDED.repository_name
           AND uda_deployment_targets.installation_id=EXCLUDED.installation_id
           AND uda_deployment_targets.render_owner_id=EXCLUDED.render_owner_id
           AND uda_deployment_targets.render_service_name=EXCLUDED.render_service_name
           AND uda_deployment_targets.runtime_profile=EXCLUDED.runtime_profile
       RETURNING repository_id`,
      [target.repositoryId, target.repositoryName, target.branchRef, target.installationId,
        target.renderOwnerId, target.renderServiceName, target.runtimeProfile,
        target.buildCommand, target.startCommand, target.approvalId],
    );
    if (result?.rows?.length !== 1) throw new DeploymentQueueError('deployment_target_conflict');
    return true;
  } catch (error) {
    if (error instanceof DeploymentQueueError) throw error;
    dbError();
  }
}

export async function activateProvisionedTarget(pool, target, service) {
  if (!pool || typeof pool.query !== 'function' || !target || !service ||
      !UUID_PATTERN.test(target.approvalId || '') || typeof service.id !== 'string' ||
      !/^srv-[A-Za-z0-9]+$/.test(service.id) || typeof service.url !== 'string') invalid();
  let url;
  try { url = new URL(service.url); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname.endsWith('.onrender.com')) invalid();
  try {
    const result = await pool.query(
      `UPDATE uda_deployment_targets
       SET target_status='active', render_service_id=$2, live_url=$3,
           activated_at=clock_timestamp(), updated_at=clock_timestamp()
       WHERE repository_id=$1 AND branch_ref=$4 AND approval_id=$5
         AND target_status='provisioning'
       RETURNING repository_id`,
      [target.repositoryId, service.id, url.href, target.branchRef, target.approvalId],
    );
    return Boolean(result?.rows?.length);
  } catch { dbError(); }
}

export async function findActiveDeploymentTarget(pool, identity) {
  if (!pool || typeof pool.query !== 'function' || !identity ||
      !Number.isSafeInteger(identity.repositoryId) || identity.repositoryId <= 0 ||
      typeof identity.repositoryName !== 'string' || !REPO_PATTERN.test(identity.repositoryName) ||
      typeof identity.branchRef !== 'string' || !REF_PATTERN.test(identity.branchRef) ||
      !Number.isSafeInteger(identity.installationId) || identity.installationId <= 0) invalid();
  if (isProtectedRepositoryName(identity.repositoryName)) return null;
  try {
    const result = await pool.query(
      `SELECT repository_id, repository_name, branch_ref, installation_id, target_status,
              render_owner_id, render_service_name, render_service_id, live_url,
              runtime_profile, build_command, start_command
       FROM uda_deployment_targets
       WHERE repository_id=$1 AND branch_ref=$2 AND target_status='active'`,
      [identity.repositoryId, identity.branchRef],
    );
    if (!result?.rows?.length) return null;
    if (result.rows.length !== 1) dbError();
    const row = result.rows[0];
    if (String(row.repository_id) !== String(identity.repositoryId) || row.repository_name !== identity.repositoryName ||
        Number(row.installation_id) !== identity.installationId) return null;
    return Object.freeze({
      repositoryId: Number(row.repository_id), repositoryName: row.repository_name,
      branchRef: row.branch_ref, installationId: Number(row.installation_id),
      status: row.target_status, renderOwnerId: row.render_owner_id,
      renderServiceName: row.render_service_name, renderServiceId: row.render_service_id,
      liveUrl: row.live_url, runtimeProfile: row.runtime_profile,
      buildCommand: row.build_command, startCommand: row.start_command,
    });
  } catch (error) {
    if (error instanceof DeploymentQueueError) throw error;
    dbError();
  }
}

export async function findActiveTargetForJob(pool, job) {
  if (!pool || typeof pool.query !== 'function' || !job || !Number.isSafeInteger(Number(job.repository_id)) ||
      typeof job.repository_name !== 'string' || typeof job.branch_ref !== 'string') invalid();
  if (isProtectedRepositoryName(job.repository_name)) return null;
  try {
    const result = await pool.query(
      `SELECT repository_id, repository_name, branch_ref, installation_id, target_status,
              render_owner_id, render_service_name, render_service_id, live_url,
              runtime_profile, build_command, start_command
       FROM uda_deployment_targets
       WHERE repository_id=$1 AND repository_name=$2 AND branch_ref=$3 AND target_status='active'`,
      [job.repository_id, job.repository_name, job.branch_ref],
    );
    if (!result?.rows?.length) return null;
    if (result.rows.length !== 1) dbError();
    const row = result.rows[0];
    return Object.freeze({
      repositoryId: Number(row.repository_id), repositoryName: row.repository_name,
      branchRef: row.branch_ref, installationId: Number(row.installation_id),
      status: row.target_status, renderOwnerId: row.render_owner_id,
      renderServiceName: row.render_service_name, renderServiceId: row.render_service_id,
      liveUrl: row.live_url, runtimeProfile: row.runtime_profile,
      buildCommand: row.build_command, startCommand: row.start_command,
    });
  } catch (error) {
    if (error instanceof DeploymentQueueError) throw error;
    dbError();
  }
}
