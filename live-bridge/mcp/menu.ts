// live_menu and live_save: fire Live's own menu commands without the screen.
// Live's Python API has no save, export, group, freeze or stem calls, so these go through Live's menu bar instead.
// Windows: menu.ps1 posts WM_COMMAND to Live's main window (Live 12 has a standard Win32 menu bar there). No focus,
//   no mouse, no keys, no clipboard: Live can stay in the background.
// Mac: menu-mac.js clicks the menu item through System Events (needs Accessibility). Written but NOT TESTED on a Mac yet.
// Items are found by name, never by position or number, and only commands on the allow-list below are fired.
// Tests: SECOND_CHAIR_LIVE_MENU points at a JSON menu instead of real Live ({"window": false} = Live not open).
import { execFile } from "node:child_process";
import fs from "node:fs";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import { openSet, parseTitle } from "./liveset.ts";

export type MenuItem = { name: string; enabled: boolean; checked: boolean; keys?: string; id?: number; items?: MenuItem[] };
export type MenuTree = { title?: string; version?: string; menus: { name: string; items: MenuItem[] }[] };
type FireResult = { fired: true; id?: number; title?: string; version?: string };

const FALLBACK = "computer use stays the fallback: it can click the menu, but it takes over the screen for a moment";

// ---------- names and paths ----------

