# Kept for old habits: the installer now lives at the top of the repo (install.ps1 / install.sh / install.mjs).
# It finds Live's User Library by itself, makes the token, and registers the tools and the skill with Claude.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '..\install.ps1') @args
exit $LASTEXITCODE
