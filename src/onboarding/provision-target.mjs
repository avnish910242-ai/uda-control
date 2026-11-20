import { randomUUID } from 'node:crypto';

import { registerProvisioningTarget, activateProvisionedTarget } from '../persistence/deployment-target-repository.mjs';
import { isProtectedRepositoryName } from '../security/repository-scope.mjs';

const BUILD_COMMAND = 'npm ci && npm test --if-present && npm run build';
const START_COMMAND = 'npm start';

function fail(message) { throw new Error(message); }

function detectNodeProfile(packageJsonText, lockText) {
  let pkg;
  try { pkg = JSON.parse(packageJsonText); } catch { fail('Repository package.json is invalid.'); }
  if (!pkg || typeof pkg !== 'object' || !pkg.scripts || typeof pkg.scripts.build !== 'string' ||
      typeof pkg.scripts.start !== 'string' || typeof lockText !== 'string' || lockText.length < 2) {
    fail('Unsupported repository: UDA currently requires Node.js, package-lock.json, build, and start scripts.');
  }
  return Object.freeze({ runtimeProfile: 'node-npm', buildCommand: BUILD_COMMAND, startCommand: START_COMMAND });
}

export async function provisionRepository({ pool, github, render, repository, branch, approvalPhrase, renderOwnerId }) {
  if (!pool || typeof pool.query !== 'function' || !github || !render ||
      !repository || !Number.isSafeInteger(repository.id) || typeof repository.fullName !== 'string' ||
      typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
      typeof renderOwnerId !== 'string' || !/^tea-[a-z0-9]+$/.test(renderOwnerId)) {
    fail('Invalid first-deployment target configuration.');
  }
  if (isProtectedRepositoryName(repository.fullName)) fail('Protected repositories are not eligible for UDA.');
  const branches = await github.listBranches(repository);
  const selectedBranch = branches.find(item => item.name === branch);
  if (!selectedBranch) fail('Selected branch was not found in the GitHub App installation.');
  const expectedApproval = `DEPLOY ${repository.fullName}@${branch} ${selectedBranch.commitSha} TO RENDER`;
  if (approvalPhrase !== expectedApproval) fail('First-deployment approval did not match the exact target and commit.');

  const [packageJson, lockText] = await Promise.all([
    github.getRepositoryFile(repository.fullName, 'package.json', selectedBranch.commitSha),
    github.getRepositoryFile(repository.fullName, 'package-lock.json', selectedBranch.commitSha),
  ]);
  const profile = detectNodeProfile(packageJson, lockText);
  const short = String(repository.id).slice(-8);
  const slug = repository.fullName.split('/')[1].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 38) || 'site';
  const renderServiceName = `uda-${slug}-${short}`.slice(0, 63);
  const target = {
    repositoryId: repository.id,
    repositoryName: repository.fullName,
    branchRef: `refs/heads/${branch}`,
    installationId: repository.installationId,
    renderOwnerId,
    renderServiceName,
    runtimeProfile: profile.runtimeProfile,
    buildCommand: profile.buildCommand,
    startCommand: profile.startCommand,
    approvalId: randomUUID(),
    targetStatus: 'provisioning',
  };
  if (!Number.isSafeInteger(target.installationId) || target.installationId <= 0) fail('Repository is missing its trusted GitHub App installation ID.');

  await registerProvisioningTarget(pool, target);
  const renderTarget = {
    name: target.renderServiceName,
    repositoryName: target.repositoryName,
    branch,
    buildCommand: target.buildCommand,
    startCommand: target.startCommand,
  };
  const existingService = await render.findService(target.renderServiceName);
  let service;
  if (existingService) {
    try { service = render.verifyService(existingService, renderTarget, 'off'); }
    catch { service = render.verifyService(existingService, renderTarget, 'commit'); }
  } else {
    service = await render.createApprovedService(renderTarget);
  }

  const deploy = await render.waitForCommit(service.id, selectedBranch.commitSha);
  if (String(deploy.commit?.id || deploy.commitId || '').toLowerCase() !== selectedBranch.commitSha.toLowerCase()) fail('Initial Render deployment did not match the explicitly approved commit.');
  const liveUrl = await render.verifyLiveUrl(service.url || service.serviceDetails?.url);
  if ((service.autoDeployTrigger || 'off') !== 'commit') service = await render.enablePushDeploys(service.id, renderTarget);
  const activated = await activateProvisionedTarget(pool, target, { id: service.id, url: liveUrl });
  if (!activated) fail('First deployment succeeded but the approved target could not be activated.');
  return Object.freeze({ repository: target.repositoryName, branch, commitSha: selectedBranch.commitSha, renderServiceId: service.id, liveUrl });
}
