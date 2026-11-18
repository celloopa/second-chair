// live_file_dialog: fill Live's file pickers (Save As, Save a Copy, the Export save picker, Open) without the screen.
// The pickers are Windows' own common file dialogs (class #32770), not Live's drawn windows. filedialog.ps1 finds the
// one owned by Live through UI Automation, puts a full path in its File name box with WM_SETTEXT (read back with
// WM_GETTEXT), and sends it Save/Open (WM_COMMAND id 1) or Cancel (id 2): the same messages a click sends. No mouse,
// keys or clipboard, and Live can stay in the background. Windows' "already exists, replace it?" box is answered No
// unless the call says replace (then Yes). Any other box is left open and reported.
// Never Live's own drawn controls: SetValue on Live's sliders crashed Live (community-reported).
// Before pressing, this side refuses: a relative path, bad characters, a system folder, an Open of a file that isn't
// there, and a Save over a file that already exists (unless replace: true).
// live_save uses saveSetAs() here for an Untitled set: File > Save Live Set As by name, then fill the picker.
// Mac: not built. The Mac's Save panel won't take a full path in its name field (the Mac lead saw it save a file with
// ':' in its name, 2026-11-18), so a Mac route needs another way to pick the folder. It refuses with the by-hand steps.
// Tests: SECOND_CHAIR_FILE_DIALOG points at a JSON stand-in picker (with SECOND_CHAIR_LIVE_MENU's test menu).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { liveMenu, liveWindows } from "./menu.ts";
import { openSet } from "./liveset.ts";

export type Ask = (action: string, params?: Record<string, unknown>, waitSeconds?: number) => Promise<any>;
type Picker = { kind: "save" | "open"; title: string; folder?: string | null; file_name?: string | null; file_type?: string | null; button?: string | null; live_owned?: boolean };
type Box = { title: string; text: string; buttons?: string[] };
type Read = { open: boolean; count?: number; picker?: Picker; boxes?: Box[]; error?: string; message?: string };
type Fill = { error?: string; message?: string; kind?: string; title?: string; set?: string; pressed?: string; sent?: boolean; closed?: boolean;
  stopped?: "replace" | "box"; box?: Box; answered?: string; picker_open?: boolean; picker_now?: Picker };

const BY_HAND = "By hand in Live's picker: type or paste the full path into File name, then press Save (or Open).";
const FALLBACK = "Computer use is the fallback (it can type the path and click Save, but takes over the screen for a moment).";

// ---------- the picker, through filedialog.ps1 (or a test stand-in) ----------

const fixture = () => process.env.SECOND_CHAIR_FILE_DIALOG;
function menuFixture(change?: (m: any) => void): any {
  const f = process.env.SECOND_CHAIR_LIVE_MENU;
  if (!f) return {};
  const m = JSON.parse(fs.readFileSync(f, "utf8"));
  if (change) { change(m); fs.writeFileSync(f, JSON.stringify(m)); }
  return m;
}
/** The stand-in: {kind, title, folder, file_type, open?, boxes?, pressed: [], writes?: false}. The picker is open when
 *  open is true, or when the test menu's windows list holds its title (live_menu puts it there when it fires). */
