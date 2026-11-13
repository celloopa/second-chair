# Windows installer. It only checks that Node is there, then runs install.mjs, which does the work.
#   powershell -ExecutionPolicy Bypass -File install.ps1            install or update
#   powershell -ExecutionPolicy Bypass -File install.ps1 --check    change nothing, report the setup
#   powershell -ExecutionPolicy Bypass -File install.ps1 --uninstall
$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node isn't installed. Get Node 24 or newer from https://nodejs.org (the LTS button), install it,"
  Write-Host "open a NEW PowerShell window, and run this again."
  exit 1
}
& $node.Source (Join-Path $PSScriptRoot 'install.mjs') @args
exit $LASTEXITCODE
