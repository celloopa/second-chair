// live_export: export audio from Live without the screen (Windows).
// 1. File > Export Audio/Video by name (menu.ts: WM_COMMAND, Live stays put).
// 2. livewindow.ps1 reads Live's own "Export Audio/Video" window through UI Automation: the rendered track, start and
//    length, file type, sample rate, bit depth and the On/Off options. It finds the window by its Win32 title first,
//    so it works while GlazeWM has Live on a hidden workspace. Nothing in that window is ever changed: SetValue on
//    Live's sliders crashed Live (community-reported). The user sets the length and options in Live (or keeps them).
// 3. It presses Export (UIA Invoke; only Export and Cancel are ever pressed there).
// 4. Live opens Windows' save picker; filedialog.ts fills it with the full path and presses Save.
// 5. Live renders; the file lands when it's done. live_file_dialog action check follows it.
// action read opens the window (if it isn't open), reads it and closes it again with Cancel if this opened it.
// action cancel presses Cancel in the Export window, or in the save picker.
// Tests: SECOND_CHAIR_LIVE_WINDOW points at a JSON stand-in for the window (with the test menu and picker).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { liveMenu } from "./menu.ts";
import { checkPath, fillPicker, waitForPicker, cancelPicker, readPicker } from "./filedialog.ts";

export type Ask = (action: string, params?: Record<string, unknown>, waitSeconds?: number) => Promise<any>;
type Control = { type: string; name: string; enabled?: boolean; value?: string; toggle?: string };
type WinRead = { open: boolean; unreadable?: boolean; cloaked?: boolean; controls?: Control[]; error?: string; message?: string };
type WinPress = { pressed?: string; result?: string; closed?: boolean; error?: string; message?: string };

const TITLE = "Export Audio/Video";
const MENU_PATH = "File > Export Audio/Video";
const BY_HAND = "By hand in Live: File > Export Audio/Video, check the length and options, press Export, then pick the name and folder and press Save.";
const FALLBACK = "Computer use is the fallback (it can press Export and fill the save box, but takes over the screen for a moment).";

// ---------- the window, through livewindow.ps1 (or a test stand-in) ----------

const fixture = () => process.env.SECOND_CHAIR_LIVE_WINDOW;
function menuFixture(change?: (m: any) => void): any {
  const f = process.env.SECOND_CHAIR_LIVE_MENU;
  if (!f) return {};
  const m = JSON.parse(fs.readFileSync(f, "utf8"));
  if (change) { change(m); fs.writeFileSync(f, JSON.stringify(m)); }
  return m;
}
/** The stand-in: {controls: [...], pressed: [], picker_title?: string, unreadable?: true}. The window is open while the
 *  test menu's windows list holds its title (live_menu puts it there). Export closes it and opens the picker. */
function fakeWindow(action: string, button?: string, allow: string[] = []): WinRead & WinPress {
  const f = JSON.parse(fs.readFileSync(fixture()!, "utf8"));
  const open = (menuFixture().windows ?? []).includes(TITLE);
  if (!open) return action === "read" ? { open: false } : { open: false } as never;
  if (f.unreadable) return { open: true, unreadable: true, cloaked: true };
  if (action === "read") return { open: true, cloaked: false, controls: f.controls };
  if (!allow.includes(button!)) return { error: "not-allowed", message: `'${button}' isn't on the list of buttons this may press.` };
  f.pressed = [...(f.pressed ?? []), button]; fs.writeFileSync(fixture()!, JSON.stringify(f));
  menuFixture((m) => { m.windows = (m.windows ?? []).filter((w: string) => w !== TITLE); if (button === "Export" && f.picker_title) m.windows.push(f.picker_title); });
  return { pressed: button, result: "done", closed: true };
}

const PS = () => path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function liveWindow(action: "read" | "press", button?: string, allow: string[] = []): Promise<WinRead & WinPress> {
  if (fixture()) return Promise.resolve(fakeWindow(action, button, allow));
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dirname, "livewindow.ps1"), "-Action", action, "-Title", TITLE];
  if (button) args.push("-Button", button, "-Allow", allow.join(","));
  return new Promise((resolve, reject) => execFile(PS(), args, { timeout: 45000, windowsHide: true, maxBuffer: 4 << 20 }, (e, out, err) => {
    const line = String(out).split(/\r?\n/).find((l) => l.trim().startsWith("{"));
    if (line) { try { return resolve(JSON.parse(line)); } catch { /* fall through */ } }
    reject(new Error(`Reading Live's Export window failed: ${String(err || e?.message || "no answer").trim().slice(0, 300)}`));
  }));
}

// ---------- reading the settings ----------

