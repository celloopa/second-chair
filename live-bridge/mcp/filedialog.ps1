# Reads, fills and presses Windows' own file pickers (Save As, Save a Copy, the Export save picker, Open) that belong to
# Ableton Live, for second-chair's live_file_dialog tool (Windows only). No mouse, no keys, no clipboard, no focus change.
#   -Action read                          finds the picker: its kind (save or open), title, folder, file name, file type.
#   -Action fill -Path <full path> [-Replace]
#                                         puts the full path in File name, reads it back, then sends the picker its
#                                         Save/Open command. If a box opens over an existing file (Windows' "already
#                                         exists, replace it?"), it answers No unless -Replace (then Yes). Any other box
#                                         is left open and reported.
#   -Action cancel                        sends the picker its Cancel command.
# How, all Win32 (seen on Windows 11 with Live 12.4.16, 2026-11-18):
#   - EnumWindows lists Live's top-level #32770 windows. UI Automation's tree leaves out windows a window manager has
#     cloaked (GlazeWM hides other workspaces that way) and shows nothing inside them, so it isn't used to find or act.
#   - Inside the picker: the File name box is an Edit (control id 1001 in a ComboBox in Save pickers; inside the id-1148
#     box in Open pickers), Save/Open is Button id 1, Cancel is Button id 2, the folder is the "Address: ..." toolbar.
#   - WM_SETTEXT puts the path in File name, then the last character is typed again with WM_CHAR (to the box itself, no
#     keyboard): without it, a picker that suggested a name ("ZZ Scratch Copy") kept its own name. WM_GETTEXT reads it
#     back. WM_COMMAND with the button's id goes to the picker: the same message a click sends.
#   - Windows' Replace box is a task dialog: Yes/No are pressed with TDM_CLICK_BUTTON (ids 6 and 7).
# Only Windows' common file dialog and the box it opens are ever touched: never Live's own drawn windows (SetValue on
# Live's sliders crashed Live, community-reported).
# Adapted from the Second Chair probe save-dialog-uia.ps1 and the skills chat's save-picker-uia.ps1.
# Run it by hand to look:  powershell -ExecutionPolicy Bypass -File filedialog.ps1 -Action read
# Prints one JSON object; on trouble {"error": "...", "message": "..."}.
param(
  [ValidateSet('read', 'fill', 'cancel')] [string]$Action = 'read',
  [string]$Path = '',
  [switch]$Replace,
  [int]$WaitMs = 4000,
  # Only for the stand-in picker test (test/filedialog_uia.ps1); the tool never passes it.
  [string]$OwnerLike = 'Ableton Live*'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Picker {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, string l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, StringBuilder l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  const uint WM_SETTEXT = 0x000C, WM_GETTEXT = 0x000D, WM_GETTEXTLENGTH = 0x000E, WM_COMMAND = 0x0111, WM_CHAR = 0x0102,
    EM_SETSEL = 0x00B1, TDM_CLICK_BUTTON = 0x0466, SMTO_ABORTIFHUNG = 2;

  public static string Cls(IntPtr h) { var s = new StringBuilder(128); GetClassName(h, s, 128); return s.ToString(); }
  public static int Id(IntPtr h) { return GetDlgCtrlID(h); }
  public static bool Alive(IntPtr h) { return IsWindow(h); }
  /** Top-level #32770 windows of these processes, cloaked or not. */
  public static IntPtr[] Dialogs(int[] pids) {
    var want = new HashSet<uint>(); foreach (var p in pids) want.Add((uint)p);
    var o = new List<IntPtr>();
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (want.Contains(pid) && Cls(h) == "#32770") o.Add(h); return true; }, IntPtr.Zero);
    return o.ToArray();
  }
  public static uint Pid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
  /** Every child window, at any depth. */
  public static IntPtr[] Kids(IntPtr h) { var o = new List<IntPtr>(); EnumChildWindows(h, (c, l) => { o.Add(c); return true; }, IntPtr.Zero); return o.ToArray(); }
  public static bool Inside(IntPtr h, IntPtr ancestor) { for (var p = GetParent(h); p != IntPtr.Zero; p = GetParent(p)) if (p == ancestor) return true; return false; }
  public static IntPtr Parent(IntPtr h) { return GetParent(h); }
  public static string GetText(IntPtr h) {
    IntPtr n; if (SendMessageTimeout(h, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 2000, out n) == IntPtr.Zero) return null;
    var sb = new StringBuilder(n.ToInt32() + 2); IntPtr r;
    if (SendMessageTimeout(h, WM_GETTEXT, (IntPtr)sb.Capacity, sb, SMTO_ABORTIFHUNG, 2000, out r) == IntPtr.Zero) return null;
    return sb.ToString();
  }
  public static bool SetText(IntPtr h, string s) { IntPtr r; return SendMessageTimeout(h, WM_SETTEXT, IntPtr.Zero, s, SMTO_ABORTIFHUNG, 2000, out r) != IntPtr.Zero; }
  /** Type the last character again (WM_CHAR to the box itself: no keyboard, no focus), so the picker takes the text. */
  public static bool Retype(IntPtr h) {
    string t = GetText(h); if (string.IsNullOrEmpty(t)) return false;
    IntPtr r; int n = t.Length;
    if (SendMessageTimeout(h, EM_SETSEL, (IntPtr)(n - 1), (IntPtr)n, SMTO_ABORTIFHUNG, 2000, out r) == IntPtr.Zero) return false;
    return SendMessageTimeout(h, WM_CHAR, (IntPtr)t[n - 1], (IntPtr)1, SMTO_ABORTIFHUNG, 2000, out r) != IntPtr.Zero;
  }
  /** WM_COMMAND with BN_CLICKED (0) and the button's id: what a click on it sends. */
  public static bool Command(IntPtr dlg, int id, IntPtr button) { return PostMessage(dlg, WM_COMMAND, (IntPtr)(id & 0xFFFF), button); }
  public static bool TaskDialogClick(IntPtr h, int id) { return PostMessage(h, TDM_CLICK_BUTTON, (IntPtr)id, IntPtr.Zero); }
}
'@
function Out-Json($o) { $o | ConvertTo-Json -Compress -Depth 6; exit 0 }

