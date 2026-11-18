# A stand-in for Live's "Export Audio/Video" window, to check mcp/livewindow.ps1 and the export flow without Live.
# Live's window is drawn by Live; this WPF window copies its control names (Live 12.4.16, seen 2026-11-18) so the UI
# Automation calls can be checked, not how Live answers them.
#   powershell -ExecutionPolicy Bypass -File export_window.ps1 -Out <file> [-Length 8] [-Cloak]
# Export opens a real Windows save picker (as Live does) and, when it closes, writes {"pressed": "Export", "result":
# "OK"|"Cancel", "file": ...} to <file>. Cancel writes {"pressed": "Cancel"}. Closes by itself after -Seconds.
param([string]$Out, [int]$Seconds = 40, [int]$Length = 8, [switch]$Cloak)
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$w = New-Object System.Windows.Window
$w.Title = 'Export Audio/Video'; $w.Width = 300; $w.Height = 600; $w.ShowInTaskbar = $false; $w.ShowActivated = $false
$w.WindowStartupLocation = 'Manual'; $w.Left = -3000; $w.Top = -3000
$panel = New-Object System.Windows.Controls.StackPanel
function Add-Named($ctl, $name) { [System.Windows.Automation.AutomationProperties]::SetName($ctl, $name); $panel.Children.Add($ctl) | Out-Null; $ctl }
function Add-Combo($name, $value) { $c = New-Object System.Windows.Controls.ComboBox; $c.IsEditable = $true; $c.Text = $value; Add-Named $c $name | Out-Null }
function Add-Slider($name, $value) { $s = New-Object System.Windows.Controls.Slider; $s.Minimum = 0; $s.Maximum = 999; $s.Value = $value; Add-Named $s $name | Out-Null }
Add-Combo 'Rendered Track Chooser' 'Main'
Add-Slider 'Start of Rendered Audio File (Bar)' 1; Add-Slider 'Start of Rendered Audio File (Beat)' 1; Add-Slider 'Start of Rendered Audio File (Sixteenths)' 1
Add-Slider 'Length of Rendered Audio File (Bar)' $Length; Add-Slider 'Length of Rendered Audio File (Beat)' 0; Add-Slider 'Length of Rendered Audio File (Sixteenths)' 0
Add-Combo 'Sample Rate' '48000'; Add-Combo 'File Type' 'WAV'; Add-Combo 'Recording Bit Depth' '24'
foreach ($opt in 'Render as Loop', 'Normalize', 'Encode MP3') { $t = New-Object System.Windows.Controls.Primitives.ToggleButton; $t.Content = $opt; Add-Named $t $opt | Out-Null }
$enc = New-Object System.Windows.Controls.Primitives.ToggleButton; $enc.Content = 'Encode PCM'; $enc.IsChecked = $true; Add-Named $enc 'Encode PCM' | Out-Null
$done = { param($o) ($o | ConvertTo-Json -Compress) | Set-Content -Path $Out -Encoding utf8 }
$export = New-Object System.Windows.Controls.Button; $export.Content = 'Export'; Add-Named $export 'Export' | Out-Null
$cancel = New-Object System.Windows.Controls.Button; $cancel.Content = 'Cancel'; Add-Named $cancel 'Cancel' | Out-Null
$export.Add_Click({
  $w.Hide()
  $d = New-Object Microsoft.Win32.SaveFileDialog
  $d.Title = 'Export Audio/Video'; $d.Filter = 'WAV (*.wav)|*.wav'; $d.InitialDirectory = $env:TEMP; $d.FileName = 'Untitled'
  $r = $d.ShowDialog()
  & $done @{ pressed = 'Export'; result = $(if ($r) { 'OK' } else { 'Cancel' }); file = $d.FileName }
  if ($r) { Set-Content -Path $d.FileName -Value 'rendered by the stand-in' }
  $w.Close()
})
$cancel.Add_Click({ & $done @{ pressed = 'Cancel' }; $w.Close() })
$w.Content = $panel
if ($Cloak) {
  Add-Type -Namespace StandIn -Name Dwm -MemberDefinition '[System.Runtime.InteropServices.DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(System.IntPtr h, int a, ref int v, int s);'
  $w.Add_SourceInitialized({ $h = (New-Object System.Windows.Interop.WindowInteropHelper($w)).Handle; $one = 1; [StandIn.Dwm]::DwmSetWindowAttribute($h, 13, [ref]$one, 4) | Out-Null })
}
$t = New-Object System.Windows.Threading.DispatcherTimer
$t.Interval = [TimeSpan]::FromSeconds($Seconds)
$t.Add_Tick({ $w.Close() })
$t.Start()
$w.ShowDialog() | Out-Null