/** "Save Live Set As…" / "&Save live set as..." -> "save live set as" */
export const norm = (s: string) => s.replace(/&/g, "").replace(/(\.\.\.|…)\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
export const splitPath = (p: string) => String(p).split(/\s*[>›]\s*/).map((x) => x.trim()).filter(Boolean);
const show = (names: string[]) => names.join(" > ");

/** Every command in the tree, as its list of raw names. */
export function leaves(tree: MenuTree): { names: string[]; item: MenuItem }[] {
  const out: { names: string[]; item: MenuItem }[] = [];
  const walk = (items: MenuItem[], at: string[]) => {
    for (const it of items) {
      if (it.items) walk(it.items, [...at, it.name]);
      else if (it.name && it.name !== "*" && !/^dummy$/i.test(it.name)) out.push({ names: [...at, it.name], item: it });
    }
  };
  for (const m of tree.menus) walk(m.items, [m.name]);
  return out;
}

function lev(a: string, b: string) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
/** Up to five real menu paths that look like what was asked for. */
export function closeMatches(tree: MenuTree, want: string, n = 5): string[] {
  const w = splitPath(want).map(norm), wLast = w[w.length - 1] ?? "", wWords = new Set(w.join(" ").split(/[\s/]+/).filter((x) => x.length > 2));
  return leaves(tree).map(({ names }) => {
    const p = names.map(norm), last = p[p.length - 1];
    const words = p.join(" ").split(/[\s/]+/);
    const shared = words.filter((x) => wWords.has(x)).length;
    const dist = lev(wLast, last) / Math.max(wLast.length, last.length, 1);
    const top = w.length > 1 && p[0] === w[0] ? 0.15 : 0;
    return { path: show(names), score: shared * 0.3 + (1 - dist) + top, dist, shared };
  }).filter((c) => c.shared > 0 || c.dist < 0.5).sort((a, b) => b.score - a.score).slice(0, n).map((c) => c.path);
}

/** The menu item a path names, matched by name (case, "&" and a trailing "..." don't matter). */
export function resolve(tree: MenuTree, want: string): { names: string[]; item: MenuItem } | null {
  const w = splitPath(want).map(norm);
  if (w.length < 2) return null;
  return leaves(tree).find(({ names }) => names.length === w.length && names.every((x, i) => norm(x) === w[i])) ?? null;
}

// ---------- the allow-list ----------
// Only commands that open a dialog (nothing changes until the user confirms it there), change only the view, or save.
// Commands that could lose work are refused by name. Everything else is refused as "not on the list".

type Kind = "save" | "dialog" | "view";
const LOSES_WORK: Record<string, string> = {
  "file > new live set": "it replaces the open set",
  "file > open live set": "it replaces the open set",
  "file > close window": "it can close Live's window and the set",
  "file > quit": "it quits Live",
  "live > quit live": "it quits Live",
  "file > save live set as default set": "it overwrites the set every new set starts from",
  "help > load demo set": "it replaces the open set",
};
const ALLOW: Record<string, Kind> = {
  "file > save live set": "save",
  "file > save live set as": "dialog",
  "file > save a copy": "dialog",
  "file > collect all and save": "dialog",
  "file > save live set as template": "dialog",
  "file > export audio/video": "dialog",
  "file > export midi clip": "dialog",
  "file > add folder to browser": "dialog",
  "file > manage files": "view",
  "edit > quantize settings": "dialog",
  "create > separate stems to new audio tracks": "dialog",
  "create > import audio/midi file": "dialog",
  "options > settings": "dialog",
  "live > settings": "dialog",
  "navigate > session view": "view", "navigate > arrangement view": "view", "navigate > clip view": "view",
  "navigate > device view": "view", "navigate > browser": "view", "navigate > groove pool": "view",
  "navigate > help view": "view", "navigate > mixer": "view", "navigate > clip panels": "view",
};
// The View menu only changes what Live shows, except these.
const VIEW_SKIP = new Set(["view > full screen", "view > second window"]);

export function classify(names: string[]): { kind: Kind } | { refused: string } {
  const key = names.map(norm).join(" > ");
  if (LOSES_WORK[key]) return { refused: `"${show(names)}" is never fired by this tool: ${LOSES_WORK[key]}, so it could lose work. Ask the user to do it by hand.` };
  if (names.length >= 2 && norm(names[0]) === "file" && norm(names[1]) === "open recent set") return { refused: `"${show(names)}" is never fired by this tool: it replaces the open set, so it could lose work.` };
  if (ALLOW[key]) return { kind: ALLOW[key] };
  if (norm(names[0]) === "view" && !VIEW_SKIP.has(key)) return { kind: "view" };
  return { refused: `"${show(names)}" isn't on live_menu's list. The list holds commands that open a dialog, change only the view, or save; this one changes the set, a setting or the transport. Ask the user to do it by hand.` };
}

// ---------- reading and firing ----------

function run(cmd: string, args: string[], timeout = 20000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (e, out, err) =>
      e ? reject(new Error(String(err || e.message).trim().slice(0, 300))) : resolve(String(out))));
}
// Full path: apps like HeyClicky start this server with a bare environment, so PATH may be missing.
const PS = () => path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

async function windowsMenu(args: string[]): Promise<any> {
  const out = await run(PS(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dirname, "menu.ps1"), ...args]);
  const line = out.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error("Reading Live's menu gave no answer.");
  return JSON.parse(line);
}
async function macMenu(args: string[]): Promise<any> {
  const out = await run("/usr/bin/osascript", ["-l", "JavaScript", path.join(import.meta.dirname, "menu-mac.js"), ...args]);
  return JSON.parse(out.trim());
}
const fixture = () => process.env.SECOND_CHAIR_LIVE_MENU;
function readFixture(): any { return JSON.parse(fs.readFileSync(fixture()!, "utf8")); }

class MenuError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
const fail = (r: { error: string; message?: string }) => { throw new MenuError(r.error, r.message || r.error); };