function fakePicker(action: string, p?: string, replace?: boolean): Read & Fill {
  const f = JSON.parse(fs.readFileSync(fixture()!, "utf8"));
  const save = () => fs.writeFileSync(fixture()!, JSON.stringify(f));
  const open = f.open === true || (menuFixture().windows ?? []).includes(f.title);
  const close = () => { f.open = false; menuFixture((m) => { m.windows = (m.windows ?? []).filter((w: string) => w !== f.title); }); };
  const picker: Picker = { kind: f.kind ?? "save", title: f.title ?? "Save a Copy:", folder: f.folder ?? null, file_name: "", file_type: f.file_type ?? null, button: f.kind === "open" ? "Open" : "Save", live_owned: true };
  if (action === "read") return open ? { open: true, count: 1, picker, boxes: f.boxes ?? [] } : { open: false, boxes: f.boxes ?? [] };
  if (!open) return { error: "no-picker", message: "No Windows file picker (Save or Open) is open in Live." };
  if (action === "cancel") { f.pressed = [...(f.pressed ?? []), "Cancel"]; close(); save(); return { pressed: "Cancel", closed: true }; }
  f.pressed = [...(f.pressed ?? []), `${picker.button} ${p}`];
  if (picker.kind === "save" && fs.existsSync(p!)) {
    if (!replace) { save(); return { kind: picker.kind, title: picker.title, set: p, pressed: picker.button!, sent: true, stopped: "replace", answered: "No", picker_open: true,
      box: { title: "Confirm Save As", text: `${path.basename(p!)} already exists.\nDo you want to replace it?` }, message: "The file already exists. Windows asked to replace it; No was pressed, so nothing was replaced and the picker is still open." }; }
  }
  if (picker.kind === "save" && f.writes !== false) fs.writeFileSync(p!, "saved by the stand-in picker");
  close(); save();
  return { kind: picker.kind, title: picker.title, set: p, pressed: picker.button!, sent: true, closed: true, ...(replace && picker.kind === "save" ? { answered: "Yes (replace)" } : {}) };
}

const PS = () => path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function picker(action: "read" | "fill" | "cancel", p?: string, replace = false): Promise<Read & Fill> {
  if (fixture()) return Promise.resolve(fakePicker(action, p, replace));
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dirname, "filedialog.ps1"), "-Action", action];
  if (p) args.push("-Path", p);
  if (replace) args.push("-Replace");
  return new Promise((resolve, reject) => execFile(PS(), args, { timeout: 45000, windowsHide: true, maxBuffer: 4 << 20 }, (e, out, err) => {
    const line = String(out).split(/\r?\n/).find((l) => l.trim().startsWith("{"));
    if (line) { try { return resolve(JSON.parse(line)); } catch { /* fall through */ } }
    reject(new Error(`Reading Live's file picker failed: ${String(err || e?.message || "no answer").trim().slice(0, 300)}`));
  }));
}

// ---------- checks ----------

function guard() {
  if (process.platform === "darwin") throw new Error(`live_file_dialog isn't built for the Mac yet: the Mac's Save panel won't take a full path in its name field. Nothing was done. ${BY_HAND}`);
  if (process.platform !== "win32") throw new Error("live_file_dialog works on Windows only.");
  if (process.env.SECOND_CHAIR_LIVE_TITLE !== undefined && !fixture()) throw new Error("Test mode (SECOND_CHAIR_LIVE_TITLE is set): live_file_dialog won't touch the real Live. Set SECOND_CHAIR_FILE_DIALOG to a stand-in picker.");
}

