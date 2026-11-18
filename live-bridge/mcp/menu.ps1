# Reads and fires Ableton Live's menu bar commands (Windows only) for second-chair's live_menu and live_save tools.
# No focus, no mouse, no keys, no clipboard: Live 12 on Windows has a standard Win32 menu bar, so a command can be
# posted to Live's main window as WM_COMMAND, the same message Live gets when you click the menu item.
#   -Action list                      prints the menu tree as JSON. Reads only; sends Live nothing.
#   -Action fire -Path "File|Save…"   walks the menu by item name, refuses an item marked greyed, posts WM_COMMAND.
#   -Action windows                   Live's main window title and the titles of its other visible windows (dialogs,
#                                     plugin windows). Reads only. Live's Save As picker shows up as "Save Live Set As:".
# Seen in Live 12.4.16 (2026-11-18): Live never updates this menu's greyed or ticked marks. Every item reads enabled
# and unticked, even after sending WM_INITMENUPOPUP (what Windows sends when a menu opens), so that refresh was dropped.
# Whether a command applies (a clip selected, say) shows only in Live itself.
# Names are matched exactly as Live shows them, without "&" and without the shortcut after the tab. Node does the
# fuzzy matching and the allow-list; this script refuses anything it can't find exactly.
# Prints one JSON object; on trouble {"error": "..."}.
param(
  [ValidateSet('list', 'fire', 'windows')] [string]$Action = 'list',
  [string]$Path = ''
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class LiveMenu {
  [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr m);
  [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr m, int i);
  [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr m, int i);
  [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr m, uint id, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetMenuString(IntPtr m, uint id, StringBuilder s, int max, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static string Name(IntPtr m, int i) { var sb = new StringBuilder(512); GetMenuString(m, (uint)i, sb, 512, 0x400); return sb.ToString(); }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static System.Collections.Generic.List<string> OtherTitles(uint pid, IntPtr main) {
    var list = new System.Collections.Generic.List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && h != main && IsWindowVisible(h)) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); if (sb.Length > 0) list.Add(sb.ToString()); }
      return true; }, IntPtr.Zero);
    return list;
  }
}
'@
function Out-Json($o) { $o | ConvertTo-Json -Compress -Depth 8; exit 0 }
# "&File" -> "File"; "Save Live Set\tCtrl+S" -> name "Save Live Set", keys "Ctrl+S"
function Split-Label([string]$raw) {
  $parts = $raw -split "`t", 2
  $mark = [string][char]1
  $name = ($parts[0].Replace('&&', $mark).Replace('&', '').Replace($mark, '&')).Trim()
  $keys = if ($parts.Count -gt 1) { $parts[1].Trim() } else { '' }
  return $name, $keys
}
# MF_GRAYED 0x1, MF_DISABLED 0x2, MF_CHECKED 0x8, MF_SEPARATOR 0x800
function Read-Items([IntPtr]$m, [bool]$deep) {
  $items = @()
  $n = [LiveMenu]::GetMenuItemCount($m)
  for ($i = 0; $i -lt $n; $i++) {
    # for a submenu the high byte of the state is its item count, so only the low byte holds flags there
    $sub = [LiveMenu]::GetSubMenu($m, $i)
    $st = [LiveMenu]::GetMenuState($m, [uint32]$i, 0x400)
    if ($sub -ne [IntPtr]::Zero) { $st = $st -band 0xFF } elseif ($st -band 0x800) { continue }
    $name, $keys = Split-Label ([LiveMenu]::Name($m, $i))
    if (-not $name) { continue }
    $item = [ordered]@{ name = $name; enabled = -not [bool]($st -band 3); checked = [bool]($st -band 8) }
    if ($keys) { $item.keys = $keys }
    if ($sub -ne [IntPtr]::Zero) { if ($deep) { $item.items = @(Read-Items $sub $true) } else { $item.submenu = $true } }
    else { $item.id = [int][LiveMenu]::GetMenuItemID($m, $i) }
    $items += [pscustomobject]$item
  }
  return $items
}

$live = Get-Process | Where-Object { $_.ProcessName -like 'Ableton Live*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $live) { Out-Json @{ error = 'no-window'; message = "Live is not open (no Ableton Live window found)." } }
$win = $live.MainWindowHandle
if ($Action -eq 'windows') { Out-Json @{ title = $live.MainWindowTitle; windows = @([LiveMenu]::OtherTitles([uint32]$live.Id, $win)) } }
$bar = [LiveMenu]::GetMenu($win)
if ($bar -eq [IntPtr]::Zero) { Out-Json @{ error = 'no-menu'; message = "Live's window has no Windows menu bar here, so menu commands can't be sent without the screen." } }
$version = try { $live.MainModule.FileVersionInfo.ProductVersion } catch { '' }

if ($Action -eq 'list') {
  $menus = @()
  $n = [LiveMenu]::GetMenuItemCount($bar)
  for ($i = 0; $i -lt $n; $i++) {
    $name, $keys = Split-Label ([LiveMenu]::Name($bar, $i))
    $sub = [LiveMenu]::GetSubMenu($bar, $i)
    if ($sub -eq [IntPtr]::Zero) { continue }
    $menus += [pscustomobject]@{ name = $name; items = @(Read-Items $sub $true) }
  }
  Out-Json @{ title = $live.MainWindowTitle; version = $version; menus = $menus }
}

# fire: walk "Top|Sub|Item" by exact name
$names = @($Path -split '\|' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($names.Count -lt 2) { Out-Json @{ error = 'bad-path'; message = "A menu path needs a menu and an item, like File > Save Live Set." } }
$m = $bar
for ($d = 0; $d -lt $names.Count; $d++) {
  $want = $names[$d]; $found = -1
  $n = [LiveMenu]::GetMenuItemCount($m)
  for ($i = 0; $i -lt $n; $i++) {
    $name, $keys = Split-Label ([LiveMenu]::Name($m, $i))
    if ($name -ceq $want) { $found = $i; break }
  }
  if ($found -lt 0) { Out-Json @{ error = 'not-found'; message = "Live's menu has no item called `"$want`" there."; at = $d } }
  if ($d -lt $names.Count - 1) {
    $sub = [LiveMenu]::GetSubMenu($m, $found)
    if ($sub -eq [IntPtr]::Zero) { Out-Json @{ error = 'not-found'; message = "`"$want`" is a command, not a menu."; at = $d } }
    $m = $sub
  }
}
if ([LiveMenu]::GetSubMenu($m, $found) -ne [IntPtr]::Zero) { Out-Json @{ error = 'not-found'; message = "`"$($names[-1])`" opens a submenu; name one of its items." } }
$id = [LiveMenu]::GetMenuItemID($m, $found)
$st = [LiveMenu]::GetMenuState($m, [uint32]$found, 0x400)
if ($st -band 3) { Out-Json @{ error = 'disabled'; message = "Live has `"$($names -join ' > ')`" greyed out right now."; id = [int]$id } }
if (-not [LiveMenu]::IsWindow($win)) { Out-Json @{ error = 'no-window'; message = "Live's window closed." } }
# WM_COMMAND, wParam = item id (high word 0: from a menu), lParam = 0
$ok = [LiveMenu]::PostMessage($win, 0x0111, [IntPtr][int]$id, [IntPtr]::Zero)
if (-not $ok) { Out-Json @{ error = 'post-failed'; message = "Windows refused to pass the command to Live." } }
Out-Json @{ fired = $true; id = [int]$id; title = $live.MainWindowTitle; version = $version }
