# Checks mcp/separate.ps1 against the stand-in window (separate_window.ps1), with no Live. Exits 0 when it all works.
#   powershell -ExecutionPolicy Bypass -File live-bridge\test\separate_uia.ps1
# What it can't check: that Live's own window answers Toggle and Invoke the same way. That needs the real-Live run.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$script = Join-Path $here '..\mcp\separate.ps1'
$failed = 0
function Check($ok, $what) { if ($ok) { Write-Output "ok   $what" } else { Write-Output "FAIL $what"; $script:failed++ } }
function Start-Window($out, [switch]$Cloak) {
  if (Test-Path $out) { Remove-Item $out }
  # the last stand-in must be gone first, or this would find it
  for ($i = 0; $i -lt 20; $i++) { $r = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Action read -OwnerLike powershell | ConvertFrom-Json; if (-not $r.open) { break }; Start-Sleep -Milliseconds 250 }
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'separate_window.ps1'), '-Out', $out, '-Seconds', '40')
  if ($Cloak) { $argv += '-Cloak' }
  $p = Start-Process powershell -ArgumentList $argv -PassThru -WindowStyle Hidden
  # wait until UIA sees it
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    $r = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Action read -OwnerLike powershell | ConvertFrom-Json
    if ($r.open) { return $p, $r }
  }
  return $p, $null
}
function Invoke-Separate([string[]]$more) { & powershell -NoProfile -ExecutionPolicy Bypass -File $script -OwnerLike powershell @more | ConvertFrom-Json }

$out = Join-Path $env:TEMP "second-chair-separate-uia-$PID.json"

# 1. read, set two boxes, press Separate
$p, $r = Start-Window $out
Check ($r -ne $null) 'read finds the stand-in Separate Stems window'
if ($r) {
  Check ($r.boxes.vocals -and $r.boxes.high -and -not $r.boxes.merge) 'read gives the tick boxes (Vocals on, Quality Mode on, Merge off)'
  $s = Invoke-Separate @('-Action', 'set', '-Want', 'vocals=1,drums=0,bass=1,others=1,merge=1,high=0')
  Check (-not $s.error) "set without -Separate works ($($s.message))"
  Check (($s.toggled -join ',') -eq 'Drums,Merge Stems,Quality Mode') "set toggles only the boxes that differ (got $($s.toggled -join ','))"
  Check (-not (Test-Path $out)) 'set without -Separate presses nothing'
  $s = Invoke-Separate @('-Action', 'set', '-Want', 'vocals=1,drums=0,bass=1,others=1,merge=1,high=0', '-Separate')
  Check ($s.pressed -eq 'Separate' -and $s.result -eq 'done' -and $s.closed) "set -Separate presses Separate and the window closes ($($s.result), closed=$($s.closed))"
  Start-Sleep -Milliseconds 300
  $got = if (Test-Path $out) { Get-Content $out -Raw | ConvertFrom-Json } else { $null }
  Check ($got -and $got.pressed -eq 'Separate' -and -not $got.Drums -and $got.'Merge Stems' -and -not $got.'Quality Mode' -and $got.Vocals) "the window got Separate with the right boxes ($(if ($got) { $got | ConvertTo-Json -Compress }))"
}
if (-not $p.HasExited) { $p.Kill() }

# 2. cancel
$p, $r = Start-Window $out
if ($r) {
  $c = Invoke-Separate @('-Action', 'cancel')
  Check ($c.pressed -eq 'Cancel' -and $c.closed) "cancel presses Cancel and the window closes ($($c | ConvertTo-Json -Compress))"
  Start-Sleep -Milliseconds 300
  $got = if (Test-Path $out) { Get-Content $out -Raw | ConvertFrom-Json } else { $null }
  Check ($got -and $got.pressed -eq 'Cancel' -and $got.Drums) 'the window got Cancel, and its boxes were left alone'
} else { Check $false 'the second stand-in window opened' }
if (-not $p.HasExited) { $p.Kill() }

# 3. no window: read says closed, cancel and set refuse with nothing pressed
$n = Invoke-Separate @('-Action', 'read')
Check ($n.open -eq $false) 'read with no window says open: false'
$n = Invoke-Separate @('-Action', 'cancel')
Check ($n.error -eq 'no-window') 'cancel with no window refuses'
# 4. the real owner check: a Separate Stems window from a non-Live process is never touched
$p, $r = Start-Window $out
$x = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Action cancel | ConvertFrom-Json
Check ($x.error -eq 'no-live' -or $x.error -eq 'no-window' -or $x.error -eq 'not-live') "with the default owner (Ableton Live) the stand-in is never pressed ($($x.error))"
Start-Sleep -Milliseconds 300
Check (-not (Test-Path $out)) 'nothing was pressed in the stand-in'
if (-not $p.HasExited) { $p.Kill() }
if (Test-Path $out) { Remove-Item $out }

# 5. a cloaked window (how GlazeWM hides Live on another workspace): still found, set and pressed
$p, $r = Start-Window $out -Cloak
Check ($r -ne $null -and $r.cloaked) "read finds a cloaked Separate Stems window by handle (cloaked=$(if ($r) { $r.cloaked }))"
if ($r) {
  $s = Invoke-Separate @('-Action', 'set', '-Want', 'vocals=1,drums=0,bass=1,others=1,merge=0,high=1', '-Separate')
  Check ($s.pressed -eq 'Separate' -and $s.closed) "set -Separate works on the cloaked window ($($s.result), closed=$($s.closed))"
  Start-Sleep -Milliseconds 300
  $got = if (Test-Path $out) { Get-Content $out -Raw | ConvertFrom-Json } else { $null }
  Check ($got -and $got.pressed -eq 'Separate' -and -not $got.Drums) 'the cloaked window got Separate with Drums off'
}
if (-not $p.HasExited) { $p.Kill() }
if (Test-Path $out) { Remove-Item $out }

if ($failed) { Write-Output "$failed check(s) FAILED"; exit 1 } else { Write-Output 'All UIA checks passed.'; exit 0 }
