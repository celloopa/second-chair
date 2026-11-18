# Reads and presses Live's "Separate Stems" window through Windows UI Automation (Windows only), for second-chair's
# live_separate_stems tool. No mouse, no keys, no clipboard, no focus change.
#   -Action read                         finds the window and lists its controls and tick boxes. Presses nothing.
#   -Action set -Want "vocals=1,drums=1,bass=0,others=1,merge=0,high=1" [-Separate]
#                                        sets the tick boxes with UIA Toggle, checks each one took, then (with
#                                        -Separate) presses the Separate button with UIA Invoke.
#   -Action cancel                       presses the window's Cancel button with UIA Invoke.
# It only ever presses Separate or Cancel, and only in a window named exactly "Separate Stems" that belongs to an
# Ableton Live process and holds both of those buttons. Anything else is refused, with nothing pressed.
# Seen in Live 12.4.16 (2026-11-18): the window is Live-drawn (not a standard Windows dialog). It holds CheckBoxes
# "Vocals, Include or exclude the Vocals stem." (and Drums, Bass, Others), an unnamed CheckBox, CheckBox "Merge Stems"
# (greyed out for a short clip), CheckBox "Quality Mode, Choose between High Speed or High Quality." (On = High
# Quality), and Buttons Separate and Cancel. A box is matched by its name, or its name before ", " and a description.
# Run it by hand to look:  powershell -ExecutionPolicy Bypass -File separate.ps1 -Action read
# Prints one JSON object; on trouble {"error": "...", "message": "..."}.
param(
  [ValidateSet('read', 'set', 'cancel')] [string]$Action = 'read',
  [string]$Want = '',
  [switch]$Separate,
  [int]$WaitMs = 3000,
  # Only for the stand-in window test (test/separate_window.ps1); the tool never passes it.
  [string]$OwnerLike = 'Ableton Live*'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
# Invoke and Toggle can block until the app answers; run them on their own thread so this script can't hang.
if ($Action -ne 'read') {
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase @'
using System;
using System.Threading;
using System.Windows.Automation;
public static class StemPress {
  public static string Run(AutomationElement e, string what, int ms) {
    string err = null;
    var t = new Thread(() => {
      try {
        if (what == "invoke") ((InvokePattern)e.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
        else ((TogglePattern)e.GetCurrentPattern(TogglePattern.Pattern)).Toggle();
      } catch (Exception x) { err = x.Message; }
    });
    t.IsBackground = true; t.Start();
    if (!t.Join(ms)) return "still-running";
    return err == null ? "done" : ("failed: " + err);
  }
}
'@
}
$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
function Out-Json($o) { $o | ConvertTo-Json -Compress -Depth 6; exit 0 }
$TITLE = 'Separate Stems'

$livePids = @(Get-Process | Where-Object { $_.ProcessName -like $OwnerLike } | ForEach-Object { $_.Id })
if (-not $livePids.Count) { Out-Json @{ error = 'no-live'; message = 'Live is not open (no Ableton Live process found).' } }

function Get-Kids($el, $type) {
  $c = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $type)
  return @($el.FindAll($TS::Descendants, $c))
}
function Test-StemWindow($el) {
  try {
    if ($el.Current.Name -cne $TITLE) { return $false }
    $names = @(Get-Kids $el $CT::Button | ForEach-Object { $_.Current.Name })
    return ($names -contains 'Separate') -and ($names -contains 'Cancel')
  } catch { return $false }
}
# Find the window: first among the desktop's top-level windows, then inside Live's own top-level windows.
function Find-StemWindows {
  $root = $A::RootElement
  $byName = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $TITLE)
  $hits = @($root.FindAll($TS::Children, $byName))
  if (-not $hits.Count) {
    foreach ($p in $livePids) {
      $byPid = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $p)
      foreach ($w in @($root.FindAll($TS::Children, $byPid))) { $hits += @($w.FindAll($TS::Descendants, $byName)) }
    }
  }
  return @($hits | Where-Object { Test-StemWindow $_ })
}
# Live's other top-level windows (names only), to spot a progress window if Live shows one.
function Get-LiveWindowNames {
  $out = @()
  foreach ($p in $livePids) {
    $byPid = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $p)
    foreach ($w in @($A::RootElement.FindAll($TS::Children, $byPid))) { $out += $w.Current.Name }
  }
  return $out
}
function Get-Toggle($el) {
  try { return [string]($el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState) } catch { return $null }
}
function Describe($win) {
  $items = @()
  foreach ($e in @($win.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition))) {
    $c = $e.Current
    $it = [ordered]@{ type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''; name = $c.Name; enabled = $c.IsEnabled }
    $tg = Get-Toggle $e; if ($tg) { $it.toggle = $tg }
    $items += [pscustomobject]$it
  }
  return $items
}
# The six boxes the tool may set, by their UIA name.
$BOXES = [ordered]@{ vocals = 'Vocals'; drums = 'Drums'; bass = 'Bass'; others = 'Others'; merge = 'Merge Stems'; high = 'Quality Mode' }
function Test-BoxName([string]$name, [string]$want) { return ($name -ceq $want) -or $name.StartsWith("$want, ", [StringComparison]::Ordinal) }
function Find-Box($checks, $want) { return @($checks | Where-Object { Test-BoxName $_.Current.Name $want }) }
function Read-Boxes($win) {
  $out = [ordered]@{}; $missing = @()
  $checks = Get-Kids $win $CT::CheckBox
  foreach ($k in $BOXES.Keys) {
    $m = Find-Box $checks $BOXES[$k]
    if ($m.Count -ne 1) { $missing += $BOXES[$k]; continue }
    $out[$k] = (Get-Toggle $m[0]) -eq 'On'
  }
  return $out, $missing, $checks
}
function Find-One {
  $wins = @(Find-StemWindows)
  if (-not $wins.Count) { Out-Json @{ error = 'no-window'; message = "Live's Separate Stems window isn't open."; live_windows = @(Get-LiveWindowNames) } }
  if ($wins.Count -gt 1) { Out-Json @{ error = 'several'; message = "More than one Separate Stems window is open; nothing was pressed." } }
  $w = $wins[0]
  $owner = $w.Current.ProcessId
  if ($livePids -notcontains $owner) { Out-Json @{ error = 'not-live'; message = "A window called Separate Stems is open, but it doesn't belong to Ableton Live (process $owner). Nothing was pressed." } }
  return $w
}
function Wait-Closed($ms) {
  $t = [Diagnostics.Stopwatch]::StartNew()
  while ($t.ElapsedMilliseconds -lt $ms) { Start-Sleep -Milliseconds 200; if (-not @(Find-StemWindows).Count) { return $true } }
  return $false
}
function Press($win, $name) {
  $b = @(Get-Kids $win $CT::Button | Where-Object { $_.Current.Name -ceq $name })
  if ($b.Count -ne 1) { Out-Json @{ error = 'no-button'; message = "The Separate Stems window has no single '$name' button. Nothing was pressed." } }
  if (-not $b[0].Current.IsEnabled) { Out-Json @{ error = 'button-disabled'; message = "Live has the '$name' button greyed out. Nothing was pressed." } }
  return [StemPress]::Run($b[0], 'invoke', 5000)
}

