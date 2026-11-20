# Universal Deploy Agent

UDA provides a one-command, first-time Render deployment for the explicitly mapped AI Knowledge Vault website. You push website changes to GitHub yourself. UDA never reads, edits, commits, or pushes the website checkout; it deploys the latest verified commit already on the configured GitHub branch.

## Deployment

From this directory, run:

```powershell
.\deploy.ps1 -Project "AI Knowledge Vault"
```

The launcher reads the current `main` branch SHA from GitHub, then displays the project, repository, branch, commit SHA, and Render service name. It asks for the exact phrase `DEPLOY AI KNOWLEDGE VAULT TO RENDER`. Before that approval it does not dispatch the workflow, create a Render service, or deploy. After approval, GitHub Actions checks out and validates that exact commit, rechecks that it is still the branch head, then resolves or creates the Render service and verifies its deployment. The launcher reports the HTTPS URL only after the workflow confirms both the deployed SHA and a successful HTTPS response.

## Required setup

1. Push the website source manually to `avnish910242-ai/ai-knowledge-vault` on `main`.
2. Install and authenticate GitHub CLI (`gh`) with access to the source repository and the UDA control repository.
3. Set `UDA_APPROVAL_HMAC_KEY` in the local process environment using a secure secret manager. Use at least 32 UTF-8 bytes. Do not put it in this repository or paste it into chat.
4. Replace `renderOwnerId` in `config/deployments.json` with the target Render workspace ID. Obtain this value manually from the intended workspace settings.
5. In the UDA control repository, configure the `uda-production` GitHub Environment for protected `main` only, with these secrets: `UDA_APPROVAL_HMAC_KEY`, `UDA_PROJECT_READ_TOKEN`, and `RENDER_API_TOKEN`. The source token needs repository read access. The Render API key must be limited to the intended workspace and have permission to list/read/create services and trigger/read deploys. Never print or commit the secret values.
6. Ensure Render has GitHub access to the source repository. UDA creates a Node.js Web Service using `npm ci && npm run build` and `npm run start`, with native auto-deploy disabled so only the approved exact SHA is deployed.

The mapped cloud validation uses Node.js 24, installs with `npm ci`, builds with `npm run build`, and runs `npm run lint`. The latter is the project's configured lint check, not a separate test suite.

## Safe service reuse and creation

GitHub Actions serializes workflow runs for this project. It searches Render by exact service name and workspace. If no service exists, it sends one create request for a `web_service` linked to the configured repository and `main` branch. Render documents service names as unique within a workspace. If the create response is uncertain, the workflow performs an exact-name lookup and never blindly repeats the create request. A later invocation can reconcile an already-created service.

An existing exact-name service is reused only if its workspace, type, repository, branch, Node runtime, build command, start command, and disabled auto-deploy setting all match. A mismatch stops deployment without updating, deleting, or redeploying that service. UDA never uses a service ID from the webhook or source payload and does not address Nova by name or ID.

Service creation starts Render's initial deployment. The workflow uses that deployment when it is for the approved SHA instead of triggering a second build. It verifies the deployment's exact commit SHA, obtains the service's HTTPS `onrender.com` URL, and requires a successful response from that URL before returning the result artifact.

## Limitations

The Render workspace ID and GitHub/Render credentials must be configured before use. Render's service-creation API does not accept a commit SHA; creating a Git-backed service starts its first build from the configured branch. The workflow checks the branch immediately before creation and verifies the first deployment SHA. If the branch moves during that narrow interval and the initial deployment has a different SHA, the workflow fails without claiming success or triggering a second deployment. This Render API behavior prevents an atomic guarantee that the first build itself is always the approved SHA.

If Render's exact-name lookup, create response, service configuration, deployment ID, commit SHA, or HTTPS URL cannot be verified, the workflow fails closed. An uncertain create outcome is reconciled by lookup; it is never blindly retried. A subsequent approved run may resume by verifying the service found by that lookup.

UDA does not access n8n, Docker, PostgreSQL, Nova, SEASHOP, `C:\AI-Agent`, or unrelated registered project folders. It does not deploy until the target-specific approval prompt is accepted.
