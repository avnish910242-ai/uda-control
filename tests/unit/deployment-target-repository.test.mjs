import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activateProvisionedTarget,
  findActiveDeploymentTarget,
  registerProvisioningTarget,
} from '../../src/persistence/deployment-target-repository.mjs';

const TARGET = {
  repositoryId: 12345,
  repositoryName: 'owner/site',
  branchRef: 'refs/heads/main',
  installationId: 67890,
  renderOwnerId: 'tea-workspace123',
  renderServiceName: 'uda-site-12345',
  runtimeProfile: 'node-npm',
  buildCommand: 'npm ci && npm test --if-present && npm run build',
  startCommand: 'npm start',
  approvalId: 'cb2fa821-f047-4e7b-8c23-dad180421951',
  targetStatus: 'provisioning',
};

test('registers only validated provisioning targets with parameterized values', async () => {
  let captured;
  const pool = { async query(sql, values) { captured = { sql, values }; return { rows: [{ repository_id: 12345 }] }; } };
  assert.equal(await registerProvisioningTarget(pool, TARGET), true);
  assert.match(captured.sql, /ON CONFLICT \(repository_id, branch_ref\)/);
  assert.ok(captured.sql.includes('$1') && captured.sql.includes('$10'));
  assert.deepEqual(captured.values, [12345, 'owner/site', 'refs/heads/main', 67890, 'tea-workspace123', 'uda-site-12345', 'node-npm', TARGET.buildCommand, 'npm start', TARGET.approvalId]);
});

test('rejects a provisioning conflict without leaking database details', async () => {
  const pool = { async query() { return { rows: [] }; } };
  await assert.rejects(registerProvisioningTarget(pool, TARGET), error => error.code === 'deployment_target_conflict');
  await assert.rejects(registerProvisioningTarget({ query: async () => { throw new Error('password=secret'); } }, TARGET), error => {
    assert.equal(error.message.includes('secret'), false);
    return error.code === 'database_operation_failed';
  });
});

test('activates only an HTTPS onrender.com URL and the same approval fence', async () => {
  let values;
  const pool = { async query(_sql, params) { values = params; return { rows: [{ repository_id: 12345 }] }; } };
  assert.equal(await activateProvisionedTarget(pool, TARGET, { id: 'srv-Abc123', url: 'https://site.onrender.com' }), true);
  assert.deepEqual(values, [12345, 'srv-Abc123', 'https://site.onrender.com/', 'refs/heads/main', TARGET.approvalId]);
  await assert.rejects(activateProvisionedTarget(pool, TARGET, { id: 'srv-Abc123', url: 'https://attacker.example' }), /invalid_deployment_target/);
});

test('routes only exact active repository, branch and installation identity', async () => {
  let values;
  const row = {
    repository_id: '12345', repository_name: 'owner/site', branch_ref: 'refs/heads/main', installation_id: '67890',
    target_status: 'active', render_owner_id: 'tea-workspace123', render_service_name: 'uda-site-12345',
    render_service_id: 'srv-Abc123', live_url: 'https://site.onrender.com/', runtime_profile: 'node-npm',
    build_command: TARGET.buildCommand, start_command: 'npm start',
  };
  const pool = { async query(_sql, params) { values = params; return { rows: [row] }; } };
  const result = await findActiveDeploymentTarget(pool, { repositoryId: 12345, repositoryName: 'owner/site', branchRef: 'refs/heads/main', installationId: 67890 });
  assert.equal(result.status, 'active');
  assert.deepEqual(values, [12345, 'refs/heads/main']);
  assert.equal(await findActiveDeploymentTarget(pool, { repositoryId: 12345, repositoryName: 'owner/site', branchRef: 'refs/heads/main', installationId: 67891 }), null);
});