if ($Action -eq 'read') {
  $wins = @(Find-StemWindows)
  if (-not $wins.Count) { Out-Json @{ open = $false; live_windows = @(Get-LiveWindowNames) } }
  $w = $wins[0]
  $boxes, $missing, $null = Read-Boxes $w
  Out-Json @{ open = $true; count = $wins.Count; live_owned = ($livePids -contains $w.Current.ProcessId); boxes = $boxes; missing = $missing; elements = @(Describe $w); live_windows = @(Get-LiveWindowNames) }
}

$w = Find-One

if ($Action -eq 'cancel') {
  $r = Press $w 'Cancel'
  Out-Json @{ pressed = 'Cancel'; result = $r; closed = (Wait-Closed $WaitMs) }
}

# set: parse "vocals=1,drums=0,..."
$wantMap = [ordered]@{}
foreach ($pair in ($Want -split ',')) {
  $kv = $pair.Trim() -split '=', 2
  if ($kv.Count -ne 2 -or -not $BOXES.Contains($kv[0].Trim())) { continue }
  $wantMap[$kv[0].Trim()] = ($kv[1].Trim() -eq '1')
}
if (-not $wantMap.Count) { Out-Json @{ error = 'bad-want'; message = 'Nothing to set: give -Want like "vocals=1,drums=0".' } }
$before, $missing, $checks = Read-Boxes $w
$miss = @($wantMap.Keys | ForEach-Object { $BOXES[$_] } | Where-Object { $missing -contains $_ })
if ($miss.Count) { Out-Json @{ error = 'missing'; message = "The Separate Stems window has no tick box called $(($miss | ForEach-Object { "'$_'" }) -join ', ') (another Live version or language?). Nothing was pressed."; elements = @(Describe $w) } }
$toggled = @()
foreach ($k in $wantMap.Keys) {
  if ($before[$k] -eq $wantMap[$k]) { continue }
  $box = (Find-Box $checks $BOXES[$k])[0]
  if (-not $box.Current.IsEnabled) { Out-Json @{ error = 'box-disabled'; message = "Live has '$($BOXES[$k])' greyed out for this clip, so it can't be set that way. Separate was not pressed."; toggled = $toggled } }
  $r = [StemPress]::Run($box, 'toggle', 3000)
  if ($r -ne 'done') { Out-Json @{ error = 'toggle-failed'; message = "Toggling '$($BOXES[$k])' gave: $r. Separate was not pressed."; toggled = $toggled } }
  Start-Sleep -Milliseconds 150
  if (((Get-Toggle $box) -eq 'On') -ne $wantMap[$k]) { Out-Json @{ error = 'toggle-failed'; message = "'$($BOXES[$k])' didn't change when toggled. Separate was not pressed."; toggled = $toggled } }
  $toggled += $BOXES[$k]
}
$after, $null, $null = Read-Boxes $w
$out = [ordered]@{ boxes_before = $before; boxes = $after; toggled = $toggled }
if (-not $Separate) { Out-Json $out }
$out.pressed = 'Separate'
$out.result = Press $w 'Separate'
$out.closed = Wait-Closed $WaitMs
if (-not $out.closed) {
  $still = @(Find-StemWindows)
  if ($still.Count) { $out.window_now = @(Describe $still[0]) }
}
$out.live_windows = @(Get-LiveWindowNames)
Out-Json $out
