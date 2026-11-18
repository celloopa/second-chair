# A stand-in for Live's "Separate Stems" window, to check mcp/separate.ps1 without Live. Live's window is drawn by
# Live, so this can only show the UI Automation calls work on the same names and patterns; not that Live answers them.
#   powershell -ExecutionPolicy Bypass -File separate_window.ps1 -Out <file> [-Cloak]
# A WPF window (its CheckBoxes and Buttons have real UIA Toggle and Invoke, like Live's), placed off screen.
# When Separate or Cancel is pressed it writes the tick boxes and the button to <file> as JSON, then closes.
# Closes by itself after -Seconds. test/separate_uia.ps1 runs it and drives it with separate.ps1 -OwnerLike powershell.
param([string]$Out, [int]$Seconds = 30, [switch]$Cloak)
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$w = New-Object System.Windows.Window
$w.Title = 'Separate Stems'; $w.Width = 220; $w.Height = 340; $w.ShowInTaskbar = $false; $w.ShowActivated = $false
$w.WindowStartupLocation = 'Manual'; $w.Left = -3000; $w.Top = -3000  # off screen
$panel = New-Object System.Windows.Controls.StackPanel
$boxes = [ordered]@{}
# The names Live 12.4.16 gives its boxes (seen 2026-11-18); the JSON written below uses the short names.
foreach ($spec in @(@('Vocals, Include or exclude the Vocals stem.', $true), @('Drums, Include or exclude the Drums stem.', $true), @('Bass, Include or exclude the Bass stem.', $true), @('Others, Include or exclude the Others stem.', $true), @('', $false), @('Merge Stems', $false), @('Quality Mode, Choose between High Speed or High Quality.', $true))) {
  $c = New-Object System.Windows.Controls.CheckBox
  $c.Content = $spec[0]; $c.IsChecked = $spec[1]
  [System.Windows.Automation.AutomationProperties]::SetName($c, $spec[0])
  $panel.Children.Add($c) | Out-Null
  if ($spec[0]) { $boxes[($spec[0] -split ', ')[0]] = $c }
}
$done = {
  param($button)
  $state = [ordered]@{ pressed = $button }
  foreach ($k in $boxes.Keys) { $state[$k] = [bool]$boxes[$k].IsChecked }
  ($state | ConvertTo-Json -Compress) | Set-Content -Path $Out -Encoding utf8
  $w.Close()
}
foreach ($name in 'Separate', 'Cancel') {
  $b = New-Object System.Windows.Controls.Button
  $b.Content = $name
  $b.Add_Click({ param($s, $e) & $done ([string]$s.Content) })
  $panel.Children.Add($b) | Out-Null
}
$w.Content = $panel
# -Cloak hides the window the way GlazeWM hides other workspaces (DWMWA_CLOAK; a program may cloak its own windows).
if ($Cloak) {
  Add-Type -Namespace StandIn -Name Dwm -MemberDefinition '[System.Runtime.InteropServices.DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(System.IntPtr h, int a, ref int v, int s);'
  $w.Add_SourceInitialized({ $h = (New-Object System.Windows.Interop.WindowInteropHelper($w)).Handle; $one = 1; [StandIn.Dwm]::DwmSetWindowAttribute($h, 13, [ref]$one, 4) | Out-Null })
}
$t = New-Object System.Windows.Threading.DispatcherTimer
$t.Interval = [TimeSpan]::FromSeconds($Seconds)
$t.Add_Tick({ $w.Close() })
$t.Start()
$w.ShowDialog() | Out-Null