const W = path.win32;
const under = (p: string, dir?: string) => !!dir && (p.toLowerCase() === W.resolve(dir).toLowerCase() || p.toLowerCase().startsWith(W.resolve(dir).toLowerCase() + "\\"));
/** A full Windows path the tool may hand to a picker, or an Error saying why not. */
export function checkPath(raw: unknown): string {
  const p0 = String(raw ?? "").trim().replace(/\//g, "\\");
  if (!p0) throw new Error("Give path: the full path of the file, like C:\\Users\\<you>\\Music\\Ableton\\Projects\\My Song Project\\My Song.als.");
  if (!/^[A-Za-z]:\\/.test(p0) && !/^\\\\[^\\]+\\[^\\]+/.test(p0)) throw new Error(`"${p0}" isn't a full path. Give it from the drive letter (like C:\\...), so the picker's start folder doesn't matter. Nothing was pressed.`);
  const p = W.normalize(p0);
  const rest = p.slice(2);
  if (/[<>"|?*]/.test(rest) || rest.includes(":") || /[\x00-\x1f]/.test(p)) throw new Error(`"${p}" has characters Windows doesn't allow in a file name (< > : " | ? *). Nothing was pressed.`);
  if (/[. ]$/.test(W.basename(p)) || !W.basename(p)) throw new Error(`"${p}" doesn't end in a file name. Nothing was pressed.`);
  const sys = [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData].filter(Boolean) as string[];
  if (sys.some((d) => under(p, d))) throw new Error(`"${p}" is in a system folder. Save music in the user's own folders (for example Music\\Ableton). Nothing was pressed.`);
  return p;
}
const stat = (f: string) => { try { return fs.statSync(f); } catch { return null; } };
const size = (bytes: number) => bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${Math.round(bytes / 1e5) / 10} MB`;
/** Where a saved set may land: the path itself, or "<name> Project\<name>.als" next to it (Live makes a project folder
 *  when a set is saved outside one; a guess for Save As through the picker until seen). */
function landings(p: string): string[] {
  const out = [p];
  if (/\.als$/i.test(p)) { const name = W.basename(p, W.extname(p)); out.push(W.join(W.dirname(p), `${name} Project`, W.basename(p))); }
  return out;
}
const extsOf = (fileType?: string | null) => [...(fileType ?? "").matchAll(/\*\.(\w+)/g)].map((m) => m[1].toLowerCase()).filter((e) => e !== "*");

// ---------- read / fill / cancel / check ----------

export async function readPicker() {
  guard();
  const r = await picker("read");
  if (r.error) throw new Error(`${r.message} ${FALLBACK}`);
  if (!r.open) {
    const out: Record<string, unknown> = { open: false, note: "No Windows file picker is open in Live. Open one with live_menu (File > Save a Copy, File > Save Live Set As, File > Export Audio/Video and its Export button), or live_save with path for a new set." };
    if (r.boxes?.length) out.boxes = r.boxes;
    return out;
  }
  const p = r.picker!;
  return { open: true, kind: p.kind, title: p.title, folder: p.folder ?? "unknown", file_name: p.file_name ?? "", file_type: p.file_type ?? "unknown", button: p.button,
    ...(r.boxes?.length ? { boxes: r.boxes } : {}),
    next: p.kind === "save" ? "live_file_dialog with path (a full path) saves there; replace: true only if the user said to replace an existing file." : "live_file_dialog with path (a full path to an existing file) opens it." };
}

export type FillArgs = { path?: unknown; replace?: boolean };
export async function fillPicker(a: FillArgs, opts: { waitMs?: number } = {}) {
  guard();
  const p = checkPath(a.path);
  const r = await picker("read");
  if (r.error) throw new Error(`${r.message} ${FALLBACK}`);
  if (!r.open) throw new Error("No Windows file picker is open in Live, so there's nothing to fill. Nothing was pressed. Open one first (live_menu File > Save a Copy, File > Export Audio/Video and its Export button, or live_save with path).");
  if (r.count && r.count > 1) throw new Error("More than one file picker is open in Live. Nothing was pressed. Ask the user to close the extra one.");
  const pk = r.picker!;
  if (pk.live_owned === false) throw new Error("The open file picker doesn't belong to Live. Nothing was pressed.");
  const warnings: string[] = [];
  if (pk.kind === "open") {
    if (!stat(p)?.isFile()) throw new Error(`There's no file at "${p}" to open. Nothing was pressed.`);
  } else {
    const dir = W.dirname(p);
    if (!stat(dir)?.isDirectory()) throw new Error(`The folder "${dir}" doesn't exist. Nothing was pressed. Pick an existing folder, or ask the user to make it.`);
    const ext = W.extname(p).slice(1).toLowerCase();
    const want = extsOf(pk.file_type);
    if (!ext) throw new Error(`"${p}" has no file type at the end${want.length ? ` (this picker saves .${want.join(", .")})` : ""}. Nothing was pressed.`);
    if (want.length && !want.includes(ext)) throw new Error(`This picker saves ${pk.file_type}, but the path ends in .${ext}. Nothing was pressed.`);
    const there = landings(p).filter((f) => stat(f));
    if (stat(p) && a.replace !== true) throw new Error(`"${p}" already exists. Nothing was pressed. Ask the user whether to replace it; if they say yes, call again with replace: true. Or pick another name.`);
    if (there.length > 1 || (there.length && there[0] !== p)) warnings.push(`A set already sits at "${there[there.length - 1]}"; Live may save into that project folder.`);
  }
  if (/\\onedrive[^\\]*\\/i.test(p)) warnings.push("This path is inside OneDrive. Music files in OneDrive can be moved off the PC or locked while syncing; the Music folder is safer.");
  const before = new Map(landings(p).map((f) => [f, stat(f)?.mtimeMs ?? 0]));
  // Every file in the target folder and the picker's folder, so a save under another name shows up (Live once saved
  // under its own suggested name when the path didn't take: seen 2026-11-18, fixed by retyping in filedialog.ps1).
  const watchDirs = [...new Set([W.dirname(p), pk.folder].filter((d): d is string => !!d && !!stat(d)?.isDirectory()))];
  const snapshot = () => new Map(watchDirs.flatMap((d) => { try { return fs.readdirSync(d).map((n) => { const f = W.join(d, n); return [f, stat(f)?.mtimeMs ?? 0] as [string, number]; }); } catch { return []; } }));
  const dirBefore = snapshot();

  let f: Fill;
  try { f = await picker("fill", p, a.replace === true); } catch (e) { throw new Error(`${(e as Error).message} Nothing may have been pressed; look with live_screenshot. ${FALLBACK}`); }
  if (f.error) throw new Error(`${f.message} ${FALLBACK}`);
  const out: Record<string, unknown> = { picker: pk.title, kind: pk.kind, path: p, pressed: f.pressed ?? (pk.kind === "open" ? "Open" : "Save"),
    how: "found Windows' file picker that belongs to Live, put the full path in File name and sent it Save/Open as a window message. No mouse, keys or clipboard." };
  if (f.stopped === "replace") {
    return { ...out, done: false, stopped: "Windows asked whether to replace the existing file.", answered: f.answered ?? "No", picker_still_open: f.picker_open ?? null,
      next: "Nothing was replaced. Ask the user: replace it (call again with replace: true) or pick another name (call again with that path), or cancel (action cancel)." };
  }
  if (f.stopped === "box") {
    return { ...out, done: false, stopped: "Another box opened after the press, and nothing was pressed in it.", box: f.box, picker_still_open: f.picker_open ?? null,
      next: "Read the box to the user. They answer it in Live (it may be a bad name or a folder Windows won't write to)." };
  }
  if (f.answered) out.replaced = true;
  if (!f.closed) {
    return { ...out, done: false, picker_still_open: true, picker_now: f.picker_now, note: "The picker is still open after the press. Windows may have gone into a folder instead, or it's still working. Look with live_screenshot." };
  }
  out.picker_closed = true;
  if (pk.kind === "open") return { ...out, done: true, next: "Live is opening the file now." };
  // Wait for the file: a Save lands fast; an Export renders first (Live shows its own progress) and lands later.
  const wait = opts.waitMs ?? Number(process.env.SECOND_CHAIR_FILE_WAIT_MS || 8000), start = Date.now();
  let landed: string | null = null;
  while (Date.now() - start < wait) {
    landed = landings(p).find((x) => { const s = stat(x); return !!s && s.mtimeMs !== before.get(x); }) ?? null;
    if (landed) break;
    await new Promise((res) => setTimeout(res, 300));
  }
  const strays = landed ? [] : [...snapshot()].filter(([f, t]) => dirBefore.get(f) !== t && stat(f)?.isFile()).map(([f]) => f);
  if (!landed && strays.length) {
    return { ...out, done: false, file: null, saved_elsewhere: strays,
      problem: `Live saved, but not at the path given: ${strays.map((x) => `"${x}"`).join(", ")} appeared instead. The picker may have kept its own suggested name. Tell the user where it went; they can rename or delete it. ${FALLBACK}` };
  }
  if (landed) {
    const s = stat(landed)!;
    Object.assign(out, { done: true, file: landed, size: size(s.size) });
    if (landed !== p) out.note = `Live made a project folder: the set is at "${landed}".`;
  } else {
    Object.assign(out, { done: true, file: null, note: `The picker closed, but "${p}" isn't there yet. An Export renders first (Live shows its progress), so it lands later: check with live_file_dialog action check and the same path.` });
  }
  if (warnings.length) out.warnings = warnings;
  return out;
}

