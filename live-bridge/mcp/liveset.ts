// Which Live set is open. Since Remote Script 0.11.0 the name and file come from Live's API (Song.name, Song.file_path:
// an empty path means a new, never-saved set). Live's API has no "unsaved changes" flag, so the * still comes from
// Live's window title, and an older Remote Script falls back to the title for everything.
// Windows: "my-song* - Ableton Live 12 Suite" (the * means unsaved changes). A new set is "Untitled".
// Mac: the window name, read through System Events (needs Accessibility permission; a guess until checked on the Mac).
// SECOND_CHAIR_LIVE_TITLE overrides the title, for tests.
import { execFile } from "node:child_process";

export type OpenSet = { name: string; unsaved: boolean; untitled: boolean; warning?: string } | { unknown: string };

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(String(out)))));
}

async function liveTitle(): Promise<string> {
  if (process.env.SECOND_CHAIR_LIVE_TITLE !== undefined) return process.env.SECOND_CHAIR_LIVE_TITLE;
  if (process.platform === "win32") {
    return (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-Process | Where-Object { $_.ProcessName -like 'Ableton Live*' -and $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle"])).trim();
  }
  if (process.platform === "darwin") {
    return (await run("osascript", ["-e",
      'tell application "System Events" to get name of front window of (first application process whose name begins with "Live")'])).trim();
  }
  return "";
}

export function parseTitle(title: string): OpenSet {
  const t = title.trim();
  if (!t) return { unknown: "Couldn't find Live's window to read the set name." };
  // Windows adds " - Ableton Live 12 Suite"; the Mac window name may be the set name alone.
  let name = t.replace(/\s+-\s+Ableton Live.*$/i, "").trim();
  const unsaved = /\*$/.test(name);
  name = name.replace(/\*$/, "").trim();
  const untitled = /^untitled\b/i.test(name) || name === "";
  const out: OpenSet = { name: name || "Untitled", unsaved, untitled };
  if (untitled) out.warning = "This is a new, unsaved set, not one of the user's songs. Live may have opened an empty set. Ask the user before changing anything here.";
  return out;
}

export async function openSet(): Promise<OpenSet> {
  try { return parseTitle(await liveTitle()); } catch (e) { return { unknown: `Couldn't read Live's window title (${(e as Error).message}).` }; }
}

/** The set as Live's API reports it (Remote Script 0.11.0+), with the * (unsaved changes) from the window title. */
export type ApiSet = { name?: string | null; path?: string | null };
export function mergeSet(title: OpenSet, api?: ApiSet | null): OpenSet & { path?: string; source?: string } {
  if (!api || (api.name == null && api.path == null)) return title;
  const file = String(api.path ?? "");
  const known = !("unknown" in title);
  const fromTitle = known ? title as { name: string; unsaved: boolean; untitled: boolean } : null;
  if (file) {
    const name = String(api.name || "").replace(/\.als$/i, "") || file.replace(/^.*[\\/]/, "").replace(/\.als$/i, "");
    const out: Record<string, unknown> = { name, unsaved: fromTitle ? fromTitle.unsaved : null, untitled: false, path: file, source: "Live's API (the * from the window title)" };
    if (!fromTitle) out.note = `Couldn't read Live's window title, so whether there are unsaved changes is unknown. ${(title as { unknown: string }).unknown}`;
    return out as never;
  }
  const out: Record<string, unknown> = { name: String(api.name || "") || fromTitle?.name || "Untitled", unsaved: fromTitle ? fromTitle.unsaved : null, untitled: true, path: "",
    source: "Live's API: the set has no file yet",
    warning: "This is a new, unsaved set, not one of the user's songs. Live may have opened an empty set. Ask the user before changing anything here." };
  return out as never;
}
