import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { createGitHubAppClient } from '../../src/github/github-app-client.mjs';

function testClient(fetchImpl, now = () => Date.parse('2026-01-01T00:00:00Z')) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return createGitHubAppClient({ appId: '12345', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), installationId: 987, fetchImpl, now });
}

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return value; } };
}

test('mints an installation token in memory and lists installed public/private repositories', async () => {
  const calls = [];
  const client = testClient(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/app/installations/987/access_tokens')) return jsonResponse({ token: 'short-lived-test-token', expires_at: '2026-01-01T01:00:00Z' });
    if (url.endsWith('/installation/repositories?per_page=100&page=1')) return jsonResponse({ repositories: [
      { id: 55, full_name: 'owner/public-site', private: false, default_branch: 'main' },
      { id: 56, full_name: 'owner/private-site', private: true, default_branch: 'trunk' },
    ] });
    throw new Error('unexpected request');
  });

  const repos = await client.listRepositories();
  assert.deepEqual(repos.map(repo => [repo.fullName, repo.private]), [['owner/public-site', false], ['owner/private-site', true]]);
  assert.equal(JSON.stringify(repos).includes('short-lived-test-token'), false);
  assert.match(calls[0].options.headers.authorization, /^Bearer [A-Za-z0-9_.-]+$/);
  assert.match(calls[1].options.headers.authorization, /^Bearer short-lived-test-token$/);
});

test('lists branches and retrieves a pinned repository file through the installation token', async () => {
  let issuedToken = false;
  const client = testClient(async (url, options) => {
    if (url.endsWith('/app/installations/987/access_tokens')) {
      issuedToken = true;
      return jsonResponse({ token: 'temporary-token', expires_at: '2026-01-01T01:00:00Z' });
    }
    assert.equal(issuedToken, true);
    if (url.includes('/branches?')) return jsonResponse([{ name: 'main', commit: { sha: 'a'.repeat(40) } }]);
    if (url.includes('/contents/package.json?ref=')) return jsonResponse({ type: 'file', encoding: 'base64', content: Buffer.from('{"scripts":{}}').toString('base64') });
    throw new Error('unexpected request');
  });
  const repo = { id: 123, fullName: 'owner/site' };
  assert.deepEqual(await client.listBranches(repo), [{ name: 'main', commitSha: 'a'.repeat(40) }]);
  assert.equal(await client.getRepositoryFile('owner/site', 'package.json', 'a'.repeat(40)), '{"scripts":{}}');
});

test('rejects invalid repository paths and sanitizes API failures', async () => {
  const client = testClient(async () => ({ ok: false, status: 401, async json() { return { message: 'secret detail' }; } }));
  await assert.rejects(client.getRepositoryFile('owner/site', '../secret', 'a'.repeat(40)), /configuration/);
  await assert.rejects(client.listRepositories(), error => {
    assert.equal(error.message, 'GitHub App request failed.');
    assert.equal(error.message.includes('secret detail'), false);
    return true;
  });
});