/** Wait up to ms for a Live file picker to be open (for example after Live's Export button). */
export async function waitForPicker(ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  do { const r = await picker("read"); if (r.open) return true; await new Promise((res) => setTimeout(res, 300)); } while (Date.now() < until);
  return false;
}

export async function cancelPicker() {
  guard();
  const r = await picker("read");
  if (r.error) throw new Error(`${r.message} ${FALLBACK}`);
  if (!r.open) return { pressed: null, note: "No Windows file picker is open in Live. Nothing to cancel." };
  const c = await picker("cancel");
  if (c.error) throw new Error(`Pressing Cancel failed: ${c.message} Ask the user to press Cancel in the picker.`);
  return { pressed: "Cancel", picker: r.picker?.title, picker_closed: c.closed ?? null, note: c.closed ? "The picker is closed. Nothing was saved or opened." : "Cancel was sent, but the picker is still open: ask the user to look." };
}

export function checkFile(raw: unknown) {
  const p = checkPath(raw);
  const hits = landings(p).map((f) => ({ f, s: stat(f) })).filter((x) => x.s);
  if (!hits.length) return { exists: false, path: p, note: "Not there (yet). An Export may still be rendering in Live." };
  const h = hits[hits.length - 1];
  return { exists: true, path: h.f, size: size(h.s!.size), modified: new Date(h.s!.mtimeMs).toISOString(), seconds_ago: Math.round((Date.now() - h.s!.mtimeMs) / 1000) };
}

