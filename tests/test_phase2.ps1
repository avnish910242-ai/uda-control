$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
function Assert([bool]$ok,[string]$message){if(!$ok){throw "Test failed: $message"}}

$launcher=Get-Content -LiteralPath (Join-Path $root 'deploy.ps1') -Raw -Encoding UTF8
$config=Get-Content -LiteralPath (Join-Path $root 'config\deployments.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$actions=Get-Content -LiteralPath (Join-Path $root '.github\workflows\uda-cloud-validation.yml') -Raw -Encoding UTF8
$readme=Get-Content -LiteralPath (Join-Path $root 'README.md') -Raw -Encoding UTF8
$agents=Get-Content -LiteralPath (Join-Path $root 'AGENTS.md') -Raw -Encoding UTF8
$ignore=Get-Content -LiteralPath (Join-Path $root '.gitignore') -Raw -Encoding UTF8
$mapping=$config.projects | Where-Object name -CEQ 'AI Knowledge Vault'

Assert ($config.projects.Count -eq 1 -and $mapping.repository -ceq 'avnish910242-ai/ai-knowledge-vault' -and $mapping.branch -ceq 'main') 'AI Knowledge Vault repository and branch are explicitly mapped'
Assert ($mapping.renderServiceName -ceq 'ai-knowledge-vault' -and $mapping.renderOwnerId -match '^tea-[a-z0-9]+$') 'Render service name and configured workspace owner ID match the deployment mapping'
Assert ($mapping.runtime.type -ceq 'node' -and $mapping.build[0] -join ' ' -ceq 'npm run build' -and $mapping.install[0] -join ' ' -ceq 'npm ci' -and $mapping.test[0] -join ' ' -ceq 'npm run lint') 'Node validation commands match requested build configuration'

Assert ($launcher -match 'gh.*api' -and $launcher -match 'branches/\$branch' -and $launcher -match 'commit\.sha') 'launcher resolves the latest remote branch commit from GitHub'
Assert ($launcher -match 'Project:.*mapping\.name' -and $launcher -match 'GitHub:.*repo' -and $launcher -match 'Branch:.*branch' -and $launcher -match 'Render service:.*renderServiceName') 'launcher displays all approved target identity fields'
Assert ($launcher -match 'DEPLOY \$\(\$mapping\.name\.ToUpperInvariant\(\)\) TO RENDER' -and $launcher -match 'approval -cne \$expected') 'create/deploy requires explicit exact target approval'
Assert ($launcher -notmatch '(?i)git\s+push|push.*origin|Invoke-Git|RegistryPath|projects\.json') 'launcher does not inspect or push the website repository'
Assert ($launcher -match 'run watch' -and $launcher -match "'run','download'" -and $launcher -match 'renderServiceId' -and $launcher -match 'liveUrl') 'launcher waits for Actions and validates its deployment result'
Assert ($launcher -match 'HMACSHA256' -and $launcher -match 'UDA_APPROVAL_HMAC_KEY') 'approval attestation remains protected by a local secret'

Assert ($actions -match 'workflow_dispatch' -and $actions -match 'concurrency:' -and $actions -match 'cancel-in-progress: false') 'existing workflow is retained and deployment attempts are serialized'
Assert ($actions -match 'refs/remotes/origin/\$TARGET_BRANCH' -and $actions -match 'latest !== process\.env\.COMMIT_SHA') 'workflow validates exact current GitHub branch head before deployment'
Assert ($actions -match 'renderOwnerId' -and $actions -match 'renderServiceName' -and $actions -match 'runtime\.type') 'signed mapping covers workspace, service name and runtime'
Assert ($actions -match 'timingSafeEqual' -and $actions -match 'secrets\.UDA_APPROVAL_HMAC_KEY') 'workflow verifies the one-time approval without exposing its key'
Assert ($actions -match 'secrets\.UDA_PROJECT_READ_TOKEN' -and $actions -match 'secrets\.RENDER_API_TOKEN') 'GitHub and Render credentials remain GitHub Environment secrets'
Assert ($actions -match 'name=\$\{encodeURIComponent\(p\.renderServiceName\)\}.*ownerId=\$\{encodeURIComponent\(p\.renderOwnerId\)\}' -and $actions -match 'service\.name === p\.renderServiceName') 'Render lookup is scoped by exact name and workspace'
Assert ($actions -match 'type: ''web_service''' -and $actions -match 'autoDeployTrigger: ''off''' -and $actions -match 'serviceDetails: \{ runtime: ''node''') 'new service uses the documented Web Service schema and disables automatic deploys'
Assert ($actions -match 'npm ci && npm run build' -and $actions -match 'npm run start') 'Render service commands match approved configuration'
Assert ($actions -match 'catch \{' -and $actions -match 'exact-name reconciliation found no service' -and $actions -match 'No retry was attempted') 'ambiguous service creation reconciles by lookup and fails without blind retry'
Assert ($actions -match 'service\.type !== ''web_service''' -and $actions -match 'service\.repo !== wantedRepo' -and $actions -match 'service\.branch !== p\.branch' -and $actions -match 'd\.runtime !== ''node''' -and $actions -match 'autoOff') 'existing services are reused only after complete configuration checks'
Assert ($actions -match 'newlyCreated' -and $actions -match 'created\.deploy\?\.id' -and $actions -match 'will not create a duplicate deployment') 'first deployment started by service creation is reused'
Assert ($actions -match 'commitId: process\.env\.COMMIT_SHA' -and $actions -match 'commit\.toLowerCase\(\) !== sha\.toLowerCase\(\)') 'Render deployment is pinned to and verified against exact approved SHA'
Assert ($actions -match 'status === ''live''' -and $actions -match '40 \* 60 \* 1000' -and $actions -match 'Timed out waiting') 'deployment status polling includes failure and timeout handling'
Assert ($actions -match 'parsed\.protocol !== ''https:''' -and $actions -match 'onrender\.com' -and $actions -match 'Live URL.*returned HTTP') 'only the service HTTPS URL is accepted and checked'
Assert ($actions -match 'deployment-result\.json' -and $actions -match 'renderServiceId: resolved\.id' -and $actions -match 'liveUrl: resolved\.url') 'verified service identity and URL are returned to launcher'
Assert ($actions -notmatch '(?i)nova|/services/srv-[^`" ]+' -and $actions -notmatch '(?i)api\.render\.com/v1/services/srv-') 'workflow has no hardcoded or Nova service ID'
Assert ($actions -notmatch '(?i)RENDER_API_TOKEN\s*[:=]\s*(rnd_|rnd_)') 'workflow contains no literal Render credential'

Assert ($readme.Contains('npm run onboard') -and $readme -match 'manually' -and $readme -match 'never.*pushes') 'README documents current onboarding and manual push model'
Assert ($readme -match 'UDA_RENDER_OWNER_ID' -and $readme -match 'owner ID' -and $readme -match 'exact-name lookup') 'README documents required Render workspace setup and idempotent service resolution'
Assert ($agents -match 'SEASHOP' -and $agents -match 'C:\\AI-Agent' -and $agents -match 'All existing n8n workflows, credentials, settings, and Docker volumes') 'protected-resource restrictions remain in force'
Assert ($ignore -match '(?m)^\.uda/projects\.json$' -and $ignore -match '(?m)^\.env\.\*$') 'local registry and environment secrets remain ignored'

Write-Output 'Focused Render first-deployment architecture checks passed without contacting external services.'
