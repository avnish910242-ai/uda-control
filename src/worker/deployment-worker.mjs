import { claimNextJob, finishJob, renewJobLease } from '../persistence/deployment-queue-repository.mjs';
import { findActiveTargetForJob } from '../persistence/deployment-target-repository.mjs';
import { createGitHubAppClient } from '../github/github-app-client.mjs';
import { createRenderClient } from '../deployment/render-client.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function getEnv(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Missing required configuration: ${name}.`);
  return value;
}

export function createDeploymentWorker({ pool, env = process.env, workerId = `uda-${process.pid}`, pollIntervalMs = 5_000 }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function' ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 60_000) {
    throw new TypeError('Invalid deployment worker configuration.');
  }

  async function processJob(job) {
    const target = await findActiveTargetForJob(pool, job);
    if (!target) {
      await finishJob(pool, { jobId: job.job_id, leaseToken: job.leaseToken, status: 'failed', errorCode: 'target_not_active' });
      return;
    }

    const github = createGitHubAppClient({
      appId: getEnv(env, 'GITHUB_APP_ID'),
      privateKey: getEnv(env, 'GITHUB_APP_PRIVATE_KEY'),
      installationId: target.installationId,
    });
    const render = createRenderClient({ apiToken: getEnv(env, 'RENDER_API_TOKEN'), ownerId: target.renderOwnerId });
    const check = await github.createCheckRun(target.repositoryName, job.commit_sha, 'UDA Render deployment', 'in_progress');
    if (!Number.isSafeInteger(check.id) || check.id <= 0) throw new Error('GitHub Check Run response was invalid.');

    try {
      const service = await render.findService(target.renderServiceName);
      if (!service || service.id !== target.renderServiceId) throw new Error('Registered Render service could not be verified.');
      const verifiedService = render.verifyService(service, {
        name: target.renderServiceName,
        repositoryName: target.repositoryName,
        branch: target.branchRef.replace(/^refs\/heads\//, ''),
        buildCommand: target.buildCommand,
        startCommand: target.startCommand,
      }, 'commit');
      if (verifiedService.url !== target.liveUrl) throw new Error('Registered Render live URL no longer matches the service.');
      const deploy = await render.waitForCommit(target.renderServiceId, job.commit_sha, {
        onPoll: async () => {
          const renewed = await renewJobLease(pool, {
            jobId: job.job_id, leaseToken: job.leaseToken, executionStage: 'polling', leaseSeconds: 300,
          });
          if (!renewed) throw new Error('Deployment job lease was lost.');
        },
      });
      const liveUrl = await render.verifyLiveUrl(target.liveUrl);
      await github.updateCheckRun(target.repositoryName, check.id, 'completed', 'success', liveUrl);
      await finishJob(pool, { jobId: job.job_id, leaseToken: job.leaseToken, status: 'succeeded', renderDeployId: deploy.id });
    } catch (error) {
      const code = /Render deployment failed/.test(error.message) ? 'render_deployment_failed' :
        /Timed out/.test(error.message) ? 'render_timeout' : 'deployment_reconciliation_required';
      try { await github.updateCheckRun(target.repositoryName, check.id, 'completed', 'failure'); } catch { /* reporting is retried with reconciliation */ }
      await finishJob(pool, {
        jobId: job.job_id,
        leaseToken: job.leaseToken,
        status: code === 'deployment_reconciliation_required' ? 'needs_reconciliation' : 'failed',
        errorCode: code,
      });
    }
  }

  async function runOnce() {
    const job = await claimNextJob(pool, { workerId, leaseSeconds: 300 });
    if (!job) return false;
    try {
      await processJob(job);
    } catch {
      // Reclaim unexpected failures through the queue's fenced reconciliation path.
      await finishJob(pool, {
        jobId: job.job_id,
        leaseToken: job.leaseToken,
        status: 'needs_reconciliation',
        errorCode: 'worker_execution_failed',
      });
      throw new Error('Worker execution failed safely.');
    }
    return true;
  }

  async function run({ signal } = {}) {
    while (!signal?.aborted) {
      try {
        const didWork = await runOnce();
        if (!didWork) await sleep(pollIntervalMs);
      } catch {
        // Keep the worker alive. Errors remain sanitized by the queue/client boundaries.
        process.stderr.write('UDA worker iteration failed safely; the job will be reconciled from its durable lease.\n');
        await sleep(Math.min(pollIntervalMs * 2, 30_000));
      }
    }
  }

  return Object.freeze({ runOnce, run });
}