let cache: MenuTree | null = null;
/** Live's menu tree. Read once per Live version and kept (also saved to ~/SecondChair/live-menu-<version>.json). */
export async function readMenu(fresh = false): Promise<MenuTree> {
  if (fixture()) { const f = readFixture(); if (f.window === false) fail({ error: "no-window", message: "Live is not open (no Ableton Live window found)." }); return f; }
  if (cache && !fresh) return cache;
  let r: any;
  if (process.platform === "win32") r = await windowsMenu(["-Action", "list"]);
  else if (process.platform === "darwin") r = await macMenu(["list"]);
  else throw new MenuError("platform", "live_menu works on Windows and the Mac only.");
  if (r.error) fail(r);
  cache = r as MenuTree;
  try {
    const dir = process.env.SECOND_CHAIR_STATE_DIR || path.join(os.homedir(), "SecondChair");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `live-menu-${String(cache.version || "unknown").replace(/[^\w.-]/g, "_")}.json`), JSON.stringify(cache, null, 1));
  } catch { /* the saved copy is only for reference */ }
  return cache;
}

async function fireNames(names: string[]): Promise<FireResult> {
  if (fixture()) {
    const hit = resolve(readFixture(), names.join(" > "));
    if (!hit) fail({ error: "not-found", message: `Live's menu has no "${show(names)}".` });
    if (!hit!.item.enabled) fail({ error: "disabled", message: `Live has "${show(names)}" greyed out right now.` });
    const log = path.join(process.env.SECOND_CHAIR_STATE_DIR || os.tmpdir(), "menu-fired.jsonl");
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), path: show(names) }) + "\n");
    // a test menu can say which window a command opens ("opens": {"File > Save Live Set": "Save Live Set As:"})
    const f = readFixture(), opens = f.opens?.[show(hit!.names)];
    if (opens) { f.windows = [...(f.windows ?? []), opens]; fs.writeFileSync(fixture()!, JSON.stringify(f)); }
    return { fired: true, id: hit!.item.id, title: f.title };
  }
  // Tests override the window title; never let them reach the real Live that may be open at the same time.
  if (process.env.SECOND_CHAIR_LIVE_TITLE !== undefined) fail({ error: "test-mode", message: "Test mode (SECOND_CHAIR_LIVE_TITLE is set): live_menu won't touch the real Live. Set SECOND_CHAIR_LIVE_MENU to a test menu." });
  let r: any;
  if (process.platform === "win32") r = await windowsMenu(["-Action", "fire", "-Path", names.join("|")]);
  else if (process.platform === "darwin") r = await macMenu(["fire", ...names]);
  else throw new MenuError("platform", "live_menu works on Windows and the Mac only.");
  if (r.error) fail(r);
  if (cache && r.version && cache.version && r.version !== cache.version) cache = null;
  return r as FireResult;
}

const ON_MAC = process.platform === "darwin";

