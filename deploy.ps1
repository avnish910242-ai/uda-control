[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$')][string]$Project,
  [string]$DeploymentMapPath = (Join-Path $PSScriptRoot 'config\deployments.json')
)
$ErrorActionPreference = 'Stop'
$script:ApprovalKey = [Environment]::GetEnvironmentVariable('UDA_APPROVAL_HMAC_KEY','Process')
$script:OriginalApprovalKey = $script:ApprovalKey

function Get-DeploymentEntry([string]$Name) {
  if (!(Test-Path -LiteralPath $DeploymentMapPath -PathType Leaf)) { throw 'Deployment allowlist not found.' }
  $config = Get-Content -LiteralPath $DeploymentMapPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$config.controlRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Deployment control repository is invalid.' }
  $matches = @($config.projects | Where-Object { $_.name -ceq $Name })
  if ($matches.Count -ne 1) { throw 'Project is not in the deployment allowlist exactly once.' }
  $m = $matches[0]
  if ([string]$m.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or [string]$m.branch -cne 'main' -or [string]$m.renderServiceName -cne 'ai-knowledge-vault' -or [string]$m.renderOwnerId -notmatch '^tea-[a-z0-9]+$') { throw 'Deployment mapping is incomplete or invalid; set the Render workspace ID from its dashboard.' }
  if ($null -eq $m.runtime -or [string]$m.runtime.type -cne 'node' -or [string]$m.runtime.version -notmatch '^\d+(\.\d+){0,2}$') { throw 'Deployment Node.js runtime mapping is invalid.' }
  foreach ($key in @('install','build','test')) {
    if ($m.$key -isnot [array] -or (($key -ne 'install') -and $m.$key.Count -eq 0)) { throw "Deployment $key command list is invalid." }
    foreach ($command in $m.$key) {
      if ($command -isnot [array] -or $command.Count -eq 0) { throw "Deployment $key command is invalid." }
      foreach ($arg in $command) { if ($arg -isnot [string] -or [string]::IsNullOrWhiteSpace($arg) -or $arg -match '[\x00-\x1F\x7F]') { throw "Deployment $key argument is invalid." } }
      if ($command[0] -match '[;&|<>`$]') { throw "Deployment $key executable is unsafe." }
    }
  }
  return [pscustomobject]@{ Config=$config; Mapping=$m }
}

function Get-CanonicalFields([string[]]$Fields) {
  return (($Fields | ForEach-Object { $value=[string]$_; "$([Text.Encoding]::UTF8.GetByteCount($value))`:$value" }) -join '')
}

