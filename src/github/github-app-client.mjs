import { createPrivateKey, sign } from 'node:crypto';

const API_ORIGIN = 'https://api.github.com';

function configError() { return new TypeError('Invalid GitHub App client configuration.'); }

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function createAppJwt(appId, privateKey, nowSeconds) {
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({ iss: appId, iat: nowSeconds - 60, exp: nowSeconds + 540 }));
  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), createPrivateKey(privateKey));
  return `${signingInput}.${signature.toString('base64url')}`;
}

export function createGitHubAppClient({ appId, privateKey, installationId, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  if (typeof appId !== 'string' || !/^\d+$/.test(appId) || typeof privateKey !== 'string' || privateKey.length < 100 ||
      !Number.isSafeInteger(installationId) || installationId <= 0 || typeof fetchImpl !== 'function') throw configError();
  let installationToken;
  let tokenExpiresAt = 0;

  async function request(path, token, options = {}) {
    let response;
    try {
      response = await fetchImpl(`${API_ORIGIN}${path}`, {
        ...options,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
      });
    } catch {
      throw new Error('GitHub App request failed.');
    }
    if (!response.ok) throw new Error('GitHub App request failed.');
    try { return await response.json(); } catch { throw new Error('GitHub App response was invalid.'); }
  }

  async function getInstallationToken() {
    if (installationToken && tokenExpiresAt - now() > 60_000) return installationToken;
    const jwt = createAppJwt(appId, privateKey, Math.floor(now() / 1000));
    const tokenInfo = await request(`/app/installations/${installationId}/access_tokens`, jwt, {
      method: 'POST', body: JSON.stringify({}),
    });
    if (typeof tokenInfo.token !== 'string' || !tokenInfo.token || typeof tokenInfo.expires_at !== 'string') throw new Error('GitHub App token response was invalid.');
    installationToken = tokenInfo.token;
    tokenExpiresAt = Date.parse(tokenInfo.expires_at);
    if (!Number.isFinite(tokenExpiresAt)) throw new Error('GitHub App token response was invalid.');
    return installationToken;
  }

  async function listRepositories() {
    const token = await getInstallationToken();
    const repositories = [];
    for (let page = 1; page <= 100; page++) {
      const result = await request(`/installation/repositories?per_page=100&page=${page}`, token);
      if (!Array.isArray(result.repositories)) throw new Error('GitHub repository response was invalid.');
      for (const repo of result.repositories) {
        if (!Number.isSafeInteger(repo.id) || repo.id <= 0 || typeof repo.full_name !== 'string' ||
            typeof repo.private !== 'boolean' || typeof repo.default_branch !== 'string') throw new Error('GitHub repository response was invalid.');
        repositories.push(Object.freeze({ id: repo.id, fullName: repo.full_name, private: repo.private, defaultBranch: repo.default_branch }));
      }
      if (result.repositories.length < 100) return Object.freeze(repositories);
    }
    throw new Error('GitHub repository pagination exceeded its safety limit.');
  }

  async function listBranches(repository) {
    if (!repository || !Number.isSafeInteger(repository.id) || repository.id <= 0 ||
        typeof repository.fullName !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.fullName)) throw configError();
    const token = await getInstallationToken();
    const branches = [];
    for (let page = 1; page <= 100; page++) {
      const result = await request(`/repos/${repository.fullName}/branches?per_page=100&page=${page}`, token);
      if (!Array.isArray(result)) throw new Error('GitHub branch response was invalid.');
      for (const branch of result) {
        if (typeof branch.name !== 'string' || !branch.commit || typeof branch.commit.sha !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(branch.commit.sha)) throw new Error('GitHub branch response was invalid.');
        branches.push(Object.freeze({ name: branch.name, commitSha: branch.commit.sha.toLowerCase() }));
      }
      if (result.length < 100) return Object.freeze(branches);
    }
    throw new Error('GitHub branch pagination exceeded its safety limit.');
  }

  async function getRepositoryFile(repositoryName, path, ref) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName) ||
        typeof path !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(path) || path.startsWith('/') || path.split('/').includes('..') ||
        typeof ref !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(ref)) throw configError();
    const token = await getInstallationToken();
    const result = await request(`/repos/${repositoryName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, token);
    if (result.type !== 'file' || result.encoding !== 'base64' || typeof result.content !== 'string' || result.content.length > 2_000_000) throw new Error('GitHub repository file was not available.');
    try { return Buffer.from(result.content.replace(/\n/g, ''), 'base64').toString('utf8'); } catch { throw new Error('GitHub repository file was invalid.'); }
  }

  async function createCheckRun(repositoryName, commitSha, name, status, conclusion, detailsUrl) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName) || !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(commitSha) ||
        typeof name !== 'string' || name.length > 100) throw configError();
    const token = await getInstallationToken();
    return request(`/repos/${repositoryName}/check-runs`, token, {
      method: 'POST', body: JSON.stringify({ name, head_sha: commitSha, status, ...(conclusion ? { conclusion } : {}), ...(detailsUrl ? { details_url: detailsUrl } : {}) }),
    });
  }

  async function updateCheckRun(repositoryName, checkRunId, status, conclusion, detailsUrl) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName) || !Number.isSafeInteger(checkRunId) || checkRunId <= 0) throw configError();
    const token = await getInstallationToken();
    return request(`/repos/${repositoryName}/check-runs/${checkRunId}`, token, {
      method: 'PATCH', body: JSON.stringify({ status, ...(conclusion ? { conclusion } : {}), ...(detailsUrl ? { details_url: detailsUrl } : {}) }),
    });
  }

  return Object.freeze({ listRepositories, listBranches, getRepositoryFile, createCheckRun, updateCheckRun });
}
