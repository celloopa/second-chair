// live_separate_stems: run Live's Stem Separation without taking over the screen (Windows, Live Suite 12.3+).
// Live's Python API can't start Stem Separation, so this drives Live's own menu and window instead:
//   1. checks the set has a file (stems land in its project folder) and nothing else is open in Live;
//   2. selects the clip through the Remote Script (select_clip);
//   3. fires Create > Separate Stems to New Audio Tracks as a menu command (menu.ts: WM_COMMAND, Live stays put);
//   4. sets the tick boxes in Live's "Separate Stems" window with UI Automation Toggle (separate.ps1);
//   5. presses Separate with UI Automation Invoke, and returns at once.
// Progress (action "check") comes from the stem files appearing in <project>\Samples\Processed\Stems and the new group
// track in the set: Live's log says nothing about stems (seen 2026-11-18). Cancel presses Cancel in that one window.
// separate.ps1 only ever presses Separate or Cancel, and only in a window named "Separate Stems" owned by Live.
// The Mac route isn't built: it refuses there with the by-hand steps. What a Mac route could use (from the Mac lead's
// hand test, Live 12.4.16): Live's dialogs are AX-readable with stable AXIdentifiers (Export has
// Base.FinalButtonsBox.ExportButton and CancelButton), and AXPress works with Live in the background; menu items'
// enabled flag is truthful there. The Separate Stems window itself was NOT inspected on the Mac, so its ids are unknown.
// Tests: SECOND_CHAIR_STEMS_UIA points at a JSON stand-in for the window (with SECOND_CHAIR_LIVE_MENU's test menu).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveMenu, liveWindows, readMenu } from "./menu.ts";

export type Ask = (action: string, params?: Record<string, unknown>, waitSeconds?: number) => Promise<any>;
type Track = { index: number; name: string; kind: string; is_group?: boolean; in_group?: string };
type Session = { tempo?: number; is_playing?: boolean; tracks: Track[] };

export const STEMS = ["vocals", "drums", "bass", "others"] as const;
type Stem = typeof STEMS[number];
const LABEL: Record<Stem, string> = { vocals: "Vocals", drums: "Drums", bass: "Bass", others: "Others" };
const MENU_PATH = "Create > Separate Stems to New Audio Tracks";
const FOCUS_PATH = "Navigate > Session View";
const WINDOW = "Separate Stems";
const AUDIO = /\.(wav|aif|aiff|flac)$/i;
const BY_HAND = "By hand in Live: save the set, right-click the clip > Separate Stems to New Audio Tracks, pick the stems and the quality, then Separate.";

const stateDir = () => process.env.SECOND_CHAIR_STATE_DIR || path.join(os.homedir(), "SecondChair");
const jobFile = () => path.join(stateDir(), "stem-job.json");
type Job = {
  phase: "opening" | "separating" | "done" | "cancelled";
  started_at: string; set_path: string; stems_dir: string;
  clip: { track: number; slot: number; name: string; track_name: string; file?: string };
  stems: Stem[]; quality: "fast" | "high"; merge: boolean;
  tempo_before: number | null; tracks_before: string[]; files_before: string[];
  done_at?: string; result?: Record<string, unknown>; last_sizes?: Record<string, number>;
};
function readJob(): Job | null { try { return JSON.parse(fs.readFileSync(jobFile(), "utf8")); } catch { return null; } }
function writeJob(j: Job) { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(jobFile(), JSON.stringify(j, null, 1)); }

// ---------- the window, through separate.ps1 (or a test stand-in) ----------

type UiaRead = { open: boolean; count?: number; live_owned?: boolean; boxes?: Record<string, boolean>; missing?: string[]; elements?: unknown[]; live_windows?: string[] };
type UiaPress = { error?: string; message?: string; pressed?: string; result?: string; closed?: boolean; toggled?: string[]; boxes?: Record<string, boolean>; boxes_before?: Record<string, boolean>; window_now?: unknown[]; live_windows?: string[] };

