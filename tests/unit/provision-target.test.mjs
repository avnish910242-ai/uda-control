import assert from 'node:assert/strict';
import test from 'node:test';

import { provisionRepository } from '../../src/onboarding/provision-target.mjs';

const SHA = 'a'.repeat(40);
const REPOSITORY = { id: 123456789, fullName: 'owner/a-new-site', installationId: 87654321 };
const PHRASE = `DEPLOY ${REPOSITORY.fullName}@main ${SHA} TO RENDER`;

function github() {
  return {
    async listBranches() { return [{ name: 'main', commitSha: SHA }]; },
    async getRepositoryFile(_repo, path, ref) {
      assert.equal(ref, SHA);
      return path === 'package.json' ? JSON.stringify({ scripts: { build: 'build', start: 'start' } }) : '{"lockfileVersion":3}';
    },
  };
}

test('requires approval bound to exact repository, branch and current SHA before side effects', async () => {
  let dbCalls = 0;
  let renderCalls = 0;
  await assert.rejects(provisionRepository({
    pool: { async query() { dbCalls++; } }, github: github(), render: { async findService() { renderCalls++; } },
    repository: REPOSITORY, branch: 'main', approvalPhrase: 'approve', renderOwnerId: 'tea-workspace123',
  }), /approval did not match/);
  assert.equal(dbCalls, 0);
  assert.equal(renderCalls, 0);
});

test('blocks protected repositories before GitHub, registry or Render access', async () => {
  let touched = false;
  await assert.rejects(provisionRepository({
    pool: { async query() { touched = true; } },
    github: { async listBranches() { touched = true; return []; } },
    render: { async findService() { touched = true; } },
    repository: { ...REPOSITORY, fullName: 'owner/Nova' }, branch: 'main', approvalPhrase: PHRASE,
    renderOwnerId: 'tea-workspace123',
  }), /Protected repositories/);
  assert.equal(touched, false);
});

test('rejects unsupported repositories before registry or Render side effects', async () => {
  let dbCalls = 0;
  const unsupported = { ...github(), async getRepositoryFile(_repo, path) { return path === 'package.json' ? '{"scripts":{}}' : '{}'; } };
  await assert.rejects(provisionRepository({
    pool: { async query() { dbCalls++; } }, github: unsupported, render: {}, repository: REPOSITORY,
    branch: 'main', approvalPhrase: PHRASE, renderOwnerId: 'tea-workspace123',
  }), /currently requires Node.js/);
  assert.equal(dbCalls, 0);
});

test('uses an exact repository commit and activates push automation only after verification', async () => {
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ kind: 'db', sql, values });
    return { rows: [{ repository_id: REPOSITORY.id }] };
  } };
  const render = {
    async findService() { calls.push({ kind: 'lookup' }); return null; },
    async createApprovedService(target) { calls.push({ kind: 'create', target }); return { id: 'srv-abc123', name: target.name, url: 'https://site.onrender.com/', autoDeployTrigger: 'off' }; },
    async waitForCommit(_id, sha) { calls.push({ kind: 'wait', sha }); return { id: 'dep-abc123', status: 'live', commit: { id: sha } }; },
    async verifyLiveUrl(url) { calls.push({ kind: 'live', url }); return url; },
    async enablePushDeploys(_id, target) { calls.push({ kind: 'enable', target }); return { id: 'srv-abc123', name: target.name, url: 'https://site.onrender.com/', autoDeployTrigger: 'commit' }; },
  };
  const result = await provisionRepository({ pool, github: github(), render, repository: REPOSITORY, branch: 'main', approvalPhrase: PHRASE, renderOwnerId: 'tea-workspace123' });
  assert.equal(result.commitSha, SHA);
  assert.equal(result.liveUrl, 'https://site.onrender.com/');
  assert.deepEqual(calls.filter(call => ['lookup', 'create', 'wait', 'live', 'enable'].includes(call.kind)).map(call => call.kind), ['lookup', 'create', 'wait', 'live', 'enable']);
  assert.equal(calls.find(call => call.kind === 'wait').sha, SHA);
});

test('does not activate a mismatched first deployment commit', async () => {
  let activated = false;
  const pool = { async query(sql) { if (sql.startsWith('UPDATE uda_deployment_targets')) activated = true; return { rows: [{ repository_id: REPOSITORY.id }] }; } };
  const render = {
    async findService() { return null; }, async createApprovedService(target) { return { id: 'srv-abc123', url: 'https://site.onrender.com/', autoDeployTrigger: 'off', name: target.name }; },
    async waitForCommit() { return { id: 'dep-abc123', commit: { id: 'b'.repeat(40) } }; },
  };
  await assert.rejects(provisionRepository({ pool, github: github(), render, repository: REPOSITORY, branch: 'main', approvalPhrase: PHRASE, renderOwnerId: 'tea-workspace123' }), /did not match/);
  assert.equal(activated, false);
});
