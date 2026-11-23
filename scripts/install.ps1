param(
  [string]$DshRoot = $env:DSH_ROOT,
  [string]$Profile = 'desktop',
  [switch]$Force
)

# dsh-patch-sync install: copy into ~/.dsh/plugins, link it into the profile,
# and make sure the bundle is selected.
$ErrorActionPreference = 'Stop'
if (-not $DshRoot) { throw 'Pass -DshRoot <DeepSeek Harness install dir> or set DSH_ROOT.' }
$src = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pluginsRoot = Join-Path $env:USERPROFILE '.dsh\plugins'
$dst = Join-Path $pluginsRoot 'dsh-patch-sync'
$dshCmd = Join-Path $DshRoot 'resources\runtime\cli\bin\dsh.cmd'
$name = 'dsh-patch-sync'

Write-Host "source : $src"
Write-Host "target : $dst"
Write-Host "profile: $Profile"

if (-not (Test-Path $dshCmd)) { throw "dsh.cmd not found: $dshCmd (pass -DshRoot or set DSH_ROOT)" }
$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($null -ne $running -and -not $Force) {
  throw 'DeepSeek Harness is running. Fully quit DSH Desktop (including the tray) before installing, or pass -Force if you know the profile lock is free.'
}

New-Item -ItemType Directory -Force $pluginsRoot | Out-Null
if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
Copy-Item -Recurse -Force $src $dst

Write-Host 'Installing with link: ...'
& $dshCmd plugin --profile $Profile add "link:$dst" --config.minimum-release-age=0
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host 'If pnpm reported ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION the flag above disables that gate.'
  Write-Host 'The retry is idempotent; package.json may already hold a partial link dependency.'
  throw "dsh plugin add failed with exit code $LASTEXITCODE"
}

# pnpm add links the package, but a retry after a partial install may not re-run
# bundle reconciliation, so make sure the bundle is selected explicitly.
$profileJson = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\package.json"
if (-not (Test-Path $profileJson)) { throw "profile package.json not found: $profileJson" }
$doc = Get-Content $profileJson -Raw -Encoding UTF8 | ConvertFrom-Json
$bundles = @($doc.dsh.profile.bundles)
if ($bundles -notcontains $name) {
  Copy-Item $profileJson "$profileJson.bak-install" -Force
  $doc.dsh.profile.bundles = @($bundles + $name)
  $json = $doc | ConvertTo-Json -Depth 100
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($profileJson, $json, $utf8)
  Write-Host "Added $name to dsh.profile.bundles (backup: package.json.bak-install)."
} else {
  Write-Host "dsh.profile.bundles already contains $name."
}

Write-Host ''
Write-Host 'Installed. Fully quit and reopen DSH to load the plugin.'