const fixture = () => process.env.SECOND_CHAIR_STEMS_UIA;
function fixtureMenuWindows(change?: (w: string[]) => string[]): string[] {
  const f = process.env.SECOND_CHAIR_LIVE_MENU;
  if (!f) return [];
  const m = JSON.parse(fs.readFileSync(f, "utf8"));
  if (change) { m.windows = change(m.windows ?? []); fs.writeFileSync(f, JSON.stringify(m)); }
  return m.windows ?? [];
}
/** The stand-in: {boxes: {vocals: true, ...}, pressed: [], fail?: "missing" | "toggle", stays_open?: true}. The window is
 *  open while the test menu's windows list holds "Separate Stems" (live_menu puts it there when it fires the command). */
function fakeUia(action: string, want?: Record<string, boolean>, separate?: boolean): UiaRead & UiaPress {
  const f = JSON.parse(fs.readFileSync(fixture()!, "utf8"));
  const open = fixtureMenuWindows().includes(WINDOW);
  const save = () => fs.writeFileSync(fixture()!, JSON.stringify(f));
  if (action === "read") return open ? { open: true, count: 1, live_owned: true, boxes: f.boxes, missing: [] } : { open: false, live_windows: [] };
  if (!open) return { error: "no-window", message: "Live's Separate Stems window isn't open." };
  const close = () => { if (!f.stays_open) fixtureMenuWindows((w) => w.filter((x) => x !== WINDOW)); };
  if (action === "cancel") { f.pressed = [...(f.pressed ?? []), "Cancel"]; save(); close(); return { pressed: "Cancel", result: "done", closed: !f.stays_open }; }
  if (f.fail === "missing") return { error: "missing", message: "The Separate Stems window has no tick box called 'Merge Stems' (another Live version or language?). Nothing was pressed." };
  if (f.fail === "toggle") return { error: "toggle-failed", message: "'Drums' didn't change when toggled. Separate was not pressed." };
  const before = { ...f.boxes }, toggled: string[] = [];
  for (const [k, v] of Object.entries(want ?? {})) if (f.boxes[k] !== v) { f.boxes[k] = v; toggled.push(k); }
  const out: UiaPress = { boxes_before: before, boxes: { ...f.boxes }, toggled };
  if (separate) { f.pressed = [...(f.pressed ?? []), "Separate"]; close(); Object.assign(out, { pressed: "Separate", result: "done", closed: !f.stays_open }); }
  save();
  return out;
}

const PS = () => path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function uia(action: "read" | "set" | "cancel", want?: Record<string, boolean>, separate = false): Promise<UiaRead & UiaPress> {
  if (fixture()) return Promise.resolve(fakeUia(action, want, separate));
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dirname, "separate.ps1"), "-Action", action];
  if (want) args.push("-Want", Object.entries(want).map(([k, v]) => `${k}=${v ? 1 : 0}`).join(","));
  if (separate) args.push("-Separate");
  return new Promise((resolve, reject) => execFile(PS(), args, { timeout: 45000, windowsHide: true, maxBuffer: 4 << 20 }, (e, out, err) => {
    const line = String(out).split(/\r?\n/).find((l) => l.trim().startsWith("{"));
    if (line) { try { return resolve(JSON.parse(line)); } catch { /* fall through */ } }
    reject(new Error(`Reading Live's Separate Stems window failed: ${String(err || e?.message || "no answer").trim().slice(0, 300)}`));
  }));
}

// ---------- shared pieces ----------

