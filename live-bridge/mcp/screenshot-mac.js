// Lists Ableton Live's windows on the Mac (JXA, run by /usr/bin/osascript -l JavaScript) for live_screenshot.
// Prints one JSON object: {"pid", "screen_recording", "windows": [{"id","title","layer","onscreen","width","height"}]}.
// It only reads the window list; screenshot.ts captures the chosen windows with screencapture -l <id>.
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);

function run() {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  let pid = -1;
  for (let i = 0; i < apps.count; i++) {
    const a = apps.objectAtIndex(i);
    if ((ObjC.unwrap(a.bundleIdentifier) || "").indexOf("com.ableton.live") === 0) { pid = a.processIdentifier; break; }
  }
  const windows = [];
  if (pid > 0) {
    const all = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, 0));
    for (let i = 0; i < all.count; i++) {
      const w = ObjC.deepUnwrap(all.objectAtIndex(i));
      if (w.kCGWindowOwnerPID !== pid) continue;
      const b = w.kCGWindowBounds || {};
      windows.push({ id: w.kCGWindowNumber, title: w.kCGWindowName || "", layer: w.kCGWindowLayer,
        onscreen: !!w.kCGWindowIsOnscreen, width: b.Width || 0, height: b.Height || 0 });
    }
  }
  return JSON.stringify({ pid: pid, screen_recording: $.CGPreflightScreenCaptureAccess(), windows: windows });
}
