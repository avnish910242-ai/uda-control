import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import {
  createGitHubWebhookReceiver,
  readGitHubWebhookReceiverConfiguration,
  startGitHubWebhookReceiver,
} from '../../src/http/github-webhook-receiver.mjs';

const SECRET = 'offline-test-webhook-secret-that-is-long-enough';
const REPOSITORY_ID = 81234567;
const REPOSITORY_NAME = 'safe-owner/safe-repository';
const BRANCH_REF = 'refs/heads/main';
const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const DELIVERY_ID = '0b989ba4-242f-11e5-81e1-c7b6966d2516';
const JOB_ID = '2bbd6b3c-08c0-4d78-8a48-a38176607be0';

function response(rows = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function scriptedPool(steps) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      assert.equal(sql, 'SELECT 1');
      return response([{ '?column?': 1 }]);
    },
    async connect() {
      return {
        async query(sql, values = []) {
          calls.push({ sql, values });
          const step = steps.shift();
          assert.ok(step, `Unexpected queue query: ${sql}`);
          if (step.error) throw step.error;
          return step.result;
        },
        release() {},
      };
    },
  };
}

function config(overrides = {}) {
  return {
    webhookSecret: SECRET,
    repositoryId: REPOSITORY_ID,
    repositoryName: REPOSITORY_NAME,
    branchRef: BRANCH_REF,
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    repository: { id: REPOSITORY_ID, full_name: REPOSITORY_NAME },
    ref: BRANCH_REF,
    deleted: false,
    after: COMMIT_SHA,
    ...overrides,
  };
}

function signedRequestOptions(payload, headers = {}) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = createHmac('sha256', SECRET).update(rawBody).digest('hex');
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'content-length': String(rawBody.length),
      'x-github-event': 'push',
      'x-github-delivery': DELIVERY_ID,
      'x-hub-signature-256': `sha256=${signature}`,
      ...headers,
    },
  };
}

function post(server, payload, headers = {}) {
  const address = server.address();
  const signed = signedRequestOptions(payload, headers);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      path: '/github/webhook',
      method: 'POST',
      headers: signed.headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        resolve({ statusCode: response.statusCode, body });
      });
    });
    request.on('error', reject);
    request.end(signed.rawBody);
  });
}

async function withServer(pool, callback, receiverConfig = config()) {
  const server = createGitHubWebhookReceiver({ pool, configuration: receiverConfig });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await callback(server); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

function firstEnqueueSteps(deliveryId = DELIVERY_ID) {
  return [
    { result: response() },
    { result: response([{ delivery_id: deliveryId }]) },
    { result: response([{ job_id: JOB_ID }]) },
    { result: response([], 1) },
    { result: response() },
  ];
}

test('health endpoint checks database readiness without writing queue records', async () => {
  let connects = 0;
  let healthQueries = 0;
  const pool = {
    async connect() { connects++; throw new Error('must not connect'); },
    async query(sql) { healthQueries++; assert.equal(sql, 'SELECT 1'); return response([{ '?column?': 1 }]); },
  };
  await withServer(pool, async server => {
    const result = await new Promise((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port: server.address().port, path: '/healthz' }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      }).on('error', reject).end();
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, { status: 'ok' });
    assert.equal(connects, 0);
    assert.equal(healthQueries, 1);
  });
});

test('health endpoint sanitizes database failures', async () => {
  const pool = {
    async connect() { throw new Error('must not connect'); },
    async query() { throw new Error('database password must not escape'); },
  };
  await withServer(pool, async server => {
    const result = await new Promise((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port: server.address().port, path: '/healthz' }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ statusCode: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', reject).end();
    });
    assert.equal(result.statusCode, 503);
    assert.equal(result.text, '{"status":"unavailable"}');
    assert.equal(result.text.includes('password'), false);
  });
});

test('accepts a valid signed push and passes only verifier output to the existing queue', async () => {
  const pool = scriptedPool(firstEnqueueSteps());
  await withServer(pool, async server => {
    const result = await post(server, event());
    assert.equal(result.statusCode, 202);
    assert.deepEqual(result.body, { accepted: true, duplicate: false });
  });
  const deliveryInsert = pool.calls.find(call => /INSERT INTO uda_webhook_deliveries/.test(call.sql));
  assert.deepEqual(deliveryInsert.values, [DELIVERY_ID, REPOSITORY_ID, REPOSITORY_NAME, BRANCH_REF, COMMIT_SHA]);
});

