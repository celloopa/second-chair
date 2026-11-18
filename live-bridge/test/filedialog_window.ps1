# A stand-in for Live's file pickers, to check mcp/filedialog.ps1 without Live. Live's Save As, Save a Copy and Export
# pickers are Windows' own common file dialogs, so this opens the same kind of dialog (class #32770) from PowerShell,
# owned by an invisible window off screen.
#   powershell -ExecutionPolicy Bypass -File filedialog_window.ps1 -Out <file> [-Kind save|open] [-Folder <dir>] [-Name <suggested>]
# When the picker closes it writes {"result": "OK"|"Cancel", "file": "<chosen path>"} to <file>. After -Seconds it closes
# its own picker with WM_CLOSE (never keys, which would go to whatever window has focus).
# test/filedialog_uia.ps1 runs it and drives it with filedialog.ps1 -OwnerLike powershell.
param([string]$Out, [ValidateSet('save', 'open')] [string]$Kind = 'save', [string]$Folder = $env:TEMP, [int]$Seconds = 40, [string]$Name = '')
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class StandIn {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint t, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  public static void ClosePickers() {
    EnumThreadWindows(GetCurrentThreadId(), (h, l) => {
      var s = new StringBuilder(64); GetClassName(h, s, 64);
      if (s.ToString() == "#32770") PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
  }
}
'@
# When started with -WindowStyle Hidden, Windows applies "hidden" to the first window this process shows; use it up here.
$dummy = New-Object System.Windows.Forms.Form
$dummy.ShowInTaskbar = $false; $dummy.Opacity = 0; $dummy.Show(); $dummy.Hide(); $dummy.Dispose()
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = 'Manual'; $owner.Location = New-Object System.Drawing.Point(-4000, -4000)
$owner.Size = New-Object System.Drawing.Size(10, 10); $owner.ShowInTaskbar = $false; $owner.Opacity = 0
$dlg = if ($Kind -eq 'save') { New-Object System.Windows.Forms.SaveFileDialog } else { New-Object System.Windows.Forms.OpenFileDialog }
$dlg.Title = $(if ($Kind -eq 'save') { 'Save a Copy:' } else { 'Import Audio/MIDI File' })
$dlg.Filter = $(if ($Kind -eq 'save') { 'Live Set (*.als)|*.als' } else { 'Audio files (*.wav;*.aif)|*.wav;*.aif|All files (*.*)|*.*' })
$dlg.InitialDirectory = $Folder
if ($Kind -eq 'save') { $dlg.OverwritePrompt = $true }
# Live suggests a name in its Save pickers ("ZZ Scratch Copy"); -Name does the same.
if ($Name) { $dlg.FileName = $Name }
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $Seconds * 1000
$timer.Add_Tick({ $timer.Stop(); [StandIn]::ClosePickers() })
$owner.Add_Shown({
  $timer.Start()
  $r = $dlg.ShowDialog($owner)
  (@{ result = [string]$r; file = $dlg.FileName } | ConvertTo-Json -Compress) | Set-Content -Path $Out -Encoding utf8
  $owner.Close()
})
[System.Windows.Forms.Application]::Run($owner)
