# Captures Ableton Live's windows (Windows only) for cello-live's live_screenshot tool.
# Only Live's own windows: the main window, and with -Mode all also its open plugin and device windows.
# Never the whole screen. Works even when another window covers Live (PrintWindow), not when Live is minimised.
# Prints one JSON object per captured window: {"path","width","height","title"}; or {"error": "..."}.
param(
  [ValidateSet('main', 'all')] [string]$Mode = 'main',
  [int]$MaxWidth = 1600,
  [Parameter(Mandatory = $true)] [string]$OutDir
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CelloWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public static List<IntPtr> WindowsOf(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
}
'@
[void][CelloWin]::SetProcessDPIAware()  # real pixels on scaled displays

$live = Get-Process | Where-Object { $_.ProcessName -like 'Ableton Live*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $live) { '{"error":"Live is not open (no Ableton Live window found)."}'; exit 0 }

$main = $live.MainWindowHandle
$targets = if ($Mode -eq 'all') { [CelloWin]::WindowsOf([uint32]$live.Id) } else { @($main) }
# main window first, then the others; skip tiny helper windows
$targets = @($main) + @($targets | Where-Object { $_ -ne $main })
New-Item -ItemType Directory -Force $OutDir | Out-Null
$n = 0
foreach ($h in $targets) {
  if ([CelloWin]::IsIconic($h)) {
    if ($h -eq $main) { '{"error":"Live is minimised. Restore its window, then try again."}' }
    continue
  }
  $r = New-Object CelloWin+RECT
  [void][CelloWin]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left; $hgt = $r.Bottom - $r.Top
  if ($w -lt 80 -or $hgt -lt 60) { continue }
  $bmp = New-Object System.Drawing.Bitmap $w, $hgt
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [CelloWin]::PrintWindow($h, $hdc, 2)  # 2 = PW_RENDERFULLCONTENT: works for GPU-drawn windows like Live's
  $g.ReleaseHdc($hdc); $g.Dispose()
  if (-not $ok) {
    # fall back to copying the screen area (only right if nothing covers the window)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size); $g.Dispose()
  }
  $out = $bmp
  if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
    $sh = [int][Math]::Round($hgt * $MaxWidth / $w)
    $out = New-Object System.Drawing.Bitmap $MaxWidth, $sh
    $g = [System.Drawing.Graphics]::FromImage($out)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($bmp, 0, 0, $MaxWidth, $sh); $g.Dispose(); $bmp.Dispose()
  }
  $n++
  $path = Join-Path $OutDir ("live-$n.png")
  $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  [pscustomobject]@{ path = $path; width = $out.Width; height = $out.Height; title = [CelloWin]::Title($h) } | ConvertTo-Json -Compress
  $out.Dispose()
}