function Get-MappingIdentity([object]$Mapping) {
  $fields = @('name',[string]$Mapping.name,'repository',[string]$Mapping.repository,'branch',[string]$Mapping.branch,
    'renderOwnerId',[string]$Mapping.renderOwnerId,'renderServiceName',[string]$Mapping.renderServiceName,
    'runtime.type',[string]$Mapping.runtime.type,'runtime.version',[string]$Mapping.runtime.version)
  foreach ($key in @('install','build','test')) {
    $commands=@($Mapping.$key); $fields+=@("$key.command-count",[string]$commands.Count)
    for($i=0;$i -lt $commands.Count;$i++) { $command=@($commands[$i]); $fields+=@("${key}.${i}.argument-count",[string]$command.Count)+$command }
  }
  $sha=[Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes((Get-CanonicalFields $fields)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}

function Invoke-Gh([string[]]$Arguments,[string]$Failure) {
  $gh=Get-Command gh -ErrorAction SilentlyContinue
  if (!$gh) { throw 'GitHub CLI (gh) is required; install it and authenticate to GitHub first.' }
  $output=@(& $gh.Source @Arguments 2>$null)
  if ($LASTEXITCODE -ne 0) { throw $Failure }
  return ($output -join [Environment]::NewLine).Trim()
}

try {
  if ([string]::IsNullOrWhiteSpace($script:ApprovalKey) -or [Text.Encoding]::UTF8.GetByteCount($script:ApprovalKey) -lt 32) { throw 'Configure UDA_APPROVAL_HMAC_KEY in the local secure environment before deployment.' }
  [Environment]::SetEnvironmentVariable('UDA_APPROVAL_HMAC_KEY',$null,'Process')
  $entry=Get-DeploymentEntry $Project
  $mapping=$entry.Mapping
  $repo=[string]$mapping.repository
  $branch=[string]$mapping.branch
  $commit=Invoke-Gh @('api',"repos/$repo/branches/$branch",'--jq','.commit.sha') 'Could not obtain the latest GitHub branch commit.'
  if ($commit -notmatch '^[0-9a-f]{40}([0-9a-f]{24})?$') { throw 'GitHub returned an invalid commit SHA.' }

  Write-Host ''
  Write-Host "Project:        $($mapping.name)"
  Write-Host "GitHub:         $repo"
  Write-Host "Branch:         $branch"
  Write-Host "Commit:         $commit"
  Write-Host "Render service: $($mapping.renderServiceName)"
  Write-Host 'Action:         Create if absent, otherwise reuse only an exact matching Web Service; then deploy.'
  $expected="DEPLOY $($mapping.name.ToUpperInvariant()) TO RENDER"
  $approval=Read-Host "To approve creation/deployment, type exactly: $expected"
  if ($approval -cne $expected) { throw 'Creation/deployment was not approved.' }

  $issued=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
  $nonceBytes=New-Object byte[] 32
  $rng=[Security.Cryptography.RandomNumberGenerator]::Create(); try{$rng.GetBytes($nonceBytes)}finally{$rng.Dispose()}
  $nonce=[BitConverter]::ToString($nonceBytes).Replace('-','').ToLowerInvariant()
  $controlRepo=[string]$entry.Config.controlRepository
  $controlRef='refs/heads/main'
  $proof=Get-CanonicalFields @($mapping.name,$repo,$branch,$commit.ToLowerInvariant(),$issued,$nonce,$controlRepo,$controlRef,(Get-MappingIdentity $mapping))
  $hmac=[Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($script:ApprovalKey))
  try{$signature=[BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($proof))).Replace('-','').ToLowerInvariant()}finally{$hmac.Dispose()}
  Invoke-Gh @('workflow','run','uda-cloud-validation.yml','--repo',$controlRepo,'--ref','main','-f',"project=$($mapping.name)",'-f',"commit=$commit",'-f',"issued_at=$issued",'-f',"nonce=$nonce",'-f',"approval_signature=$signature") 'GitHub Actions dispatch failed.' | Out-Null

  $runName="UDA $($mapping.name) $commit $nonce"; $runId=$null
  for($attempt=0;$attempt -lt 40 -and !$runId;$attempt++) {
    try {
      $runs=Invoke-Gh @('run','list','--workflow','uda-cloud-validation.yml','--repo',$controlRepo,'--limit','100','--json','databaseId,displayTitle') 'Could not find the authorized GitHub Actions run.' | ConvertFrom-Json
      $found=@($runs|Where-Object{$_.displayTitle -ceq $runName})
      if($found.Count -gt 1){throw 'Multiple Actions runs matched the approved authorization.'}
      if($found.Count -eq 1){$runId=[string]$found[0].databaseId}
    } catch { if($_.Exception.Message -match 'Multiple Actions runs'){throw} }
    if(!$runId){Start-Sleep -Seconds 3}
  }
  if(!$runId){throw 'Authorized GitHub Actions run was not found.'}
  Write-Host "Waiting for cloud validation and Render deployment (Actions run $runId)."
  $gh=Get-Command gh -ErrorAction Stop
  & $gh.Source run watch $runId --exit-status --repo $controlRepo 2>$null
  if($LASTEXITCODE -ne 0){throw "GitHub cloud validation or Render deployment failed in Actions run $runId."}

  $udaRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.uda')).TrimEnd('\')+'\'
  $resultDir=[IO.Path]::GetFullPath((Join-Path $udaRoot "deploy-result-$nonce"))
  if(!$resultDir.StartsWith($udaRoot,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $resultDir)){throw 'Deployment result directory is unsafe or already exists.'}
  New-Item -ItemType Directory -Path $resultDir | Out-Null
  try {
    Invoke-Gh @('run','download',$runId,'--repo',$controlRepo,'--name',"uda-deployment-result-$nonce",'--dir',$resultDir) 'Could not download the deployment result.' | Out-Null
    $resultPath=Join-Path $resultDir 'deployment-result.json'
    if(!(Test-Path -LiteralPath $resultPath -PathType Leaf)){throw 'Deployment result artifact is missing.'}
    $result=Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8|ConvertFrom-Json
    [Uri]$url=$null
    if($result.project -cne $mapping.name -or $result.repository -cne $repo -or $result.branch -cne $branch -or $result.commit -cne $commit -or $result.renderServiceName -cne $mapping.renderServiceName -or $result.renderServiceId -notmatch '^srv-[A-Za-z0-9]+$' -or ![Uri]::TryCreate([string]$result.liveUrl,[UriKind]::Absolute,[ref]$url) -or $url.Scheme -ne 'https' -or $url.UserInfo -or $url.Query -or $url.Fragment){throw 'Deployment result did not match the approved project, commit, service, and HTTPS URL.'}
    Write-Host "Deployment verified. Live website: $($result.liveUrl)"
  } finally { if(Test-Path -LiteralPath $resultDir){Remove-Item -LiteralPath $resultDir -Recurse -Force} }
} catch {
  [Console]::Error.WriteLine("Deployment stopped: $($_.Exception.Message)")
  exit 1
} finally {
  [Environment]::SetEnvironmentVariable('UDA_APPROVAL_HMAC_KEY',$script:OriginalApprovalKey,'Process')
  $script:ApprovalKey=$null; $script:OriginalApprovalKey=$null
}
