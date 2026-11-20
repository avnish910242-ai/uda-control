const API = 'https://api.render.com/v1';
const SERVICE_ID = /^srv-[A-Za-z0-9]+$/;

function configError() { return new TypeError('Invalid Render client configuration.'); }

export function createRenderClient({ apiToken, ownerId, fetchImpl = globalThis.fetch, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (typeof apiToken !== 'string' || apiToken.length < 20 || typeof ownerId !== 'string' || !/^tea-[a-z0-9]+$/.test(ownerId) || typeof fetchImpl !== 'function') throw configError();

  async function request(url, options = {}, json = true) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        method: options.method || 'GET',
        headers: { authorization: `Bearer ${apiToken}`, accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
      });
    } catch { throw new Error('Render API request failed.'); }
    if (!response.ok) throw new Error(`Render API returned HTTP ${response.status}.`);
    if (!json) return response;
    try { return await response.json(); } catch { throw new Error('Render API response was invalid.'); }
  }

  function verifyService(service, expected, requiredAutoDeploy = 'off') {
    const detail = service?.serviceDetails || service;
    const autoDeploy = service?.autoDeployTrigger || (service?.autoDeploy === 'yes' ? 'commit' : 'off');
    if (!service || service.name !== expected.name || service.ownerId !== ownerId || service.type !== 'web_service' ||
        service.repo !== `https://github.com/${expected.repositoryName}` || service.branch !== expected.branch ||
        detail.runtime !== 'node' || detail.envSpecificDetails?.buildCommand !== expected.buildCommand ||
        detail.envSpecificDetails?.startCommand !== expected.startCommand || !SERVICE_ID.test(service.id || '') || autoDeploy !== requiredAutoDeploy) {
      throw new Error('Render service identity or configuration did not match the approved target.');
    }
    const url = detail.url || service.url;
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Render service URL was invalid.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname.endsWith('.onrender.com')) throw new Error('Render service URL was invalid.');
    return Object.freeze({ id: service.id, name: service.name, url: parsed.href, autoDeployTrigger: autoDeploy });
  }

  async function findService(name) {
    const url = new URL(`${API}/services`);
    url.searchParams.set('name', name);
    url.searchParams.set('ownerId', ownerId);
    url.searchParams.set('limit', '100');
    url.searchParams.set('includePreviews', 'false');
    const results = await request(url.href);
    if (!Array.isArray(results)) throw new Error('Render service lookup was invalid.');
    const matches = results.map(x => x.service || x).filter(s => s.name === name && s.ownerId === ownerId);
    if (matches.length > 1) throw new Error('Multiple same-name Render services exist; refusing to choose.');
    return matches[0] || null;
  }

  function serviceName(target) {
    const name = target?.renderServiceName || target?.name;
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) throw configError();
    return name;
  }

  async function createApprovedService(target) {
    const name = serviceName(target);
    const expected = { ...target, name };
    const found = await findService(name);
    if (found) return verifyService(found, expected, 'off');
    const body = {
      type: 'web_service', name, ownerId,
      repo: `https://github.com/${target.repositoryName}`, branch: target.branch,
      autoDeployTrigger: 'off',
      serviceDetails: { runtime: 'node', envSpecificDetails: { buildCommand: target.buildCommand, startCommand: target.startCommand } },
    };
    let created;
    try {
      created = await request(`${API}/services`, { method: 'POST', body: JSON.stringify(body) });
    } catch {
      // The create result may be ambiguous. Reconcile once by exact name; never POST twice.
      const reconciled = await findService(name);
      if (!reconciled) throw new Error('Render service creation outcome is uncertain; no retry was attempted.');
      return verifyService(reconciled, expected);
    }
    return verifyService(created.service || created, expected, 'off');
  }

  async function enablePushDeploys(serviceId, target) {
    if (!SERVICE_ID.test(serviceId || '')) throw configError();
    const response = await request(`${API}/services/${encodeURIComponent(serviceId)}`, {
      method: 'PATCH', body: JSON.stringify({ autoDeployTrigger: 'commit' }),
    });
    const service = response.service || response;
    const verified = verifyService(service, target, 'commit');
    return verified;
  }

  async function listDeploys(serviceId) {
    if (!SERVICE_ID.test(serviceId || '')) throw configError();
    const items = await request(`${API}/services/${encodeURIComponent(serviceId)}/deploys?limit=100`);
    if (!Array.isArray(items)) throw new Error('Render deploy list was invalid.');
    return items.map(item => item.deploy || item).sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  }

  async function getDeploy(serviceId, deployId) {
    if (!SERVICE_ID.test(serviceId || '') || typeof deployId !== 'string' || !/^dep-[A-Za-z0-9]+$/.test(deployId)) throw configError();
    const value = await request(`${API}/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`);
    return value.deploy || value;
  }

  async function verifyLiveUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Render service URL was invalid.'); }
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.onrender.com') || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Render service URL was invalid.');
    const response = await request(parsed.href, { method: 'GET', redirect: 'manual' }, false);
    if (response.status < 200 || response.status >= 300) throw new Error(`Live URL returned HTTP ${response.status}.`);
    return parsed.href;
  }

  async function waitForCommit(serviceId, commitSha, { timeoutMs = 40 * 60_000, pollMs = 10_000, onPoll } = {}) {
    const sha = String(commitSha).toLowerCase();
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) throw configError();
    const deadline = Date.now() + timeoutMs;
    let observedId;
    while (Date.now() < deadline) {
      const latest = (await listDeploys(serviceId))[0];
      const commit = latest?.commit?.id || latest?.commitId;
      const status = String(latest?.status || '').toLowerCase();
      if (commit && commit.toLowerCase() === sha) {
        observedId = latest.id;
        if (typeof onPoll === 'function') await onPoll(latest);
        if (status === 'live') return latest;
        if (/(failed|canceled|cancelled|deactivated)/.test(status)) throw new Error(`Render deployment failed with status ${status}.`);
      }
      await delay(pollMs);
    }
    throw new Error(`Timed out waiting for Render commit ${sha}${observedId ? ` (${observedId})` : ''}.`);
  }

  return Object.freeze({ findService, verifyService, createApprovedService, enablePushDeploys, listDeploys, getDeploy, verifyLiveUrl, waitForCommit });
}