function guard() {
  if (process.platform === "darwin") throw new Error(`live_separate_stems isn't built for the Mac yet: its window hasn't been looked at there. Nothing was done. ${BY_HAND} Afterwards, live_separate_stems with action "check" finds the new stem group for song_analyze.`);
  if (process.platform !== "win32") throw new Error("live_separate_stems works on Windows only.");
  if (process.env.SECOND_CHAIR_LIVE_TITLE !== undefined && !fixture()) throw new Error("Test mode (SECOND_CHAIR_LIVE_TITLE is set): live_separate_stems won't touch the real Live. Set SECOND_CHAIR_STEMS_UIA to a stand-in window.");
}
const stemsDirOf = (setPath: string) => path.join(path.dirname(setPath), "Samples", "Processed", "Stems");
function listAudio(dir: string): string[] { try { return fs.readdirSync(dir).filter((f) => AUDIO.test(f)).sort(); } catch { return []; } }
const stemOf = (file: string): Stem | null => {
  const m = /\((vocals|drums|bass|others?)\)/i.exec(file);
  if (!m) return null;
  const k = m[1].toLowerCase();
  return (k === "other" ? "others" : k) as Stem;
};
const mb = (bytes: number) => Math.round(bytes / 1e5) / 10;
const ago = (iso: string) => Math.round((Date.now() - new Date(iso).getTime()) / 1000);
const mmss = (s: number) => `${Math.floor(s / 60)} min ${s % 60} s`;
/** Tracks in `now` that weren't in `before` (by name, counting repeats). */
function newTracks(before: string[], now: Track[]): Track[] {
  const left = [...before];
  return now.filter((t) => { const i = left.indexOf(t.name); if (i >= 0) { left.splice(i, 1); return false; } return true; });
}
const majorMinor = (v?: string) => { const m = /(\d+)\.(\d+)/.exec(v ?? ""); return m ? [Number(m[1]), Number(m[2])] : null; };

// ---------- start ----------

export type StartArgs = { track: number; slot?: number; bar?: number; stems?: string[]; quality?: string; merge?: boolean };

