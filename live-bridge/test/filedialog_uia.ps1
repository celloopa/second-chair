# Checks mcp/filedialog.ps1 against real Windows file pickers opened by filedialog_window.ps1, with no Live. Live's
# Save As, Save a Copy, Export and Import pickers are these same Windows dialogs, so this is close to the real thing;
# what it can't check is how Live answers once the picker closes. Exits 0 when it all works.
#   powershell -ExecutionPolicy Bypass -File live-bridge\test\filedialog_uia.ps1
# The stand-in pickers open where Windows puts them (on screen; a window manager may move them) for a few seconds each.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$script = Join-Path $here '..\mcp\filedialog.ps1'
$failed = 0
function Check($ok, $what) { if ($ok) { Write-Output "ok   $what" } else { Write-Output "FAIL $what"; $script:failed++ } }
$dir = Join-Path $env:TEMP "second-chair-filedialog-$PID"
New-Item -ItemType Directory -Force $dir | Out-Null
$out = Join-Path $dir 'result.json'
function Invoke-Picker([string[]]$more) { & powershell -NoProfile -ExecutionPolicy Bypass -File $script -OwnerLike powershell @more | ConvertFrom-Json }
function Start-Picker([string]$kind = 'save', [string]$name = '') {
  if (Test-Path $out) { Remove-Item $out }
  for ($i = 0; $i -lt 20; $i++) { if (-not (Invoke-Picker @('-Action', 'read')).open) { break }; Start-Sleep -Milliseconds 250 }
  # Start-Process joins arguments with spaces and doesn't quote them, so a name with a space is quoted here.
  $argv = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'filedialog_window.ps1'), '-Out', $out, '-Folder', $dir, '-Kind', $kind, '-Seconds', '40')
  if ($name) { $argv += @('-Name', "`"$name`"") }
  $p = Start-Process powershell -ArgumentList $argv -PassThru
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; $r = Invoke-Picker @('-Action', 'read'); if ($r.open) { return $p, $r } }
  return $p, $null
}
function Get-Result { Start-Sleep -Milliseconds 400; if (Test-Path $out) { Get-Content $out -Raw | ConvertFrom-Json } else { $null } }
function Stop-Picker($p) { if ($p -and -not $p.HasExited) { $p.Kill() } }

# 1. read and fill a Save picker
$p, $r = Start-Picker
Check ($r -ne $null) 'read finds the stand-in Save picker'
if ($r) {
  Check ($r.picker.kind -eq 'save' -and $r.picker.folder -eq $dir -and $r.picker.button) "read gives kind, folder and button ($($r.picker | ConvertTo-Json -Compress))"
  $f = Invoke-Picker @('-Action', 'fill', '-Path', (Join-Path $dir 'copy test.als'))
  Check ($f.closed -and -not $f.stopped) "fill sets the path and presses Save ($($f | ConvertTo-Json -Compress))"
  $got = Get-Result
  Check ($got -and $got.result -eq 'OK' -and $got.file -eq (Join-Path $dir 'copy test.als')) "the picker got exactly that path ($(if ($got) { $got | ConvertTo-Json -Compress }))"
}
Stop-Picker $p

# 1b. a picker that suggests a name (Live does: "ZZ Scratch Copy"): the given path must still win
$p, $r = Start-Picker 'save' 'Suggested Copy'
if ($r) {
  Check ($r.picker.file_name -eq 'Suggested Copy') "read shows the suggested name ($($r.picker.file_name))"
  $f = Invoke-Picker @('-Action', 'fill', '-Path', (Join-Path $dir 'mine.als'))
  $got = Get-Result
  Check ($f.closed -and $got -and $got.file -eq (Join-Path $dir 'mine.als')) "fill beats the suggested name ($(if ($got) { $got.file }))"
} else { Check $false 'the suggested-name stand-in picker opened' }
Stop-Picker $p

# 2. an existing file: No first (picker stays open), then Yes with -Replace
Set-Content (Join-Path $dir 'exists.als') 'old'
$p, $r = Start-Picker
if ($r) {
  $f = Invoke-Picker @('-Action', 'fill', '-Path', (Join-Path $dir 'exists.als'))
  Check ($f.stopped -eq 'replace' -and $f.answered -eq 'No' -and $f.picker_open) "without -Replace it answers No and the picker stays open ($($f | ConvertTo-Json -Compress))"
  Check (-not (Test-Path $out)) 'nothing was saved after No'
  $f = Invoke-Picker @('-Action', 'fill', '-Path', (Join-Path $dir 'exists.als'), '-Replace')
  Check ($f.closed -and $f.answered -eq 'Yes (replace)') "with -Replace it answers Yes and the picker closes ($($f | ConvertTo-Json -Compress))"
  $got = Get-Result
  Check ($got -and $got.result -eq 'OK') 'the picker accepted the replace'
} else { Check $false 'the second stand-in picker opened' }
Stop-Picker $p

# 3. cancel
$p, $r = Start-Picker
if ($r) {
  $c = Invoke-Picker @('-Action', 'cancel')
  Check ($c.pressed -eq 'Cancel' -and $c.closed) "cancel closes the picker ($($c | ConvertTo-Json -Compress))"
  $got = Get-Result
  Check ($got -and $got.result -eq 'Cancel') 'the picker got Cancel'
} else { Check $false 'the third stand-in picker opened' }
Stop-Picker $p

# 4. an Open picker
Set-Content (Join-Path $dir 'kick.wav') 'RIFF'
$p, $r = Start-Picker 'open'
if ($r) {
  Check ($r.picker.kind -eq 'open') "read sees an Open picker ($($r.picker.kind))"
  $f = Invoke-Picker @('-Action', 'fill', '-Path', (Join-Path $dir 'kick.wav'))
  $got = Get-Result
  Check ($f.closed -and $got -and $got.file -eq (Join-Path $dir 'kick.wav')) "fill opens that file ($($f | ConvertTo-Json -Compress))"
} else { Check $false 'the Open stand-in picker opened' }
Stop-Picker $p

# 5. no picker, and the owner check: with the default owner (Ableton Live) a stand-in picker is never touched
$n = Invoke-Picker @('-Action', 'read')
Check ($n.open -eq $false) 'read with no picker says open: false'
$n = Invoke-Picker @('-Action', 'cancel')
Check ($n.error -eq 'no-picker') 'cancel with no picker refuses'
$p, $r = Start-Picker
$x = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Action fill -Path (Join-Path $dir 'nope.als') | ConvertFrom-Json
Check ($x.error -eq 'no-live' -or $x.error -eq 'no-picker') "with the default owner the stand-in is never filled ($($x.error))"
Check (-not (Test-Path $out)) 'nothing was pressed in the stand-in'
Stop-Picker $p

Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
if ($failed) { Write-Output "$failed check(s) FAILED"; exit 1 } else { Write-Output 'All file picker checks passed.'; exit 0 }