test('acknowledges a redelivered delivery without creating a second job', async () => {
  const pool = scriptedPool([
    ...firstEnqueueSteps(),
    { result: response() },
    { result: response() },
    { result: response([{
      delivery_id: DELIVERY_ID,
      repository_id: String(REPOSITORY_ID),
      repository_name: REPOSITORY_NAME,
      branch_ref: BRANCH_REF,
      commit_sha: COMMIT_SHA,
      job_id: JOB_ID,
      delivery_status: 'queued',
    }]) },
    { result: response() },
  ]);
  await withServer(pool, async server => {
    const first = await post(server, event());
    const duplicate = await post(server, event());
    assert.equal(first.statusCode, 202);
    assert.deepEqual(duplicate, { statusCode: 202, body: { accepted: true, duplicate: true } });
  });
  assert.equal(pool.calls.filter(call => /INSERT INTO uda_deployment_jobs/.test(call.sql)).length, 1);
});

test('rejects invalid signatures and unsupported event types before database access', async t => {
  for (const headers of [
    { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
    { 'x-github-event': 'issues' },
  ]) {
    await t.test(JSON.stringify(headers), async () => {
      const pool = { async connect() { throw new Error('database should not be reached'); }, async query() { throw new Error('database should not be reached'); } };
      await withServer(pool, async server => {
        const result = await post(server, event(), headers);
        assert.equal(result.statusCode, headers['x-github-event'] ? 400 : 401);
        assert.equal(result.body.accepted, false);
      });
    });
  }
});

test('oversized requests receive 413 and do not reach the queue', async () => {
  let connects = 0;
  const pool = { async connect() { connects++; throw new Error('must not connect'); }, async query() { return response(); } };
  await withServer(pool, async server => {
    const result = await post(server, event());
    assert.equal(result.statusCode, 413);
    assert.equal(result.body.error, 'payload_too_large');
  }, config({ maxBodyBytes: 16 }));
  assert.equal(connects, 0);
});

test('maps a delivery ID reused for different verified event data to a conflict', async () => {
  const pool = scriptedPool([
    { result: response() },
    { result: response() },
    { result: response([{
      delivery_id: DELIVERY_ID,
      repository_id: String(REPOSITORY_ID),
      repository_name: REPOSITORY_NAME,
      branch_ref: BRANCH_REF,
      commit_sha: 'a'.repeat(40),
      job_id: JOB_ID,
      delivery_status: 'queued',
    }]) },
    { result: response() },
  ]);
  await withServer(pool, async server => {
    const result = await post(server, event());
    assert.deepEqual(result, { statusCode: 409, body: { accepted: false, error: 'delivery_conflict' } });
  });
  assert.equal(pool.calls.some(call => /INSERT INTO uda_deployment_jobs/.test(call.sql)), false);
});

test('configuration errors do not disclose secret values and PORT is parsed strictly', () => {
  const secret = 'do-not-disclose-this-webhook-secret-and-length';
  assert.throws(() => readGitHubWebhookReceiverConfiguration({ GITHUB_WEBHOOK_SECRET: secret }), error => {
    assert.equal(error.message.includes(secret), false);
    return true;
  });

  const validEnv = {
    GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_REPOSITORY_ID: String(REPOSITORY_ID),
    GITHUB_REPOSITORY_NAME: REPOSITORY_NAME,
    GITHUB_BRANCH_REF: BRANCH_REF,
    PORT: '8080',
  };
  assert.equal(readGitHubWebhookReceiverConfiguration(validEnv).port, 8080);
  assert.throws(() => readGitHubWebhookReceiverConfiguration({ ...validEnv, PORT: '8080junk' }), /configuration/);
});

test('start binds to the PORT environment variable', async () => {
  const pool = { async connect() { throw new Error('not used'); }, async query(sql) { assert.equal(sql, 'SELECT 1'); return response([{ '?column?': 1 }]); } };
  const server = await startGitHubWebhookReceiver({
    pool,
    host: '127.0.0.1',
    env: {
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_REPOSITORY_ID: String(REPOSITORY_ID),
      GITHUB_REPOSITORY_NAME: REPOSITORY_NAME,
      GITHUB_BRANCH_REF: BRANCH_REF,
      PORT: '0',
    },
  });
  try { assert.ok(server.address().port > 0); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('receiver configuration rejects weak secrets and malformed repository identity', () => {
  const pool = { connect() {}, query() {} };
  assert.throws(() => createGitHubWebhookReceiver({ pool, configuration: config({ webhookSecret: 'short' }) }), /configuration/);
  assert.throws(() => createGitHubWebhookReceiver({ pool, configuration: config({ repositoryName: 'bad/name/extra' }) }), /configuration/);
  assert.throws(() => createGitHubWebhookReceiver({ pool, configuration: config({ repositoryId: Number.MAX_SAFE_INTEGER + 1 }) }), /configuration/);
});
