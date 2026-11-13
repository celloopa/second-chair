// live_screenshot: pictures of Ableton Live's own windows, returned to the MCP client as images.
// Lives in the MCP server, not the Remote Script: Live's embedded Python can't take screenshots.
// Windows: screenshot.ps1 (PrintWindow, so it works when other windows cover Live).
// Mac: screenshot-mac.js lists Live's windows (CoreGraphics, via JXA), then screencapture -l <window id> takes each one,
// which also works when other windows cover Live; sips shrinks it. Needs Screen Recording for the app running this server.
// Both: only Live's windows, never the whole screen.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Shot = { data: string; width: number; height: number; title: string };

export async function captureLive(mode: "main" | "all" = "main", maxWidth = 1600): Promise<Shot[]> {
  if (process.platform === "darwin") return captureLiveMac(mode, maxWidth);
  if (process.platform !== "win32") {
    throw new Error("live_screenshot isn't built for this computer yet (Windows and Mac only).");
  }
  const width = Math.max(400, Math.min(3000, Math.round(maxWidth) || 1600));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cello-live-shot-"));
  const script = path.join(import.meta.dirname, "screenshot.ps1");
  // Full path: apps like HeyClicky start this server with a bare environment, so PATH may be missing.
  const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
        "-Mode", mode, "-MaxWidth", String(width), "-OutDir", dir],
        { timeout: 20000, windowsHide: true, maxBuffer: 1 << 20 },
        (err, stdout, stderr) => (err ? reject(new Error(`Screenshot failed: ${(stderr || err.message).trim().slice(0, 300)}`)) : resolve(stdout)));
    });
    const shots: Shot[] = [];
    for (const line of out.split(/\r?\n/).filter((l) => l.trim().startsWith("{"))) {
      const r = JSON.parse(line) as { error?: string; path?: string; width?: number; height?: number; title?: string };
      if (r.error) throw new Error(r.error);
      shots.push({ data: fs.readFileSync(r.path!).toString("base64"), width: r.width!, height: r.height!, title: r.title ?? "" });
    }
    if (!shots.length) throw new Error("No Live window could be captured.");
    return shots;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- Mac ----------

type MacWin = { id: number; title: string; layer: number; onscreen: boolean; width: number; height: number };

// Full paths: apps like HeyClicky start this server with a bare environment, so PATH may be missing.
const OSASCRIPT = "/usr/bin/osascript", SCREENCAPTURE = "/usr/sbin/screencapture", SIPS = "/usr/bin/sips";
const PERMISSION = "Screen Recording permission is missing. In System Settings > Privacy & Security > Screen Recording, " +
  "turn it on for the app that runs cello-live (Claude, HeyClicky or Terminal), then quit and reopen that app.";

function run(cmd: string, args: string[]): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 1 << 20 }, (e, out, err) =>
      e ? reject(Object.assign(e, { stderr: String(err) })) : resolve({ out: String(out), err: String(err) }));
  });
}

async function captureLiveMac(mode: "main" | "all", maxWidth: number): Promise<Shot[]> {
  const width = Math.max(400, Math.min(3000, Math.round(maxWidth) || 1600));
  let info: { pid: number; screen_recording: boolean; windows: MacWin[] };
  try {
    info = JSON.parse((await run(OSASCRIPT, ["-l", "JavaScript", path.join(import.meta.dirname, "screenshot-mac.js")])).out);
  } catch (e: any) {
    throw new Error(`Screenshot failed: couldn't list Live's windows (${String(e.stderr || e.message).trim().slice(0, 200)}).`);
  }
  // Only normal and floating windows (plugin windows float); skip menus, tooltips and tiny helper windows.
  const wins = info.windows.filter((w) => w.layer >= 0 && w.layer < 24 && w.width >= 80 && w.height >= 60);
  if (info.pid < 0 || !wins.length) throw new Error("Live is not open (no Ableton Live window found).");
  if (!info.screen_recording) throw new Error(PERMISSION);
  // The main window is Live's biggest normal window. If it isn't on screen, it's minimised, hidden or on another desktop.
  const main = wins.filter((w) => w.layer === 0).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? wins[0];
  if (!main.onscreen) throw new Error("Live is minimised, hidden or on another desktop. Restore its window, then try again.");
  const targets = mode === "all" ? [main, ...wins.filter((w) => w !== main && w.onscreen)] : [main];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cello-live-shot-"));
  try {
    const shots: Shot[] = [];
    for (const [i, w] of targets.entries()) {
      const file = path.join(dir, `live-${i + 1}.png`);
      try {
        await run(SCREENCAPTURE, ["-x", "-o", "-t", "png", `-l${w.id}`, file]);
      } catch (e: any) {
        if (w === main) throw new Error(/could not create image|not permitted|denied/i.test(e.stderr || "") ? PERMISSION
          : `Screenshot failed: ${String(e.stderr || e.message).trim().slice(0, 200)}`);
        continue;  // a plugin window that closed meanwhile
      }
      if (!fs.existsSync(file)) { if (w === main) throw new Error(PERMISSION); continue; }
      const size = async () => {
        const o = (await run(SIPS, ["-g", "pixelWidth", "-g", "pixelHeight", file])).out;
        return [Number(/pixelWidth: (\d+)/.exec(o)?.[1]), Number(/pixelHeight: (\d+)/.exec(o)?.[1])];
      };
      let [pw, ph] = await size();
      if (pw > width) { await run(SIPS, ["--resampleWidth", String(width), file]); [pw, ph] = await size(); }
      shots.push({ data: fs.readFileSync(file).toString("base64"), width: pw, height: ph, title: w.title });
    }
    if (!shots.length) throw new Error("No Live window could be captured.");
    return shots;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