// ---------- Save As for a new set (used by live_save) ----------

/** Save the open set to a new file: File > Save Live Set As (by name), then fill the picker. */
export async function saveSetAs(ask: Ask, raw: unknown) {
  guard();
  const p = checkPath(raw);
  if (!/\.als$/i.test(p)) throw new Error(`A Live set is saved as .als; "${p}" ends differently. Nothing was fired.`);
  const ping = await ask("ping").catch(() => null) as { set_api?: { path?: string }; dialog?: { open: boolean; text?: string } } | null;
  const current = String(ping?.set_api?.path ?? "");
  if (current && current.toLowerCase() === p.toLowerCase()) throw new Error("That's the set's own file: plain live_save (no path) saves it. Nothing was fired.");
  if (ping?.dialog?.open) throw new Error(`Live is waiting on a message box${ping.dialog.text ? `: "${ping.dialog.text}"` : ""}. Nothing was fired. Ask the user to answer it first.`);
  if (stat(p)) throw new Error(`"${p}" already exists. Nothing was fired. Pick another name. To replace that file, open File > Save Live Set As with live_menu, then live_file_dialog with the path and replace: true (only if the user said to replace it).`);
  const already = await picker("read");
  if (already.open) throw new Error(`A file picker ("${already.picker?.title}") is already open in Live. Nothing was fired. Use live_file_dialog on it, or cancel it.`);
  const wins = await liveWindows();
  const busy = (wins?.windows ?? []).filter((t) => /save|export|collect|stem|replace|message/i.test(t));
  if (busy.length) throw new Error(`Live already has ${busy.map((b) => `"${b}"`).join(", ")} open. Nothing was fired. Ask the user to finish or close it first.`);
  try { await liveMenu("File > Save Live Set As"); }
  catch (e) { throw new Error(`${(e as Error).message.replace(/ Nothing was fired.*$/, "")} Nothing was fired. ${FALLBACK}`); }
  let r: Read = { open: false };
  const until = Date.now() + Number(process.env.SECOND_CHAIR_FILE_OPEN_MS || 10000);
  do { r = await picker("read"); if (!r.open) await new Promise((res) => setTimeout(res, 300)); } while (!r.open && Date.now() < until);
  if (!r.open) throw new Error("File > Save Live Set As went to Live, but its picker didn't open within 10 s. Nothing was saved. Look with live_screenshot.");
  const out = await fillPicker({ path: p }) as Record<string, unknown>;
  if (out.done && out.file) {
    const now = await openSet();
    out.set = "unknown" in now ? null : now.name;
    out.next = "The open set is now this file: later saves (live_save) go here.";
  }
  return { ...out, fired: "File > Save Live Set As" };
}