export async function startStems(ask: Ask, a: StartArgs) {
  guard();
  if (a.bar !== undefined) throw new Error("Arrangement clips (bar) aren't supported yet: the Live script can only select a Session clip. Nothing was done. Use a Session clip (track and slot), or " + BY_HAND.charAt(0).toLowerCase() + BY_HAND.slice(1));
  if (a.track === undefined || a.slot === undefined) throw new Error("Give track and slot: the Session clip to separate (live_get_track shows the slots).");
  const stems = [...new Set((a.stems ?? [...STEMS]).map((s) => String(s).toLowerCase().replace(/^other$/, "others")))];
  const bad = stems.filter((s) => !(STEMS as readonly string[]).includes(s));
  if (bad.length) throw new Error(`Unknown stem ${bad.map((b) => `"${b}"`).join(", ")}. The stems are vocals, drums, bass and others.`);
  if (!stems.length) throw new Error("Pick at least one stem: vocals, drums, bass or others.");
  const quality = a.quality === undefined ? "high" : String(a.quality);
  if (quality !== "fast" && quality !== "high") throw new Error('quality is "fast" (Live\'s High Speed) or "high" (High Quality).');
  const merge = a.merge === true;

  // 1. the set has a file, nothing is open, no other separation is running
  const ping = await ask("ping") as { set_api?: { name?: string; path?: string }; dialog?: { open: boolean; text?: string } };
  if (!ping.set_api) throw new Error("live_separate_stems needs the Second Chair script 0.11.0 or newer in Live. Ask the user to update the Live script (run the installer again), then save, fully quit Live and open it again. Nothing was done.");
  const setPath = String(ping.set_api.path ?? "");
  if (!setPath) throw new Error("This set has never been saved, so Live has no project folder to put the stems in. Nothing was done. Ask the user to save the set first (Ctrl+S, pick a name and a folder), then try again.");
  if (ping.dialog?.open) throw new Error(`Live is waiting on a message box${ping.dialog.text ? `: "${ping.dialog.text}"` : ""}. Nothing was done. Ask the user to answer it in Live first.`);
  const job = readJob();
  if (job && (job.phase === "separating" || job.phase === "opening") && ago(job.started_at) < 3600) {
    throw new Error(`A separation started ${mmss(ago(job.started_at))} ago (track ${job.clip.track}, "${job.clip.name}") isn't finished yet. Nothing was done. Call live_separate_stems with action "check" first.`);
  }
  const already = await uia("read");
  if (already.open) throw new Error(`Live's Separate Stems window is already open. Nothing was pressed. Ask the user to finish it in Live, or call live_separate_stems with action "cancel" to press its Cancel.`);
  const wins = await liveWindows();
  const busy = (wins?.windows ?? []).filter((t) => /save|export|collect|stem|replace|message|settings|preferences|quantize|import/i.test(t));
  if (busy.length) throw new Error(`Live already has ${busy.map((b) => `"${b}"`).join(", ")} open. Nothing was done. Ask the user to finish or close it first.`);
  try {
    const v = majorMinor((await readMenu()).version);
    if (v && (v[0] < 12 || (v[0] === 12 && v[1] < 3))) throw new Error(`Stem Separation needs Live Suite 12.3 or later; this is Live ${v.join(".")}. Nothing was done.`);
  } catch (e) { if (/needs Live Suite/.test((e as Error).message)) throw e; /* version unknown: carry on */ }

  // 2. the clip: an audio clip in that slot
  const tr = await ask("get_track", { track: a.track }) as { name: string; clips: { slot: number; name: string; midi: boolean }[] };
  const clip = tr.clips.find((c) => c.slot === a.slot);
  if (!clip) throw new Error(`Track ${a.track} (${tr.name}) has no clip in slot ${a.slot}. Nothing was done.`);
  if (clip.midi) throw new Error(`The clip in track ${a.track}, slot ${a.slot} ("${clip.name}") is MIDI. Stem Separation works on audio clips. Nothing was done.`);
  let file: string | undefined;
  try { file = String((await ask("audio_clip_info", { clip: { track: a.track, slot: a.slot } }) as { file?: string }).file ?? "") || undefined; } catch { /* only for naming */ }
  const session = await ask("get_session") as Session;
  const stemsDir = stemsDirOf(setPath);
  const sel = await ask("select_clip", { track: a.track, slot: a.slot, show: true }) as { selected?: boolean };
  if (!sel.selected) throw new Error(`Live didn't select track ${a.track}, slot ${a.slot}, so the menu command would have no target. Nothing was fired.`);

  const newJob: Job = { phase: "opening", started_at: new Date().toISOString(), set_path: setPath, stems_dir: stemsDir,
    clip: { track: a.track, slot: a.slot, name: clip.name, track_name: tr.name, file }, stems: stems as Stem[], quality, merge,
    tempo_before: typeof session.tempo === "number" ? session.tempo : null, tracks_before: session.tracks.map((t) => t.name), files_before: listAudio(stemsDir) };
  writeJob(newJob);

  // 3. the menu command, then wait for the window. Live 12.4.16 ignored it after select_clip alone; with Session View
  // focused first (Navigate > Session View, a view-only command) the window opened (seen 2026-11-18).
  try { await liveMenu(FOCUS_PATH); await new Promise((r) => setTimeout(r, 500)); await liveMenu(MENU_PATH); }
  catch (e) { writeJob({ ...newJob, phase: "cancelled" }); throw new Error(`${(e as Error).message.replace(/ Nothing was fired.*$/, "")} Nothing was fired. ${BY_HAND}`); }
  let win: UiaRead = { open: false };
  // each real read takes about 1.5 s (PowerShell starting), so poll by time, not by count
  const until = Date.now() + Number(process.env.SECOND_CHAIR_STEMS_OPEN_MS || 10000);
  do { win = await uia("read"); if (!win.open) await new Promise((r) => setTimeout(r, 300)); } while (!win.open && Date.now() < until);
  if (!win.open) {
    writeJob({ ...newJob, phase: "cancelled" });
    throw new Error(`The menu command went to Live, but its Separate Stems window didn't open within 10 s. Nothing was separated. Likely reasons (a guess): this Live isn't Suite 12.3 or later, the clip can't be separated, or Live was busy. Check with live_screenshot. ${BY_HAND}`);
  }

  // 4 and 5. the tick boxes, then Separate
  const want: Record<string, boolean> = Object.fromEntries(STEMS.map((s) => [s, stems.includes(s)]));
  want.merge = merge; want.high = quality === "high";
  let r: UiaPress;
  try { r = await uia("set", want, true); } catch (e) { r = { error: "script", message: (e as Error).message }; }
  if (r.error) {
    // Close the window again with its own Cancel, so nothing is left half set.
    let closed = "";
    try { const c = await uia("cancel"); closed = c.closed ? " Its Cancel was pressed, so the window is closed and nothing changed." : " Its Cancel was pressed, but the window may still be open: ask the user to look."; }
    catch { closed = " The window may still be open in Live: ask the user to press Cancel there."; }
    writeJob({ ...newJob, phase: "cancelled" });
    throw new Error(`Setting up Live's Separate Stems window failed: ${r.message}${closed} Computer use is the fallback (it can tick the boxes and click Separate, but takes over the screen for a moment). ${BY_HAND}`);
  }
  writeJob({ ...newJob, phase: "separating" });
  const out: Record<string, unknown> = {
    started: true, clip: { track: a.track, slot: a.slot, name: clip.name, track_name: tr.name },
    stems: stems.map((s) => LABEL[s as Stem]), quality: quality === "high" ? "High Quality" : "High Speed", merge,
    boxes: Object.entries(r.boxes ?? want).map(([k, v]) => k === "high" ? (v ? "High Quality" : "High Speed") : `${k === "merge" ? "Merge" : LABEL[k as Stem]} ${v ? "on" : "off"}`).join(", "),
    changed_boxes: r.toggled?.length ?? 0,
    how: "selected the clip through the Live script, focused Session View, fired Create > Separate Stems to New Audio Tracks as a menu command, set the tick boxes and pressed Separate through UI Automation. No mouse, keys or clipboard.",
    files_land_in: stemsDir,
    time: quality === "high" ? "High Quality took about 9 minutes for a 2-minute song on this PC (seen once), and Vocals finished first. Live stops playback while it works." : "High Speed is quicker than High Quality (about 9 minutes for a 2-minute song); how much quicker isn't measured yet. Live stops playback while it works.",
    tempo_before: newJob.tempo_before,
    next: "Call live_separate_stems with action \"check\" every minute or two. When it's done it gives the new group track's index, which is what song_analyze's stems input takes. Live may change the set's tempo to its own guess: check reports it.",
    revert: "live_revert can't take this back: Live makes the stem tracks itself. The user can delete the group track in Live, or live_undo straight after it finishes may.",
  };
  if (r.closed === false) { out.window = "Live's Separate Stems window is still open after Separate was pressed. It may be showing progress, or the press didn't take: check will look again."; if (r.window_now) out.window_now = r.window_now; }
  if (r.result === "still-running") out.note = "Live took more than 5 s to answer the Separate press. It's probably working; check will tell.";
  if (session.is_playing) out.playback = "Live was playing; Stem Separation stops it.";
  return out;
}

