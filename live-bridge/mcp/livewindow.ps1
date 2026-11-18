# Reads one of Live's own windows by its exact title (for example "Export Audio/Video") and, when asked, presses one
# button in it by exact name, through Windows UI Automation (Windows only), for second-chair's live_export tool.
# No mouse, no keys, no clipboard, no focus change.
#   -Action read -Title <title>                      lists the window's controls: type, name, value, on/off, enabled.
#   -Action press -Title <title> -Button <name> -Allow <names>
#                                                    presses that one button (UIA Invoke) if its name is in -Allow,
#                                                    then waits up to -WaitMs for the window to close.
# Finding: the window is found by its Win32 title among Live's processes first (EnumWindows), then read by handle, so a
# window GlazeWM has cloaked on another workspace is still found (UI Automation's desktop tree leaves those out).
# Only reads and Invoke: it never writes a value into Live's controls (SetValue on Live's sliders crashed Live,
# community-reported). Live 12.4.16's Export Audio/Video window (seen 2026-11-18): ComboBoxes "Rendered Track Chooser",
# "Sample Rate", "File Type", "Recording Bit Depth", "Dither Options"; Sliders "Start of Rendered Audio File (Bar|Beat|
# Sixteenths)" and "Length of Rendered Audio File (...)"; option Buttons with Value On/Off ("Render as Loop", "Normalize",
# "Encode MP3", ...); Buttons "Export" and "Cancel".
# Prints one JSON object; on trouble {"error": "...", "message": "..."}.
param(
  [ValidateSet('read', 'press')] [string]$Action = 'read',
  [Parameter(Mandatory = $true)] [string]$Title,
  [string]$Button = '',
  [string]$Allow = 'Cancel',
  [int]$WaitMs = 3000,
  # Only for the stand-in window test (test/livewindow_uia.ps1); the tool never passes it.
  [string]$OwnerLike = 'Ableton Live*'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase @'
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public static class LiveWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public static IntPtr[] Named(int[] pids, string title) {
    var want = new HashSet<uint>(); foreach (var p in pids) want.Add((uint)p);
    var o = new List<IntPtr>();
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid);
      if (want.Contains(pid)) { var s = new StringBuilder(256); GetWindowText(h, s, 256); if (s.ToString() == title) o.Add(h); }
      return true; }, IntPtr.Zero);
    return o.ToArray();
  }
  public static bool Alive(IntPtr h) { return IsWindow(h); }
  public static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }
  public static string Invoke(AutomationElement e, int ms) {
    string err = null;
    var t = new Thread(() => { try { ((InvokePattern)e.GetCurrentPattern(InvokePattern.Pattern)).Invoke(); } catch (Exception x) { err = x.Message; } });
    t.IsBackground = true; t.Start();
    if (!t.Join(ms)) return "still-running";
    return err == null ? "done" : ("failed: " + err);
  }
}
'@
$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
function Out-Json($o) { $o | ConvertTo-Json -Compress -Depth 6; exit 0 }

$livePids = @(Get-Process | Where-Object { $_.ProcessName -like $OwnerLike } | ForEach-Object { $_.Id })
if (-not $livePids.Count) { Out-Json @{ error = 'no-live'; message = 'Live is not open (no Ableton Live process found).' } }

$hwnds = @([LiveWin]::Named([int[]]$livePids, $Title))
if (-not $hwnds.Count) { Out-Json @{ open = $false } }
if ($hwnds.Count -gt 1) { Out-Json @{ error = 'several'; message = "More than one '$Title' window is open in Live; nothing was pressed." } }
$h = $hwnds[0]
$win = $null; try { $win = $A::FromHandle($h) } catch { }
$cloaked = [LiveWin]::Cloaked($h)
$all = if ($win) { @($win.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) } else { @() }
if (-not $all.Count) { Out-Json @{ open = $true; unreadable = $true; cloaked = $cloaked; message = "Live's '$Title' window is open, but Windows doesn't show what's inside it. Nothing was pressed." } }

function Get-Val($e) {
  try { return [string]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { }
  try { return [string]$e.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern).Current.Value } catch { return $null }
}
function Get-Toggle($e) { try { return [string]$e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState } catch { return $null } }

if ($Action -eq 'read') {
  $items = @()
  foreach ($e in $all) {
    $c = $e.Current
    $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    if ($type -eq 'Text') { continue }
    $it = [ordered]@{ type = $type; name = $c.Name; enabled = $c.IsEnabled }
    $v = Get-Val $e; if ($null -ne $v -and $v -ne '') { $it.value = $v }
    $t = Get-Toggle $e; if ($t) { $it.toggle = $t }
    $items += [pscustomobject]$it
  }
  Out-Json ([ordered]@{ open = $true; cloaked = $cloaked; title = $Title; controls = $items })
}

# press
$allowed = @($Allow -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($allowed -cnotcontains $Button) { Out-Json @{ error = 'not-allowed'; message = "'$Button' isn't on the list of buttons this may press ($($allowed -join ', ')). Nothing was pressed." } }
$b = @($all | Where-Object { $_.Current.ControlType -eq $CT::Button -and $_.Current.Name -ceq $Button })
if ($b.Count -ne 1) { Out-Json @{ error = 'no-button'; message = "Live's '$Title' window has no single '$Button' button. Nothing was pressed." } }
if (-not $b[0].Current.IsEnabled) { Out-Json @{ error = 'button-disabled'; message = "Live has '$Button' greyed out right now. Nothing was pressed." } }
$r = [LiveWin]::Invoke($b[0], 5000)
$t = [Diagnostics.Stopwatch]::StartNew(); $closed = $false
while ($t.ElapsedMilliseconds -lt $WaitMs) { Start-Sleep -Milliseconds 200; if (-not [LiveWin]::Alive($h)) { $closed = $true; break } }
Out-Json ([ordered]@{ pressed = $Button; result = $r; closed = $closed; cloaked = $cloaked })