/** Live's main window title and its other open windows (dialogs, plugin windows). Windows only; null elsewhere. */
export async function liveWindows(): Promise<{ title: string; windows: string[] } | null> {
  if (fixture()) { const f = readFixture(); return f.window === false ? null : { title: f.title ?? "", windows: f.windows ?? [] }; }
  if (process.platform !== "win32" || process.env.SECOND_CHAIR_LIVE_TITLE !== undefined) return null;
  try { const r = await windowsMenu(["-Action", "windows"]); return r.error ? null : { title: r.title ?? "", windows: r.windows ?? [] }; }
  catch { return null; }
}
const newWindows = (before: string[] | undefined, now: string[] | undefined) => {
  const left = [...(before ?? [])];
  return (now ?? []).filter((w) => { const i = left.indexOf(w); if (i >= 0) { left.splice(i, 1); return false; } return true; });
};
const quoted = (xs: string[]) => xs.map((x) => `"${x}"`).join(", ");
/** Fire one allowed menu command by its path, e.g. "File > Save Live Set". */
export async function liveMenu(want: string, opts: { allowSave?: boolean } = {}) {
  if (!String(want ?? "").trim()) throw new Error("Give a menu path, like \"View > Browser\" or \"File > Save Live Set\".");
  let tree: MenuTree;
  try { tree = await readMenu(); } catch (e) { throw new Error(`${(e as Error).message} Nothing was fired.`); }
  let hit = resolve(tree, want);
  if (!hit) { try { tree = await readMenu(true); hit = resolve(tree, want); } catch { /* keep the old list */ } }
  if (!hit) {
    const near = closeMatches(tree, want);
    throw new Error(`Live's menu has no "${show(splitPath(want))}". Nothing was fired.` +
      (near.length ? ` Close matches: ${near.map((x) => `"${x}"`).join(", ")}.` : " Menus: " + tree.menus.map((m) => m.name).join(", ") + "."));
  }
  const c = classify(hit.names);
  if ("refused" in c) throw new Error(c.refused + " Nothing was fired.");
  if (c.kind === "save" && !opts.allowSave) throw new Error("To save, use live_save: it checks the set has a file and confirms the save landed. Nothing was fired.");
  const before = c.kind === "dialog" ? await liveWindows() : null;
  let r: FireResult;
  try { r = await fireNames(hit.names); }
  catch (e) {
    const code = (e as MenuError).code;
    if (code === "disabled") throw new Error(`${(e as Error).message} Nothing was fired. It may need a selection first (a clip or a track).`);
    throw new Error(`${(e as Error).message} Nothing was fired${code === "test-mode" ? "" : `; ${FALLBACK}`}.`);
  }
  const out: Record<string, unknown> = {
    fired: show(hit.names), kind: c.kind,
    how: ON_MAC ? "clicked through System Events (Mac route: not yet tested)" : "posted to Live's window as a menu command; Live stayed where it was (no focus, mouse, keys or clipboard)",
  };
  // Live 12.4.16 on Windows never greys out or ticks its menu items, so a command that doesn't apply right now
  // (nothing selected, say) is still sent, and Live just ignores it. Only a look at Live shows what happened.
  if (!ON_MAC) out.check = "Live doesn't mark greyed-out commands on Windows, so this was sent without knowing whether it applies right now. Check with live_screenshot.";
  if (c.kind === "dialog") {
    // Look for the window it opened, for up to 3 s.
    let opened: string[] = [];
    for (let i = 0; before && i < 10 && !opened.length; i++) { await new Promise((res) => setTimeout(res, 300)); opened = newWindows(before.windows, (await liveWindows())?.windows); }
    if (opened.length) out.dialog = `opened: ${quoted(opened)}`;
    else if (before) out.dialog = "no new window seen yet; it may still be opening, or Live ignored the command (for example, nothing it applies to is selected). Check with live_screenshot.";
    out.next = "Nothing changes until the user confirms the dialog in Live; tell them it's open (it may sit behind other windows), and press nothing in it yourself. If it's a Windows file picker (Save As, Save a Copy, Import), live_file_dialog can fill it with a path the user gave.";
  }
  if (c.kind === "view") out.next = "Only the view changed.";
  return out;
}

// ---------- live_save ----------

/** Live's Log.txt (newest Live version), or SECOND_CHAIR_LIVE_LOG. */
export function liveLog(): string | null {
  if (process.env.SECOND_CHAIR_LIVE_LOG !== undefined) return process.env.SECOND_CHAIR_LIVE_LOG || null;
  const base = process.platform === "win32" ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Ableton")
    : path.join(os.homedir(), "Library", "Preferences", "Ableton");
  try {
    const logs = fs.readdirSync(base).filter((d) => /^Live \d/.test(d))
      .map((d) => process.platform === "win32" ? path.join(base, d, "Preferences", "Log.txt") : path.join(base, d, "Log.txt"))
      .filter((f) => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return logs[0] ?? null;
  } catch { return null; }
}
const logSize = (f: string | null) => { try { return f ? fs.statSync(f).size : 0; } catch { return 0; } };
function newMessageBoxes(f: string | null, from: number): string[] {
  if (!f) return [];
  try {
    const size = fs.statSync(f).size;
    if (size <= from) return [];
    const fd = fs.openSync(f, "r"); const buf = Buffer.alloc(Math.min(size - from, 1 << 20));
    fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd);
    return buf.toString("utf8").split(/\r?\n/).filter((l) => l.includes("Message Box:")).map((l) => l.replace(/^.*Message Box:\s*/, ""));
  } catch { return []; }
}

