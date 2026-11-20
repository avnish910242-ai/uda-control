# Universal Deploy Agent

UDA receives signed GitHub App push webhooks, routes only registered repository/branch targets, and observes Render's native deployment of the pushed commit. Website code is pushed manually by the repository owner. UDA never pushes website code.

The local implementation currently supports Node.js/npm repositories with a `package-lock.json`, `build` script, and `start` script. Render runs `npm ci && npm test --if-present && npm run build`; a failing test or build prevents deployment. The start command is `npm start`. Unsupported projects fail onboarding without creating a Render service.

## Local prerequisites

- Node.js 20 or newer and npm.
- A dedicated PostgreSQL database for UDA, isolated from protected databases and volumes. Do not point `DATABASE_URL` at an existing protected database.
- A GitHub App installed only on repositories eligible for UDA. Permissions: repository metadata read, contents read, checks write. Subscribe it to the `push` event. Public repositories must also be included in the installation; an account-level GitHub identity alone does not grant this App access.
- The GitHub App webhook must use the same random secret configured as `GITHUB_WEBHOOK_SECRET` (at least 32 UTF-8 bytes).
- A Render API token scoped to the intended UDA workspace, and that workspace's owner ID in `UDA_RENDER_OWNER_ID` (`tea-...`). Never put credential values in source control or command-line arguments.
- A stable HTTPS hostname routed through Cloudflare Tunnel to the receiver's local port. Route only `/github/webhook` and `/healthz`; do not publish the n8n editor or other local services.

## Install and initialize isolated storage

From `C:\Universal-Deploy-Agent`:

```powershell
npm install
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f .\sql\001_uda_deployment_queue.sql
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f .\sql\002_uda_deployment_targets.sql
```

Set environment variables using your operating system's protected secret store. Required values:

```text
DATABASE_URL
GITHUB_WEBHOOK_SECRET
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_APP_INSTALLATION_ID
RENDER_API_TOKEN
UDA_RENDER_OWNER_ID
PORT (optional; defaults to 3000)
PGSSL=true (when the isolated PostgreSQL endpoint requires TLS)
UDA_PROTECTED_REPOSITORIES (optional comma-separated full names to deny)
```

Do not paste secrets into chat, source files, README, or shell history. For a remote PostgreSQL endpoint, use TLS with certificate verification (`PGSSL=true`).

## Start receiver and worker

Run each command in its own terminal after setting the environment securely:

```powershell
npm run receiver
npm run worker
```

The receiver binds to `PORT` (default `3000`), serves `GET /healthz`, and accepts GitHub pushes only at `POST /github/webhook`. It verifies the HMAC over the original body bytes before parsing and atomically enqueues the event. The worker polls the durable queue, finds an exact active repository/branch/installation mapping, verifies the mapped Render service, and waits for a deployment of the exact webhook commit. It reports a GitHub Check Run and stores the result in the queue. Keep both processes and PostgreSQL available while deployments run. The local process does not keep working while the laptop is asleep or offline.

Cloudflare Tunnel ingress must be configured manually. Point its hostname to the receiver port and enforce path-level ingress so only the two receiver paths are routed. The receiver itself has no editor route and should not share a public hostname with n8n. Configure GitHub's webhook URL as `https://<your-host>/github/webhook`, content type `application/json`, the same webhook secret, and push events only. Do not configure the GitHub App webhook to expose a local editor or database port.

## First deployment for a repository and branch

After installing the App on the repository and ensuring the chosen branch contains the desired commit, run:

```powershell
npm run onboard
```

The CLI lists repositories visible to the configured App installation, lets you select a repository and branch, then fetches that branch's current commit and reads only `package.json` and `package-lock.json` at that SHA. It displays repository, branch, commit, and generated UDA service name. The first-time approval must be typed exactly in this form:

```text
DEPLOY <owner/repository>@<branch> <full-commit-sha> TO RENDER
```

The server-side provisioning function rechecks the branch head and approval phrase, records a provisioning fence, performs exact-name lookup in the configured Render workspace, and creates only when no match exists. A service with a mismatched owner, type, repository, branch, runtime, commands, or deploy setting is rejected. Service creation begins its first Render build with auto-deploy disabled. Only after the exact commit is live and its HTTPS `onrender.com` URL responds successfully does UDA enable Render's native commit-triggered auto-deploy and mark the mapping active. Later pushes to that registered branch deploy automatically through Render; the webhook worker reports the exact SHA and URL.

## Security and scope notes

- Repository routing is keyed by immutable GitHub repository ID, exact full name, exact `refs/heads/...`, and GitHub App installation ID. Webhook payloads cannot choose a Render service ID, workspace, or URL.
- Duplicate delivery IDs and duplicate repository/branch/commit jobs are handled by the existing atomic PostgreSQL queue. Leases allow abandoned jobs to be reconciled after worker interruption.
- The service name is derived from the repository basename and numeric repository ID; it is not a security boundary. Render owner, repo, branch, service type, Node runtime, commands, service ID, and HTTPS URL are verified independently.
- The GitHub App sees only repositories explicitly available to its installation. Install it only on eligible repositories; do not grant it access to Nova, SEASHOP, `C:\AI-Agent`, or other protected resources. The CLI also denies those protected names and any entries in `UDA_PROTECTED_REPOSITORIES` as defense in depth.
- GitHub check reporting is an App Check Run. n8n execution reporting is not implemented in this receiver/worker path; no existing n8n workflow is read or changed.
- Render's service-creation API starts the branch's initial deployment and does not provide an atomic commit pin in the create request. UDA verifies the resulting commit against the separately approved branch SHA and will not activate the mapping if they differ. The service may still have run a different branch-head build during a race; reconcile it manually before retrying. Subsequent native Render deployments are tracked against exact push SHAs.
- The legacy `deploy.ps1` and GitHub Actions workflow remain in the repository for preservation and are not the entrypoints for this GitHub App receiver/worker path. Do not run the legacy workflow as part of onboarding.

## Offline tests

```powershell
npm run test:unit
```

Tests use fake HTTP responses, fake request streams, and fake PostgreSQL interfaces. They do not contact GitHub or Render, and they do not require a live database.