const OPTIONS = ["Include Return and Main Effects", "Render as Loop", "Convert to Mono", "Normalize", "Create Analysis File", "Encode PCM", "Encode MP3", "Create Video with Rendered Audio"];
/** The Export window's settings in plain words, from its controls. */
export function settingsOf(controls: Control[]) {
  const by = (name: string) => controls.find((c) => c.name === name);
  const val = (name: string) => by(name)?.value ?? null;
  const num = (name: string) => { const v = Number(val(name)); return Number.isFinite(v) ? Math.round(v) : null; };
  const pos = (what: "Start" | "Length") => {
    const k = what === "Start" ? "Start of Rendered Audio File" : "Length of Rendered Audio File";
    const p = [num(`${k} (Bar)`), num(`${k} (Beat)`), num(`${k} (Sixteenths)`)];
    return p.every((x) => x !== null) ? p.join(".") : null;
  };
  const options: Record<string, boolean> = {};
  for (const o of OPTIONS) {
    const c = controls.find((x) => x.name === o && x.type === "Button") ?? controls.find((x) => x.name === o);
    if (!c) continue;
    const on = c.value ?? c.toggle;
    if (on) options[o] = /^on$/i.test(on);
  }
  const length = pos("Length");
  const exportBtn = controls.find((c) => c.type === "Button" && c.name === "Export");
  return {
    rendered_track: val("Rendered Track Chooser"), start: pos("Start"), length,
    file_type: val("File Type"), sample_rate: val("Sample Rate"), bit_depth: val("Recording Bit Depth"), dither: val("Dither Options"),
    options, export_button: exportBtn ? (exportBtn.enabled === false ? "greyed out" : "ready") : "not found",
    length_is_zero: length !== null && length.split(".").every((x) => x === "0"),
  };
}
type Settings = ReturnType<typeof settingsOf>;
/** The extensions this export writes: the PCM file type, and .mp3 when Encode MP3 is on. */
function extsFor(s: Settings): string[] {
  const out: string[] = [];
  const pcm = s.options["Encode PCM"] !== false;
  if (pcm) {
    const t = (s.file_type ?? "WAV").toUpperCase();
    out.push(...(t.startsWith("AIF") ? ["aif", "aiff"] : t.startsWith("FLAC") ? ["flac"] : ["wav"]));
  }
  if (s.options["Encode MP3"]) out.push("mp3");
  return out;
}

// ---------- open / read / export / cancel ----------

function guard() {
  if (process.platform === "darwin") throw new Error(`live_export isn't built for the Mac yet. Nothing was done. ${BY_HAND}`);
  if (process.platform !== "win32") throw new Error("live_export works on Windows only.");
  if (process.env.SECOND_CHAIR_LIVE_TITLE !== undefined && !fixture()) throw new Error("Test mode (SECOND_CHAIR_LIVE_TITLE is set): live_export won't touch the real Live. Set SECOND_CHAIR_LIVE_WINDOW to a stand-in window.");
}
const unreadable = (w: WinRead) => `Live's Export window is open, but Windows doesn't show what's inside it${w.cloaked ? " (it's hidden: Live may be on another desktop or workspace)" : ""}. Nothing was pressed. Ask the user to show Live and finish or cancel the export there. ${BY_HAND}`;

/** Open the Export window if it isn't open; returns its read and whether this call opened it. */
async function openWindow(ask: Ask): Promise<{ w: WinRead; opened: boolean }> {
  let w = await liveWindow("read");
  if (w.error) throw new Error(`${w.message} ${FALLBACK}`);
  if (w.open) return { w, opened: false };
  const ping = await ask("ping").catch(() => null) as { dialog?: { open: boolean; text?: string } } | null;
  if (ping?.dialog?.open) throw new Error(`Live is waiting on a message box${ping.dialog.text ? `: "${ping.dialog.text}"` : ""}. Nothing was fired. Ask the user to answer it first.`);
  const pk = await readPicker().catch(() => null) as { open?: boolean; title?: string } | null;
  if (pk?.open) throw new Error(`A file picker ("${pk.title}") is already open in Live. Nothing was fired. Fill it with live_file_dialog, or cancel it.`);
  try { await liveMenu(MENU_PATH); }
  catch (e) { throw new Error(`${(e as Error).message.replace(/ Nothing was fired.*$/, "")} Nothing was fired. ${BY_HAND}`); }
  const until = Date.now() + Number(process.env.SECOND_CHAIR_EXPORT_OPEN_MS || 10000);
  do { w = await liveWindow("read"); if (!w.open) await new Promise((r) => setTimeout(r, 300)); } while (!w.open && Date.now() < until);
  if (!w.open) throw new Error(`File > Export Audio/Video went to Live, but its Export window didn't open within 10 s. Nothing was exported. Look with live_screenshot. ${BY_HAND}`);
  return { w, opened: true };
}