/** Files that could be the open set: "<name>.als" in the Projects folder, its project folders, and folders Live opened sets from. */
export function setFiles(name: string): string[] {
  const roots = new Set<string>();
  for (const d of (process.env.SECOND_CHAIR_PROJECT_DIRS ?? "").split(path.delimiter).filter(Boolean)) roots.add(d);
  if (process.env.SECOND_CHAIR_PROJECT_DIRS === undefined) {
    roots.add(path.join(os.homedir(), "Music", "Ableton", "Projects"));
    roots.add(path.join(os.homedir(), "Music", "Ableton"));
  }
  const dirs = new Set<string>();
  for (const r of roots) {
    dirs.add(r);
    try { for (const e of fs.readdirSync(r, { withFileTypes: true })) if (e.isDirectory()) dirs.add(path.join(r, e.name)); } catch { /* missing */ }
  }
  const log = liveLog();
  if (log) {
    try {
      const text = fs.readFileSync(log, "utf8");
      for (const m of text.matchAll(/Loading document "([^"]+\.als)"/g)) if (!/[\\/](ProgramData|Resources|Preferences)[\\/]/i.test(m[1])) dirs.add(path.dirname(m[1]));
    } catch { /* no log */ }
  }
  const out: string[] = [];
  for (const d of dirs) { const f = path.join(d, `${name}.als`); if (fs.existsSync(f) && !out.includes(f)) out.push(f); }
  return out;
}

/** Which Live last saved a set file: the root's Creator attribute, e.g. "Ableton Live 12.1d1". Reads only the start. */
export function alsCreator(file: string): string | null {
  try {
    const fd = fs.openSync(file, "r"); const buf = Buffer.alloc(65536); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    const xml = zlib.gunzipSync(buf.subarray(0, n), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("utf8", 0, 4000);
    return /<Ableton\b[^>]*\bCreator="([^"]+)"/.exec(xml)?.[1] ?? null;
  } catch { return null; }
}
const majorMinor = (v: string) => { const m = /(\d+)\.(\d+)/.exec(v); return m ? Number(m[1]) * 1000 + Number(m[2]) : null; };
/** The running Live's version: from its menu read (Windows), else from the newest Log.txt folder ("Live 12.4.16"). */
async function runningVersion(): Promise<string | null> {
  try { const v = (await readMenu()).version; if (v) return v; } catch { /* fall through */ }
  return /Live ([\d.]+)/.exec(liveLog() ?? "")?.[1] ?? null;
}
const backups = (files: string[]) => files.flatMap((f) => { try { return fs.readdirSync(path.join(path.dirname(f), "Backup")).map((b) => path.join(path.dirname(f), "Backup", b)); } catch { return []; } });

const SAVE_FAIL = (why: string) => `Save didn't go through: ${why} Ask the user: please press ${ON_MAC ? "Cmd+S" : "Ctrl+S"} in Live. Or offer computer use as the fallback (it can click File > Save Live Set, but it takes over the screen for a moment).`;

