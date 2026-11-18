# Checks mcp/livewindow.ps1 (and the export flow with mcp/filedialog.ps1) against the stand-in Export window
# (export_window.ps1), with no Live. What it can't check: how Live's own window answers. Exits 0 when it all works.
#   powershell -ExecutionPolicy Bypass -File live-bridge\test\livewindow_uia.ps1
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$lw = Join-Path $here '..\mcp\livewindow.ps1'
$fd = Join-Path $here '..\mcp\filedialog.ps1'
$failed = 0
function Check($ok, $what) { if ($ok) { Write-Output "ok   $what" } else { Write-Output "FAIL $what"; $script:failed++ } }
$dir = Join-Path $env:TEMP "second-chair-livewindow-$PID"
New-Item -ItemType Directory -Force $dir | Out-Null
$out = Join-Path $dir 'result.json'
function Invoke-LW([string[]]$more) { & powershell -NoProfile -ExecutionPolicy Bypass -File $lw -Title 'Export Audio/Video' -OwnerLike powershell @more | ConvertFrom-Json }
function Start-Win([switch]$Cloak) {
  if (Test-Path $out) { Remove-Item $out }
  for ($i = 0; $i -lt 20; $i++) { if (-not (Invoke-LW @()).open) { break }; Start-Sleep -Milliseconds 250 }
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'export_window.ps1'), '-Out', $out, '-Seconds', '40')
  if ($Cloak) { $argv += '-Cloak' }
  $p = Start-Process powershell -ArgumentList $argv -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; $r = Invoke-LW @(); if ($r.open) { return $p, $r } }
  return $p, $null
}
function Get-Result { Start-Sleep -Milliseconds 400; if (Test-Path $out) { Get-Content $out -Raw | ConvertFrom-Json } else { $null } }
function Stop-Win($p) { if ($p -and -not $p.HasExited) { $p.Kill() } }

# 1. read, a button not on the list, Cancel
$p, $r = Start-Win
Check ($r -ne $null) 'read finds the stand-in Export window'
if ($r) {
  $names = @($r.controls | ForEach-Object { $_.name })
  Check (($names -contains 'Rendered Track Chooser') -and ($names -contains 'Length of Rendered Audio File (Bar)') -and ($names -contains 'Export')) 'read lists the track chooser, the length and Export'
  $len = @($r.controls | Where-Object { $_.name -eq 'Length of Rendered Audio File (Bar)' })[0]
  Check ($len.value -eq '8') "read gives the length's value ($($len.value))"
  $n = Invoke-LW @('-Action', 'press', '-Button', 'Normalize', '-Allow', 'Export,Cancel')
  Check ($n.error -eq 'not-allowed') 'a button not on the list is refused'
  Check (-not (Test-Path $out)) 'nothing was pressed'
  $c = Invoke-LW @('-Action', 'press', '-Button', 'Cancel', '-Allow', 'Export,Cancel')
  $got = Get-Result
  Check ($c.pressed -eq 'Cancel' -and $got -and $got.pressed -eq 'Cancel') "Cancel is pressed ($($c | ConvertTo-Json -Compress))"
}
Stop-Win $p

# 2. a cloaked window: Export, then the save picker, then the file
$p, $r = Start-Win -Cloak
Check ($r -ne $null -and $r.cloaked) "read finds a cloaked Export window (cloaked=$(if ($r) { $r.cloaked }))"
if ($r) {
  $e = Invoke-LW @('-Action', 'press', '-Button', 'Export', '-Allow', 'Export,Cancel')
  Check ($e.pressed -eq 'Export' -and $e.result -eq 'done') "Export is pressed ($($e | ConvertTo-Json -Compress))"
  $pk = $null
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 300; $pk = & powershell -NoProfile -ExecutionPolicy Bypass -File $fd -Action read -OwnerLike powershell | ConvertFrom-Json; if ($pk.open) { break } }
  Check ($pk.open) 'the save picker opens after Export'
  if ($pk.open) {
    $wav = Join-Path $dir 'mix.wav'
    $f = & powershell -NoProfile -ExecutionPolicy Bypass -File $fd -Action fill -Path $wav -OwnerLike powershell | ConvertFrom-Json
    $got = Get-Result
    Check ($f.closed -and $got -and $got.file -eq $wav -and (Test-Path $wav)) "the picker took the path and the file was written ($(if ($got) { $got | ConvertTo-Json -Compress }))"
  }
}
Stop-Win $p

# 3. no window, and the owner check
$n = Invoke-LW @()
Check ($n.open -eq $false) 'read with no window says open: false'
$p, $r = Start-Win
$x = & powershell -NoProfile -ExecutionPolicy Bypass -File $lw -Action press -Title 'Export Audio/Video' -Button Cancel -Allow Cancel | ConvertFrom-Json
Check ($x.error -eq 'no-live' -or $x.open -eq $false) "with the default owner (Ableton Live) the stand-in is never pressed ($($x | ConvertTo-Json -Compress))"
Check (-not (Test-Path $out)) 'nothing was pressed in the stand-in'
Stop-Win $p

Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
if ($failed) { Write-Output "$failed check(s) FAILED"; exit 1 } else { Write-Output 'All Live window checks passed.'; exit 0 }