// ---------- check ----------

/** Progress of the last separation this tool started, or (with none) the stem groups and files in the set. */
export async function checkStems(ask: Ask, opts: { session?: Session; light?: boolean } = {}) {
  const job = readJob();
  const session = opts.session ?? await ask("get_session") as Session;
  const groups = (ts: Track[]) => ts.filter((t) => t.is_group && /\bstems$/i.test(t.name.trim()));
  // a finished job is reported again for 15 minutes; after that, check lists what's in the set
  const stale = job?.phase === "done" && job.done_at && ago(job.done_at) > 15 * 60;
  if (!job || job.phase === "cancelled" || stale) {
    const ping = opts.light ? null : await ask("ping").catch(() => null) as { set_api?: { path?: string } } | null;
    const dir = ping?.set_api?.path ? stemsDirOf(String(ping.set_api.path)) : null;
    const g = groups(session.tracks);
    return {
      running: false, note: stale ? "The last separation this tool started is done (see the groups below)." : job?.phase === "cancelled" ? "The last separation this tool tried was cancelled or didn't start." : "No separation started by this tool.",
      stem_groups: g.map((t) => ({ track: t.index, name: t.name, stems: session.tracks.filter((k) => k.in_group === t.name).map((k) => k.name) })),
      ...(dir ? { stem_files: listAudio(dir), folder: dir } : {}),
      ...(g.length ? { next: `song_analyze takes a group's track index as its stems input (e.g. stems: ${g[g.length - 1].index}).` } : {}),
    };
  }
  if (job.phase === "done" && job.result) return { ...job.result, checked_again: true };
  const elapsed = ago(job.started_at);
  const now = listAudio(job.stems_dir).filter((f) => !job.files_before.includes(f));
  const sizes: Record<string, number> = {};
  const files = now.map((f) => {
    let size = 0; try { size = fs.statSync(path.join(job.stems_dir, f)).size; } catch { /* gone */ }
    sizes[f] = size;
    return { stem: stemOf(f), file: f, mb: mb(size), asd: fs.existsSync(path.join(job.stems_dir, f + ".asd")) };
  });
  // A file is finished when Live has written its .asd beside it, or its size hasn't changed since the last check
  // (whether Live writes stems bit by bit is unknown, so this guards against reading a half-written file).
  const settled = files.every((f) => f.asd || (job.last_sizes?.[f.file] !== undefined && job.last_sizes[f.file] === sizes[f.file]));
  const fresh = newTracks(job.tracks_before, session.tracks);
  const group = groups(fresh).pop();
  const kids = group ? session.tracks.filter((t) => t.in_group === group.name) : [];
  const tempoNow = typeof session.tempo === "number" ? session.tempo : null;
  const tempoChanged = job.tempo_before !== null && tempoNow !== null && Math.abs(tempoNow - job.tempo_before) > 0.005;
  const got = new Set(files.map((f) => f.stem).filter(Boolean));
  const waitingFor = job.merge ? [] : job.stems.filter((s) => !got.has(s)).map((s) => LABEL[s]);
  const done = settled && (job.merge ? fresh.length > 0 && files.length > 0 : !!group && kids.length >= job.stems.length && !waitingFor.length);

  const out: Record<string, unknown> = {
    running: !done, done, elapsed: mmss(elapsed),
    clip: job.clip, stems_asked: job.stems.map((s) => LABEL[s]), quality: job.quality === "high" ? "High Quality" : "High Speed",
    files: files.length ? files : "none yet", folder: job.stems_dir,
  };
  if (!done && waitingFor.length) out.waiting_for = waitingFor;
  if (tempoChanged) out.tempo = { before: job.tempo_before, now: tempoNow, changed: true,
    note: `Live changed the set's tempo from ${job.tempo_before} to ${tempoNow} (its own guess from the audio; on a song checked before it was off by 9/8). Tell the user, and offer to set it back with live_set_tempo ${job.tempo_before}. Don't set it back without asking.` };
  else out.tempo = { before: job.tempo_before, now: tempoNow, changed: false };
  const src = session.tracks.find((t) => t.name === job.clip.track_name);
  if (src && src.index !== job.clip.track) out.track_numbers = `The source track "${job.clip.track_name}" is now track ${src.index} (was ${job.clip.track}): Live's new tracks moved the numbers.`;
  if (done) {
    if (group) {
      out.group = { track: group.index, name: group.name, stems: kids.map((k) => ({ track: k.index, name: k.name })) };
      if (job.tracks_before.length > group.index) out.track_numbers = `Live put ${fresh.length} new tracks at ${group.index} to ${group.index + fresh.length - 1}, so the tracks that were at ${group.index} or later moved down by ${fresh.length} (Live may also renumber names like "4-Audio"). Read live_status before using track numbers.`;
      out.next = `The stems are in the group track ${group.index} ("${group.name}"). That index is exactly what song_analyze's stems input takes: song_analyze {stems: ${group.index}}.`;
    } else {
      out.new_tracks = fresh.map((t) => ({ track: t.index, name: t.name }));
      out.next = "Merge was on, so Live made one track, not a group: song_analyze's stems input needs separate stems. Give it the stem files as paths if there are several, or run it again with merge off.";
    }
    out.note = "Live deactivates the source clip after separating (documented; not checked here). The user can turn it back on if they want it to play. The set now has unsaved changes.";
    const result = { ...out, finished_seen: new Date().toISOString() };
    writeJob({ ...job, phase: "done", done_at: new Date().toISOString(), result });
    return result;
  }
  if (!opts.light) {
    try {
      const w = await uia("read");
      if (w.open) out.window = "Live's Separate Stems window is open. If it shows the tick boxes, Separate wasn't pressed: cancel and start again, or ask the user to look.";
      else if (w.live_windows?.length) out.live_windows = w.live_windows;
    } catch { /* the window read is extra */ }
  }
  if (!opts.light) writeJob({ ...job, last_sizes: sizes });
  if (files.length && !settled && (group || !waitingFor.length)) out.settling = "The files are there; waiting for Live to finish writing them (no .asd yet, or a size still changing).";
  const slow = job.quality === "high" ? 30 * 60 : 15 * 60;
  if (elapsed > slow) out.warning = `This is taking longer than expected (${mmss(elapsed)}). Look with live_screenshot: Live may have shown a message, or stopped.`;
  out.next = "Still separating. Check again in a minute or two.";
  return out;
}

