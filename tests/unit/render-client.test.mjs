import assert from 'node:assert/strict';
import test from 'node:test';

import { createRenderClient } from '../../src/deployment/render-client.mjs';

const TARGET = Object.freeze({
  name: 'uda-test-repo-12345678',
  repositoryName: 'owner/test-repo',
  branch: 'main',
  buildCommand: 'npm ci && npm test --if-present && npm run build',
  startCommand: 'npm start',
});

function service(overrides = {}) {
  return {
    id: 'srv-safe123', name: TARGET.name, ownerId: 'tea-workspace123', type: 'web_service',
    repo: 'https://github.com/owner/test-repo', branch: 'main', autoDeployTrigger: 'off',
    serviceDetails: { runtime: 'node', url: 'https://uda-test.onrender.com', envSpecificDetails: { buildCommand: TARGET.buildCommand, startCommand: TARGET.startCommand } },
    ...overrides,
  };
}

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return value; } };
}

test('creates a Web Service once with auto-deploy disabled and approved repository settings', async () => {
  const calls = [];
  const client = createRenderClient({ apiToken: 'render-test-token-long-enough', ownerId: 'tea-workspace123', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return response([]);
    return response({ service: service(), deploy: { id: 'dep-safe123' } }, 201);
  } });
  const created = await client.createApprovedService(TARGET);
  assert.equal(created.id, 'srv-safe123');
  assert.equal(created.url, 'https://uda-test.onrender.com/');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  const body = JSON.parse(calls.find(call => call.options.method === 'POST').options.body);
  assert.equal(body.autoDeployTrigger, 'off');
  assert.equal(body.repo, 'https://github.com/owner/test-repo');
});

test('reconciles uncertain creation by exact-name lookup and never repeats POST', async () => {
  let posts = 0;
  const client = createRenderClient({ apiToken: 'render-test-token-long-enough', ownerId: 'tea-workspace123', fetchImpl: async (url, options) => {
    if (options.method === 'GET') return response([{ service: service(), cursor: '' }]);
    posts++;
    throw new Error('uncertain response');
  } });
  // A matching existing service is reconciled before the create call.
  const found = await client.createApprovedService(TARGET);
  assert.equal(found.id, 'srv-safe123');
  assert.equal(posts, 0);
});

test('refuses same-name service with repository or branch mismatch', async () => {
  const client = createRenderClient({ apiToken: 'render-test-token-long-enough', ownerId: 'tea-workspace123', fetchImpl: async () => response([{ service: service({ repo: 'https://github.com/other/repo' }), cursor: '' }]) });
  await assert.rejects(client.createApprovedService(TARGET), /identity or configuration/);
});

test('enables push deploys only with a verified service response', async () => {
  const client = createRenderClient({ apiToken: 'render-test-token-long-enough', ownerId: 'tea-workspace123', fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).autoDeployTrigger, 'commit');
    return response({ service: service({ autoDeployTrigger: 'commit' }) });
  } });
  assert.equal((await client.enablePushDeploys('srv-safe123', TARGET)).autoDeployTrigger, 'commit');
});

test('waits for the latest exact commit and rejects an arbitrary live URL', async () => {
  let calls = 0;
  const client = createRenderClient({ apiToken: 'render-test-token-long-enough', ownerId: 'tea-workspace123', fetchImpl: async url => {
    if (url.includes('/deploys?')) {
      calls++;
      return response([{ deploy: { id: 'dep-safe123', status: 'live', commit: { id: 'a'.repeat(40) }, createdAt: '2026-01-02T00:00:00Z' }, cursor: '' }]);
    }
    return { ok: true, status: 200 };
  } });
  const deployed = await client.waitForCommit('srv-safe123', 'a'.repeat(40), { timeoutMs: 100, pollMs: 1 });
  assert.equal(deployed.status, 'live');
  assert.equal(calls, 1);
  assert.equal(await client.verifyLiveUrl('https://uda-test.onrender.com'), 'https://uda-test.onrender.com/');
  await assert.rejects(client.verifyLiveUrl('https://attacker.example'), /invalid/);
});