$livePids = @(Get-Process | Where-Object { $_.ProcessName -like $OwnerLike } | ForEach-Object { $_.Id })
if (-not $livePids.Count) { Out-Json @{ error = 'no-live'; message = 'Live is not open (no Ableton Live process found).' } }

# The parts of a picker, or $null when this #32770 isn't one.
function Get-Parts([IntPtr]$dlg) {
  $kids = [Picker]::Kids($dlg)
  $edit = [IntPtr]::Zero; $kind = $null
  $openBox = @($kids | Where-Object { [Picker]::Id($_) -eq 1148 -and [Picker]::Cls($_) -match 'ComboBox' }) | Select-Object -First 1
  if ($openBox) {
    $e = @($kids | Where-Object { [Picker]::Cls($_) -eq 'Edit' -and [Picker]::Inside($_, $openBox) }) | Select-Object -First 1
    if ($e) { $edit = $e; $kind = 'open' }
  }
  if (-not $kind) {
    $e = @($kids | Where-Object { [Picker]::Cls($_) -eq 'Edit' -and [Picker]::Id($_) -eq 1001 -and [Picker]::Cls([Picker]::Parent($_)) -eq 'ComboBox' }) | Select-Object -First 1
    if ($e) { $edit = $e; $kind = 'save' }
  }
  if (-not $kind) { return $null }
  $btn = @($kids | Where-Object { [Picker]::Cls($_) -eq 'Button' -and [Picker]::Id($_) -eq 1 -and [Picker]::Parent($_) -eq $dlg }) | Select-Object -First 1
  $cancel = @($kids | Where-Object { [Picker]::Cls($_) -eq 'Button' -and [Picker]::Id($_) -eq 2 -and [Picker]::Parent($_) -eq $dlg }) | Select-Object -First 1
  $nameCombo = [Picker]::Parent($edit)
  $type = @($kids | Where-Object { [Picker]::Cls($_) -eq 'ComboBox' -and $_ -ne $nameCombo -and -not [Picker]::Inside($edit, $_) -and [Picker]::Id($_) -ne 41477 -and -not @([Picker]::Kids($_) | Where-Object { [Picker]::Cls($_) -eq 'Edit' }).Count }) | Select-Object -First 1
  $addr = @($kids | Where-Object { [Picker]::Cls($_) -eq 'ToolbarWindow32' } | ForEach-Object { [Picker]::GetText($_) } | Where-Object { $_ -match '^[^:\\]{2,20}: [A-Za-z]:\\' }) | Select-Object -First 1
  return [pscustomobject]@{ dlg = $dlg; kind = $kind; edit = $edit; button = $btn; cancel = $cancel;
    title = [Picker]::GetText($dlg); folder = $(if ($addr) { $addr -replace '^[^:\\]{2,20}: ', '' } else { $null });
    file_type = $(if ($type) { [Picker]::GetText($type) } else { $null }) }
}
function Get-Pickers { return @([Picker]::Dialogs([int[]]$livePids) | ForEach-Object { Get-Parts $_ } | Where-Object { $_ }) }
function Describe($p) {
  return [ordered]@{ kind = $p.kind; title = $p.title; folder = $p.folder; file_name = [Picker]::GetText($p.edit); file_type = $p.file_type;
    button = $(if ($p.button) { ([Picker]::GetText($p.button)) -replace '&', '' } else { $null }); live_owned = ($livePids -contains [int][Picker]::Pid($p.dlg)) }
}
# A box's words, best effort: UI Automation by handle reads a task dialog's text when the window isn't cloaked.
function Get-BoxText([IntPtr]$h) {
  try {
    $A = [System.Windows.Automation.AutomationElement]
    $el = $A::FromHandle($h)
    $t = @($el.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text))) | ForEach-Object { $_.Current.Name })
    return (($t -join ' ').Trim())
  } catch { return '' }
}
# #32770 windows of Live's that aren't pickers: Windows' Replace box, an error, or Live's own message box.
function Get-Boxes([IntPtr[]]$except = @()) {
  return @([Picker]::Dialogs([int[]]$livePids) | Where-Object { $except -notcontains $_ -and -not (Get-Parts $_) } | ForEach-Object {
    [pscustomobject]@{ hwnd = $_; title = [Picker]::GetText($_); text = (Get-BoxText $_) } })
}
function Find-One {
  $p = @(Get-Pickers)
  if (-not $p.Count) { Out-Json @{ error = 'no-picker'; message = "No Windows file picker (Save or Open) is open in Live." } }
  if ($p.Count -gt 1) { Out-Json @{ error = 'several'; message = "More than one file picker is open in Live; nothing was pressed." } }
  return $p[0]
}
function Wait-Closed([IntPtr]$dlg, $ms) {
  $t = [Diagnostics.Stopwatch]::StartNew()
  while ($t.ElapsedMilliseconds -lt $ms) { Start-Sleep -Milliseconds 200; if (-not [Picker]::Alive($dlg)) { return $true } }
  return $false
}