/** One line for live_status while a separation this tool started is running (no extra calls to Live). */
export function stemJobSummary(session: Session): Record<string, unknown> | null {
  const job = readJob();
  if (!job || job.phase !== "separating" || ago(job.started_at) > 3 * 3600) return null;
  const files = listAudio(job.stems_dir).filter((f) => !job.files_before.includes(f));
  const group = newTracks(job.tracks_before, session.tracks).filter((t) => t.is_group && /\bstems$/i.test(t.name.trim())).pop();
  return { started: `${mmss(ago(job.started_at))} ago`, clip: job.clip.name, files_so_far: files.length, ...(group ? { group_track: group.index } : {}),
    next: `live_separate_stems action "check" gives the details${group ? " and marks it done" : ""}.` };
}

// ---------- cancel ----------

export async function cancelStems() {
  guard();
  const w = await uia("read");
  const job = readJob();
  if (w.open) {
    const r = await uia("cancel");
    if (r.error) throw new Error(`Pressing Cancel failed: ${r.message} Ask the user to press Cancel in Live's Separate Stems window.`);
    if (job && job.phase !== "done") writeJob({ ...job, phase: "cancelled" });
    return { pressed: "Cancel", window_closed: r.closed ?? null,
      note: r.closed ? "Live's Separate Stems window is closed. If it was still asking (tick boxes showing), nothing was separated." : "Cancel was pressed, but the window is still open: ask the user to look at Live." };
  }
  if (job?.phase === "separating") {
    return { pressed: null, running: true, note: `Live is separating ("${job.clip.name}", started ${mmss(ago(job.started_at))} ago) and its Separate Stems window is closed, so there's nothing this tool may press. Ask the user to stop it in Live if Live offers a way. Files made so far stay in ${job.stems_dir}.`,
      ...(w.live_windows?.length ? { live_windows: w.live_windows } : {}) };
  }
  return { pressed: null, note: "Live's Separate Stems window isn't open, and no separation started by this tool is running. Nothing to cancel." };
}