export async function readExport(ask: Ask, a: { keep_open?: boolean } = {}) {
  guard();
  const { w, opened } = await openWindow(ask);
  if (w.unreadable) throw new Error(unreadable(w));
  const s = settingsOf(w.controls ?? []);
  const out: Record<string, unknown> = { window: opened ? "opened by this call" : "was already open", settings: s };
  if (s.length_is_zero) out.warning = "The render length is 0: there may be nothing to export (an empty Arrangement, or no loop or selection). Ask the user to set the length in Live's Export window, or select the part to export first.";
  if (opened && !a.keep_open) {
    const c = await liveWindow("press", "Cancel", ["Cancel"]);
    out.closed_again = c.closed ?? (c.error ? `couldn't close it: ${c.message}` : null);
  } else {
    out.next = "The window is open in Live. The user can change the length and options there; then live_export with path exports. Or action cancel closes it.";
  }
  return out;
}

export async function exportAudio(ask: Ask, a: { path?: unknown; replace?: boolean }) {
  guard();
  const p = checkPath(a.path);
  if (fs.existsSync(p) && a.replace !== true) throw new Error(`"${p}" already exists. Nothing was pressed. Ask the user whether to replace it; if they say yes, call again with replace: true. Or pick another name.`);
  const { w, opened } = await openWindow(ask);
  if (w.unreadable) throw new Error(unreadable(w));
  const s = settingsOf(w.controls ?? []);
  const closeIfOpened = async () => { if (opened) await liveWindow("press", "Cancel", ["Cancel"]).catch(() => null); };
  const ext = path.win32.extname(p).slice(1).toLowerCase();
  const exts = extsFor(s);
  if (exts.length && !exts.includes(ext)) {
    await closeIfOpened();
    throw new Error(`This export writes ${exts.map((e) => "." + e).join(" and ")} (Live's File Type is ${s.file_type ?? "unknown"}${s.options["Encode MP3"] ? ", with MP3 on" : ""}), but the path ends in .${ext || "nothing"}. Nothing was exported${opened ? "; the Export window was closed again" : ""}.`);
  }
  if (s.length_is_zero) {
    await closeIfOpened();
    throw new Error(`Live's render length is 0, so there's nothing to export. Nothing was exported${opened ? "; the Export window was closed again" : ""}. Ask the user to set the length (or select the part to export) in Live first.`);
  }
  if (s.export_button === "greyed out") throw new Error("Live has its Export button greyed out right now. Nothing was pressed. Ask the user to look at the Export window.");
  const pr = await liveWindow("press", "Export", ["Export", "Cancel"]);
  if (pr.error) throw new Error(`Pressing Export failed: ${pr.message} ${FALLBACK}`);
  if (!(await waitForPicker(Number(process.env.SECOND_CHAIR_EXPORT_PICKER_MS || 15000)))) {
    throw new Error(`Export was pressed in Live, but its save box didn't appear within 15 s. Nothing was saved. Look with live_screenshot; if the save box is open, live_file_dialog can fill it. ${FALLBACK}`);
  }
  const f = await fillPicker({ path: p, replace: a.replace === true }, { waitMs: Number(process.env.SECOND_CHAIR_EXPORT_WAIT_MS || 30000) }) as Record<string, unknown>;
  const out: Record<string, unknown> = { exported_with: s, pressed: "Export", save: f,
    how: "opened File > Export Audio/Video by name, read Live's Export window, pressed its Export button and filled Windows' save box with window messages. Nothing in the Export window was changed." };
  if (f.done && f.file) out.next = "The file is there. Offer audio_analyze on it to check loudness and peaks.";
  else if (f.done) out.next = "Live is rendering. Check with live_file_dialog {action: \"check\", path} in a little while.";
  if (exts.includes("mp3") && ext !== "mp3") out.note = "MP3 is on too, so Live also writes an .mp3 beside it (a guess about the name: the same name with .mp3).";
  return out;
}

export async function cancelExport() {
  guard();
  const w = await liveWindow("read");
  if (w.open && !w.unreadable) {
    const c = await liveWindow("press", "Cancel", ["Cancel"]);
    if (c.error) throw new Error(`Pressing Cancel failed: ${c.message}`);
    return { pressed: "Cancel", window: "Export Audio/Video", closed: c.closed ?? null };
  }
  if (w.open && w.unreadable) throw new Error(unreadable(w));
  const pk = await readPicker().catch(() => null) as { open?: boolean } | null;
  if (pk?.open) return { ...(await cancelPicker()), window: "the save box" };
  return { pressed: null, note: "Neither Live's Export window nor a save box is open. Nothing to cancel. (A render already running can only be stopped in Live.)" };
}