if ($Action -eq 'read') {
  $p = @(Get-Pickers)
  $boxes = @(Get-Boxes | ForEach-Object { [ordered]@{ title = $_.title; text = $_.text } })
  if (-not $p.Count) { Out-Json @{ open = $false; boxes = $boxes } }
  Out-Json ([ordered]@{ open = $true; count = $p.Count; picker = (Describe $p[0]); boxes = $boxes })
}

$pk = Find-One

if ($Action -eq 'cancel') {
  $ok = [Picker]::Command($pk.dlg, 2, $(if ($pk.cancel) { $pk.cancel } else { [IntPtr]::Zero }))
  Out-Json @{ pressed = 'Cancel'; sent = $ok; closed = (Wait-Closed $pk.dlg $WaitMs) }
}

# fill
if (-not $Path -or -not [System.IO.Path]::IsPathRooted($Path)) { Out-Json @{ error = 'bad-path'; message = 'Give a full path (like C:\Users\me\Music\song.als), so the picker''s start folder doesn''t matter. Nothing was pressed.' } }
if (-not $pk.button) { Out-Json @{ error = 'no-button'; message = "The picker has no $($pk.kind) button (id 1). Nothing was pressed." } }
$before = Describe $pk
$existed = Test-Path -LiteralPath $Path
if (-not [Picker]::SetText($pk.edit, $Path)) { Out-Json @{ error = 'set-failed'; message = "Setting the File name field didn't go through (the picker didn't answer). Nothing was pressed." } }
Start-Sleep -Milliseconds 100
$retyped = [Picker]::Retype($pk.edit)
Start-Sleep -Milliseconds 150
$now = [Picker]::GetText($pk.edit)
if ($now -ne $Path) { Out-Json @{ error = 'readback'; message = "The File name field reads '$now' after setting it, not the path. Nothing was pressed."; picker = $before } }
$out = [ordered]@{ kind = $pk.kind; title = $before.title; file_type = $before.file_type; folder_before = $before.folder; name_before = $before.file_name; set = $Path; retyped = $retyped; pressed = $before.button }
$boxesBefore = @([Picker]::Dialogs([int[]]$livePids))
$out.sent = [Picker]::Command($pk.dlg, 1, $pk.button)

# Wait for the picker to close. A box that opens meanwhile: over an existing file it's Windows' Replace question
# (answered No, or Yes with -Replace); anything else is left open and reported.
$t = [Diagnostics.Stopwatch]::StartNew(); $answered = @()
while ($t.ElapsedMilliseconds -lt $WaitMs) {
  Start-Sleep -Milliseconds 250
  foreach ($b in @(Get-Boxes $boxesBefore | Where-Object { $answered -notcontains $_.hwnd })) {
    $isReplace = ($b.text -match 'already exists|replace it') -or ($existed -and $pk.kind -eq 'save' -and ($b.title -match 'confirm|replace|save as' -or -not $b.text))
    if ($isReplace) {
      $out.box = [ordered]@{ title = $b.title; text = $b.text }
      $answered += $b.hwnd
      if ($Replace) {
        $out.answered = 'Yes (replace)'; $out.replace_sent = [Picker]::TaskDialogClick($b.hwnd, 6)
        continue
      }
      $out.stopped = 'replace'; $out.answered = 'No'; $out.no_sent = [Picker]::TaskDialogClick($b.hwnd, 7)
      $out.message = 'The file already exists. Windows asked to replace it; No was pressed, so nothing was replaced and the picker is still open.'
      Start-Sleep -Milliseconds 400
      $out.picker_open = [Picker]::Alive($pk.dlg)
      Out-Json $out
    }
    $out.stopped = 'box'; $out.box = [ordered]@{ title = $b.title; text = $b.text }
    $out.message = 'Another box opened after the press. Nothing was pressed in it.'
    $out.picker_open = [Picker]::Alive($pk.dlg)
    Out-Json $out
  }
  if (-not [Picker]::Alive($pk.dlg)) { $out.closed = $true; Out-Json $out }
}
$out.closed = $false
if ([Picker]::Alive($pk.dlg)) { $out.picker_now = Describe $pk }
Out-Json $out