/** Save the open set through File > Save Live Set, then confirm it landed. Only for a set that already has a file. */
export async function liveSave() {
  const set = await openSet();
  if ("unknown" in set) throw new Error(SAVE_FAIL(set.unknown));
  if (set.untitled) throw new Error("This set has never been saved, so it has no file and no name yet. Nothing was fired. Saving it means Save As: ask the user for a name and folder, then call live_save with path (the full .als path). Or the user presses " + (ON_MAC ? "Cmd+S" : "Ctrl+S") + " and picks them.");
  if (!set.unsaved) return { saved: true, fired: null, set: set.name, note: "Nothing to save: Live's title has no *, so the set has no unsaved changes." };
  const files = setFiles(set.name);
  // Live 12.4 won't save over a set file made by an older Live without asking: Save opens Save As instead
  // (seen 2026-11-18 with a copy of the 12.1 default set). So don't fire; say so. Comparing major.minor is a guess.
  const running = await runningVersion();
  const creators = files.map(alsCreator).filter((c): c is string => !!c);
  if (running && creators.length && creators.every((c) => (majorMinor(c) ?? Infinity) < (majorMinor(running) ?? 0))) {
    throw new Error(`This set's file was last saved by ${creators[0]}, and this is Live ${running}. Live doesn't save over a file from an older version without asking: Save opens its Save As window instead. Nothing was fired. Ask the user to press ${ON_MAC ? "Cmd+S" : "Ctrl+S"} and click Save in that window; keeping the same name replaces the old file, and Live keeps the old one in the project's Backup folder. After that, live_save works on this set.`);
  }
  const backupsBefore = new Set(backups(files));
  const before = new Map(files.map((f) => [f, fs.statSync(f).mtimeMs]));
  const log = liveLog(), logFrom = logSize(log);
  const winBefore = await liveWindows();
  const busy = (winBefore?.windows ?? []).filter((t) => /save|export|collect|stem|replace|message/i.test(t));
  if (busy.length) throw new Error(`Live already has ${quoted(busy)} open. Nothing was fired. Ask the user to finish or cancel it in Live first.`);
  try { await liveMenu("File > Save Live Set", { allowSave: true }); }
  catch (e) { throw new Error(SAVE_FAIL((e as Error).message.replace(/ Nothing was fired.*$/, " Nothing was fired."))); }

  const wait = Number(process.env.SECOND_CHAIR_SAVE_WAIT_MS || 15000), start = Date.now();
  let titleClean = false, changed: string[] = [];
  while (Date.now() - start < wait) {
    await new Promise((r) => setTimeout(r, 400));
    const boxes = newMessageBoxes(log, logFrom);
    if (boxes.length) throw new Error(SAVE_FAIL(`Live showed a message: "${boxes[boxes.length - 1].slice(0, 300)}". The user needs to read and answer it in Live first.`));
    const w = winBefore ? await liveWindows() : null;
    const opened = newWindows(winBefore?.windows, w?.windows);
    if (opened.some((t) => /save live set as/i.test(t))) throw new Error("Save didn't go through: Live opened its Save As window instead of saving. Live treats this set as not yet saved to a file of its own (for example a copy of a template opened from disk). That window is open in Live now: ask the user to check the name and folder there and click Save (or Cancel). Nothing was saved, and nothing was pressed in that window.");
    if (opened.length) throw new Error(SAVE_FAIL(`Live opened a window: ${quoted(opened)}. The user needs to read and answer it in Live first.`));
    const now = w ? parseTitle(w.title) : await openSet();
    titleClean = !("unknown" in now) && !now.unsaved;
    changed = files.filter((f) => { try { return fs.statSync(f).mtimeMs !== before.get(f); } catch { return false; } });
    if (titleClean && (changed.length || !files.length)) break;
  }
  if (!titleClean) throw new Error(SAVE_FAIL(`Save was sent, but after ${Math.round(wait / 1000)} s Live's title still shows * (unsaved). A dialog may be open in Live, or Live didn't take the command.`));
  const out: Record<string, unknown> = { saved: true, fired: "File > Save Live Set", set: set.name, title: "no * any more" };
  if (changed.length) out.file = changed[0];
  const newBackup = backups(files).find((b) => !backupsBefore.has(b));
  if (newBackup) out.backup = `Live kept the previous version: ${newBackup}`;
  else if (files.length) out.warning = `Live's title says saved, but ${files.map((f) => `"${f}"`).join(", ")} didn't change. The open set may be a different file with the same name.`;
  else out.note = `Couldn't find "${set.name}.als" to double-check the file; the title losing its * is the only check.`;
  out.message_boxes = "none";
  return out;
}
