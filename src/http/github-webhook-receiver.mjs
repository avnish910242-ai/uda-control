import { createServer } from 'node:http';

import { enqueueVerifiedPush, DeploymentQueueError } from '../persistence/deployment-queue-repository.mjs';
import { findActiveDeploymentTarget } from '../persistence/deployment-target-repository.mjs';
import { createGitHubPushVerifier, WebhookVerificationError } from '../security/github-webhook-verifier.mjs';

const WEBHOOK_PATH = '/github/webhook';
const HEALTH_PATH = '/healthz';
const DEFAULT_PORT = 3000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

function invalidConfiguration() {
  return new TypeError('Invalid GitHub webhook receiver configuration.');
}

function parsePort(value) {
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) throw invalidConfiguration();
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw invalidConfiguration();
  return port;
}

/** Reads receiver settings without including their values in validation errors. */
export function readGitHubWebhookReceiverConfiguration(env = process.env) {
  if (!env || typeof env !== 'object') throw invalidConfiguration();
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET;
  if (typeof webhookSecret !== 'string' || Buffer.byteLength(webhookSecret, 'utf8') < 32 ||
      typeof env.DATABASE_URL !== 'string' || !env.DATABASE_URL.trim()) throw invalidConfiguration();

  let maxBodyBytes = DEFAULT_MAX_BODY_BYTES;
  if (env.GITHUB_WEBHOOK_MAX_BODY_BYTES !== undefined) {
    if (typeof env.GITHUB_WEBHOOK_MAX_BODY_BYTES !== 'string' || !/^\d+$/.test(env.GITHUB_WEBHOOK_MAX_BODY_BYTES)) {
      throw invalidConfiguration();
    }
    maxBodyBytes = Number(env.GITHUB_WEBHOOK_MAX_BODY_BYTES);
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > 10_485_760) {
      throw invalidConfiguration();
    }
  }

  return Object.freeze({
    webhookSecret,
    maxBodyBytes,
    port: parsePort(env.PORT ?? String(DEFAULT_PORT)),
  });
}

function sendJson(response, statusCode, value, closeConnection = false) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  if (closeConnection) response.setHeader('connection', 'close');
  response.end(JSON.stringify(value));
}

function rejectAndClose(request, response, statusCode, result) {
  // The verifier deliberately pauses oversized streams; terminate after the
  // response is sent so the adapter never drains or buffers the remaining body.
  response.once('finish', () => {
    if (!request.destroyed) request.destroy();
  });
  sendJson(response, statusCode, result, true);
}

function verificationResponse(error) {
  if (error instanceof WebhookVerificationError) {
    return { statusCode: error.statusCode, body: { accepted: false, error: error.code } };
  }
  if (error instanceof DeploymentQueueError) {
    if (error.code === 'delivery_id_conflict') {
      return { statusCode: 409, body: { accepted: false, error: 'delivery_conflict' } };
    }
    if (error.code === 'database_operation_failed') {
      return { statusCode: 503, body: { accepted: false, error: 'temporarily_unavailable' } };
    }
  }
  return { statusCode: 500, body: { accepted: false, error: 'request_failed' } };
}

function assertPool(pool) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') throw invalidConfiguration();
}

/** Creates an HTTP server for a single configured repository/branch. */
export function createGitHubWebhookReceiver({ pool, configuration, resolveTarget }) {
  assertPool(pool);
  let verifyPush;
  try {
    verifyPush = createGitHubPushVerifier({ ...configuration, ...(resolveTarget ? { resolveTarget } : {}) });
  } catch {
    throw invalidConfiguration();
  }

  const server = createServer(async (request, response) => {
    if (request.url === HEALTH_PATH) {
      if (request.method !== 'GET') {
        rejectAndClose(request, response, 405, { status: 'method_not_allowed' });
        return;
      }
      try {
        await pool.query('SELECT 1');
        sendJson(response, 200, { status: 'ok' });
      } catch {
        sendJson(response, 503, { status: 'unavailable' });
      }
      return;
    }

    if (request.url !== WEBHOOK_PATH || request.method !== 'POST') {
      rejectAndClose(request, response, request.url === WEBHOOK_PATH ? 405 : 404, { accepted: false });
      return;
    }

    try {
      const verifiedPush = await verifyPush(request);
      const result = await enqueueVerifiedPush(pool, verifiedPush);
      sendJson(response, 202, {
        accepted: true,
        duplicate: Boolean(result.duplicateDelivery || result.duplicateJob),
      });
    } catch (error) {
      const mapped = verificationResponse(error);
      rejectAndClose(request, response, mapped.statusCode, mapped.body);
    }
  });

  // Bound slow clients and leave the editor or other routes outside this server.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.timeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

/** Starts the receiver on Render's PORT (or 3000 for local use). */
export async function startGitHubWebhookReceiver({ pool, env = process.env, host = '0.0.0.0' }) {
  const settings = readGitHubWebhookReceiverConfiguration(env);
  const server = createGitHubWebhookReceiver({
    pool,
    configuration: {
      webhookSecret: settings.webhookSecret,
      maxBodyBytes: settings.maxBodyBytes,
    },
    resolveTarget: identity => findActiveDeploymentTarget(pool, identity),
  });

  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(settings.port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  return server;
}
