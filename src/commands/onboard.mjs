import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { createGitHubAppClient } from '../github/github-app-client.mjs';
import { createRenderClient } from '../deployment/render-client.mjs';
import { provisionRepository } from '../onboarding/provision-target.mjs';
import { createPostgresPool, closePostgresPool } from '../runtime/postgres.mjs';
import { isProtectedRepositoryName } from '../security/repository-scope.mjs';

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Missing required configuration: ${name}.`);
  return value;
}

const env = process.env;
const pool = await createPostgresPool(env);
const terminal = createInterface({ input: stdin, output: stdout });
try {
  const installationId = Number(required(env, 'GITHUB_APP_INSTALLATION_ID'));
  const github = createGitHubAppClient({ appId: required(env, 'GITHUB_APP_ID'), privateKey: required(env, 'GITHUB_APP_PRIVATE_KEY'), installationId });
  const render = createRenderClient({ apiToken: required(env, 'RENDER_API_TOKEN'), ownerId: required(env, 'UDA_RENDER_OWNER_ID') });
  const repositories = (await github.listRepositories()).filter(repo => {
    return !isProtectedRepositoryName(repo.fullName, env.UDA_PROTECTED_REPOSITORIES || '');
  });
  if (!repositories.length) throw new Error('No eligible repositories are available in this GitHub App installation.');
  repositories.forEach((repo, index) => stdout.write(`${index + 1}. ${repo.fullName}${repo.private ? ' [private]' : ' [public]'}\n`));
  const repoIndex = Number(await terminal.question('Select repository number: ')) - 1;
  if (!Number.isSafeInteger(repoIndex) || repoIndex < 0 || repoIndex >= repositories.length) throw new Error('Repository selection is invalid.');
  const repository = { ...repositories[repoIndex], installationId };
  const branches = await github.listBranches(repository);
  if (!branches.length) throw new Error('Selected repository has no branches.');
  branches.forEach((branch, index) => stdout.write(`${index + 1}. ${branch.name} (${branch.commitSha.slice(0, 12)})\n`));
  const branchIndex = Number(await terminal.question('Select branch number: ')) - 1;
  if (!Number.isSafeInteger(branchIndex) || branchIndex < 0 || branchIndex >= branches.length) throw new Error('Branch selection is invalid.');
  const branch = branches[branchIndex];
  const approval = `DEPLOY ${repository.fullName}@${branch.name} ${branch.commitSha} TO RENDER`;
  stdout.write(`\nRepository: ${repository.fullName}\nBranch: ${branch.name}\nCommit: ${branch.commitSha}\nFirst deployment creates Render service in the configured UDA workspace.\n`);
  const typed = await terminal.question(`Type exactly to approve first deployment: ${approval}\n`);
  const result = await provisionRepository({
    pool, github, render, repository, branch: branch.name,
    approvalPhrase: typed,
    renderOwnerId: required(env, 'UDA_RENDER_OWNER_ID'),
  });
  stdout.write(`Initial deployment verified: ${result.liveUrl}\nFuture pushes to ${result.repository}@${result.branch} will auto-deploy.\n`);
} catch (error) {
  stderrWrite('Onboarding failed safely. Check configuration, repository eligibility, and deployment status.');
  process.exitCode = 1;
} finally {
  terminal.close();
  await closePostgresPool(pool);
}

function stderrWrite(message) { process.stderr.write(`${message}\n`); }
