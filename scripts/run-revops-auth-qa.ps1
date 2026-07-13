# Secure RevOps branch QA — prompts locally, never echoes credentials.
param(
  [string]$Base = 'https://operations-core-job-lifecycle--cardetail1.netlify.app'
)

$ErrorActionPreference = 'Stop'
$node = 'C:\Users\magno\AppData\Local\OpenAI\Codex\bin\node.exe'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $env:CD1_ADMIN_TOKEN -and -not $env:ADMIN_DASH_PASSWORD) {
  $sec = Read-Host -AsSecureString 'Admin password (input hidden)'
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
  if (-not $plain) { throw 'No password entered.' }
  $env:ADMIN_DASH_PASSWORD = $plain
  $plain = $null
}

try {
  & $node scripts/revops-auth-qa.mjs
  exit $LASTEXITCODE
}
finally {
  Remove-Item Env:ADMIN_DASH_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:CD1_ADMIN_TOKEN -ErrorAction SilentlyContinue
}
