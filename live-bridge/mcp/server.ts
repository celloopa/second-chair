// second-chair: an MCP server (stdio) that lets Claude and HeyClicky work in Ableton Live through the
// SecondChair Remote Script, plus music-theory tools computed locally from Spur's theory and voicing code.
// No dependencies: run with Node 24+ as `node server.ts`.

import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { keyCard, parseRoot, SCALES, SHARPS, type ScaleId } from "../vendor/spur/theory.ts";
import { chordMidi, voicing } from "../vendor/spur/voicing.ts";
import { createRecentPlaying } from "../vendor/spur/recent-playing.ts";
import { captureLive } from "./screenshot.ts";
import { openSet, mergeSet, type ApiSet } from "./liveset.ts";
import { logMessageBoxes } from "./dialogs.ts";
import { liveMenu, liveSave } from "./menu.ts";
import { startStems, checkStems, cancelStems, stemJobSummary } from "./separate.ts";
import { findAudioFile } from "./samplefiles.ts";
import { readWav, findOnsets } from "./onsets.ts";
import { analyze, reading, type Analysis } from "./loudness.ts";
import { analyzeSong } from "./songanalysis.ts";
import { analyzeStems, STEM_NAMES, type StemFiles } from "./stems.ts";
import { readProfile, profileName, personalize, writeProfile, profilePath, QUESTIONS, readPlugins, writePlugins, findPlugins, pluginsPath, PLUGIN_OUTLINE } from "./profile.ts";
import { rankSounds, explain, loadTags, displayName, type Candidate, type Pick } from "./sounds.ts";
import { nameChord, chordShape, parseChordSymbol, keysFor, soundingAt, soundingChord, chordTrail, shapeLabel, scaleFromLive, type NoteEvent } from "./chords.ts";

const VERSION = "0.13.0";
const NEEDS_BRIDGE = "0.11.0"; // the oldest Remote Script these tools work with; raise it when the Remote Script changes
const HOST = "127.0.0.1";
const PORT = Number(process.env.SECOND_CHAIR_PORT || 9885);
// Where install.ps1 (Windows) and mac/install.sh put the token. Apps like HeyClicky start this server with a bare
// environment (no APPDATA), so don't rely on one variable: try each place, as the Remote Script does.
const TOKEN_PATHS = [...new Set([
  process.env.APPDATA && path.join(process.env.APPDATA, "SecondChair", "token"),
  path.join(os.homedir(), "AppData", "Roaming", "SecondChair", "token"),
  path.join(os.homedir(), "SecondChair", "token"),
  process.env.HOME && path.join(process.env.HOME, "SecondChair", "token"),
].filter((p): p is string => Boolean(p)))];

// ---------- bridge client ----------

let nextId = 1;
function readToken(): string {
  for (const p of TOKEN_PATHS) {
    try { const t = fs.readFileSync(p, "utf8").trim(); if (t) return t; } catch { /* try the next place */ }
  }
  throw new Error(`No bridge token found (looked in ${TOKEN_PATHS.join("; ")}). Run the installer first: install.ps1 (Windows) or install.sh (Mac), at the top of this folder.`);
}

function bridge(action: string, params: Record<string, unknown> = {}, waitSeconds = 12): Promise<unknown> {
  const token = readToken();
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: HOST, port: PORT });
    let buf = "";
    const done = (fn: () => void) => { clearTimeout(timer); sock.destroy(); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error(`Live didn't answer within ${waitSeconds} seconds.`))), waitSeconds * 1000);
    sock.on("connect", () => sock.write(JSON.stringify({ id: nextId++, token, action, params }) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let msg: { ok: boolean; result?: unknown; error?: string };
      try { msg = JSON.parse(buf.slice(0, nl)); } catch { return done(() => reject(new Error("Bridge sent invalid JSON."))); }
      done(() => (msg.ok ? resolve(msg.result) : reject(new Error(msg.error || "Bridge error"))));
    });
    sock.on("error", (e: NodeJS.ErrnoException) => done(() => reject(new Error(
      e.code === "ECONNREFUSED"
        ? "Can't reach Live. Open Ableton Live and pick SecondChair as a Control Surface (Settings > Link, Tempo & MIDI)."
        : `Bridge connection failed: ${e.message}`))));
  });
}

// ---------- tool definitions ----------

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; run: (a: any) => Promise<unknown> | unknown };
/** The stem files under a group track Live's Separate Stems made: each child track's audio clip (the longest one), by its name. */
async function stemGroupFiles(index: number) {
  const session = await bridge("get_session") as { tempo?: number; tracks: { index: number; name: string; kind: string; is_group?: boolean; in_group?: string }[] };
  const g = session.tracks.find((t) => t.index === index);
  if (!g) throw new Error(`There's no track ${index}. Call live_status for the track numbers.`);
  if (!g.is_group) throw new Error(`Track ${index} (${g.name}) isn't a group track. Give the index of the group Separate Stems made (it's named "<song> Stems"), or give stems as file paths.`);
  const kids = session.tracks.filter((t) => t.index > index && t.in_group === g.name);
  const files: StemFiles = {}, notes: string[] = [];
  for (const t of kids) {
    if (t.kind !== "audio") continue;
    const arr = await bridge("get_arrangement", { track: t.index }) as { tracks: { clips: { name: string; start_bar: number; bars: number; kind: string }[] }[] };
    const ac = (arr.tracks[0]?.clips ?? []).filter((c) => c.kind === "audio").sort((p, q) => q.bars - p.bars);
    let ref: Record<string, unknown> | null = ac[0] ? { track: t.index, bar: ac[0].start_bar, name: ac[0].name } : null;
    if (!ref) {
      const tr = await bridge("get_track", { track: t.index }) as { clips: { slot: number; midi: boolean; length_beats: number }[] };
      const sc = tr.clips.filter((c) => !c.midi).sort((p, q) => q.length_beats - p.length_beats)[0];
      if (sc) ref = { track: t.index, slot: sc.slot };
    }
    if (!ref) { notes.push(`${t.name}: no audio clip`); continue; }
    const info = await bridge("audio_clip_info", { clip: ref }) as { file: string };
    // Live names the file "<song> [date time] (Vocals).wav" and the track "Vocals <song>": the file's label first,
    // then the track name's first word (a song called "Bass Drop" mustn't make every stem the bass)
    const file = String(info.file ?? "").toLowerCase(), first = t.name.trim().split(/\s+/)[0].toLowerCase();
    const k = STEM_NAMES.find((n) => file.includes(`(${n})`) || (n === "others" && file.includes("(other)")))
      ?? STEM_NAMES.find((n) => first === n || first === n.replace(/s$/, ""));
    if (!k) { notes.push(`${t.name}: not a Vocals, Drums, Bass or Others stem, skipped`); continue; }
    if (!info.file) { notes.push(`${t.name}: Live gave no file`); continue; }
    if (files[k]) { notes.push(`${t.name}: a second ${k} stem, skipped`); continue; }
    files[k] = info.file;
  }
  if (!Object.keys(files).length) throw new Error(`The group ${g.name} (track ${index}) has no stem clips with files.${notes.length ? " " + notes.join("; ") + "." : ""}`);
  return { files, tempo: Number(session.tempo) || undefined, group: { track: index, name: g.name, stems: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, path.basename(f)])), notes } };
}

const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: "integer", description, ...extra });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const NOTE = obj({
  pitch: int("MIDI pitch 0-127 (60 = C3 in Live's naming; a 25-key keyboard's lowest key is usually 48)"),
  start: { type: "number", description: "Start in beats from the clip start (0 = beat 1)" },
  duration: { type: "number", description: "Length in beats" },
  velocity: int("1-127, default 100"),
}, ["pitch", "start", "duration"]);
const SCALE_IDS = Object.keys(SCALES);
const BROWSER_TREES = ["instruments", "drums", "audio_effects", "midi_effects", "sounds", "samples", "plugins", "max_for_live", "user_library", "places"];
const DEVICE_TREES = ["audio_effects", "midi_effects", "instruments", "drums", "sounds", "plugins", "max_for_live", "user_library", "places"];
/** A folder given as a disk path (C:\Users\...\Samples\Kit or /Users/.../Samples/Kit) becomes its last three names,
 *  "sam/Samples/Kit". Live's browser knows names, not disk paths; the bridge matches the longest tail it finds in Places. */
function browserPath(p: string): string {
  const t = p.trim().replace(/[\\/]+$/, "");
  if (!/^([a-zA-Z]:[\\/]|[\\/]|~)/.test(t)) return t;
  return t.split(/[\\/]+/).filter(Boolean).slice(-3).join("/");
}

// Trees live_find_sound can search. "sounds" is Live's ready-made instrument presets, sorted by kind (Pad, Bass, Piano & Keys...).
const SOUND_TREES = ["sounds", "drums", "instruments", "user_library", "places"];
// Simpler's settings, shared by live_load_sample and live_set_simpler (bridge 0.8.0).
const SIMPLER_SETTINGS = {
  mode: { type: "string", enum: ["classic", "one-shot", "slice"], description: "Classic plays the sample across the keys; one-shot plays it once per hit; slice cuts it into pieces, one per key from C1 (pad 1 on most pad controllers) up" },
  slice_by: { type: "string", enum: ["transient", "beat", "region", "manual"], description: "In slice mode: at each hit (transient), every beat_division, or into equal regions" },
  sensitivity: { type: "number", description: "For slice_by transient: 0-100, higher = more slices" },
  beat_division: { type: "string", enum: ["1/16", "1/16T", "1/8", "1/8T", "1/4", "1/4T", "1/2", "1/2T", "1 bar", "2 bars", "4 bars"], description: "For slice_by beat" },
  regions: int("For slice_by region: how many equal slices, 2-64"),
  warp: { type: "boolean", description: "Warp on (follows the set's tempo) or off (plays at its own speed; transpose then also changes speed)" },
  warp_mode: { type: "string", enum: ["beats", "tones", "texture", "re-pitch", "complex", "complex pro"] },
  transpose: { type: "number", description: "Semitones, -48 to 48 (e.g. -6 takes A#m to Em)" },
  slice_playback: { type: "string", enum: ["mono", "poly", "thru"], description: "In slice mode: mono (one slice at a time), poly, or thru (a slice plays on into the next)" },
};
const pickSettings = (a: Record<string, unknown>) =>
  Object.fromEntries(Object.keys(SIMPLER_SETTINGS).filter((k) => a[k] !== undefined && a[k] !== null).map((k) => [k, a[k]]));
const CATALOG_TTL_MS = 10 * 60 * 1000;
const catalogs = new Map<string, { at: number; items: Candidate[]; complete: boolean }>();
/** Every loadable path in one browser tree, from the bridge's list_tree, kept for 10 minutes. */
async function catalog(tree: string, refresh: boolean) {
  const hit = catalogs.get(tree);
  if (hit && !refresh && Date.now() - hit.at < CATALOG_TTL_MS) return hit;
  const r = await bridge("list_tree", { tree, limit: 5000 }, 20) as { items: string[]; more: boolean; complete: boolean };
  const entry = { at: Date.now(), items: r.items.map((p) => ({ tree, path: p })), complete: r.complete && !r.more };
  catalogs.set(tree, entry);
  return entry;
}

// The second-chair skill (.claude/skills/second-chair/SKILL.md in this repo) is the studio guide. Claude Code loads it as
// a skill; other MCP clients (HeyClicky) get the same file from the studio_guide tool, so there is one source.
const GUIDE_PATH = path.join(import.meta.dirname, "..", "..", ".claude", "skills", "second-chair", "SKILL.md");
const PLAYBOOKS = ["session-start", "sound-design", "mixing", "mastering", "arrangement", "recording", "song-analysis"];
function studioGuide(section?: string, playbook?: string): string {
  if (playbook) {
    if (!PLAYBOOKS.includes(playbook)) throw new Error(`No playbook "${playbook}". Playbooks: ${PLAYBOOKS.join(", ")}`);
    return fs.readFileSync(path.join(path.dirname(GUIDE_PATH), "playbooks", `${playbook}.md`), "utf8");
  }
  let text: string;
  try { text = fs.readFileSync(GUIDE_PATH, "utf8"); } catch { throw new Error(`The studio guide isn't at ${GUIDE_PATH}.`); }
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "").trim(); // drop the skill's front matter
  const profile = readProfile();
  text += "\n\n## My studio (the user's own profile)\n\n" + (profile?.replace(/^# .*\n+/, "").replace(/^(#{2,5}) /gm, "#$1 ") ?? `There is no studio profile yet (${profilePath()}). Call my_studio for the questions to ask, then save the answers with it.`);
  if (!section) return text;
  const parts = text.split(/\n(?=## )/);
  const want = section.toLowerCase();
  const hit = parts.filter((p) => p.split("\n")[0].toLowerCase().includes(want));
  if (!hit.length) throw new Error(`No section matches "${section}". Sections: ${parts.slice(1).map((p) => p.split("\n")[0].replace(/^## /, "")).join("; ")}`);
  return hit.join("\n\n");
}

// ---------- sounds by description: shared by live_find_sound, live_load_sound and live_audition ----------

async function findSounds(description: string, treesArg: unknown, limitArg: unknown, refresh: boolean) {
  const trees = (Array.isArray(treesArg) && treesArg.length ? treesArg : ["sounds"]) as string[];
  for (const t of trees) if (!SOUND_TREES.includes(t)) throw new Error(`Unknown tree "${t}". Use: ${SOUND_TREES.join(", ")}`);
  const limit = Math.max(1, Math.min(12, Number(limitArg ?? 5)));
  const items: Candidate[] = [];
  const searched: Record<string, number> = {};
  let partial = false;
  for (const t of trees) {
    const c = await catalog(t, refresh);
    items.push(...c.items);
    searched[t] = c.items.length;
    if (!c.complete) partial = true;
  }
  const tags = loadTags(refresh);
  return { r: rankSounds(description, items, tags, limit), searched, partial, tags };
}

// Loads a sound onto an empty MIDI track (or a new one). Returns the bridge's answer plus undo_steps for all of it.
async function loadSound(a: Record<string, unknown>) {
  const hasTrack = a.track !== undefined && a.track !== null;
  if (hasTrack === !!a.new_track) throw new Error("Give either track (an empty MIDI track) or new_track: true.");
  const tree = String(a.tree ?? "sounds");
  if (!SOUND_TREES.includes(tree)) throw new Error(`Unknown tree "${tree}". Use: ${SOUND_TREES.join(", ")}`);
  let track = Number(a.track);
  let steps = 0;
  let reverts = 0; // the bridge's own change list: one entry per change it made
  let created: unknown;
  if (a.new_track) {
    created = await bridge("create_midi_track", { name: String(a.track_name || displayName(String(a.path))) });
    track = (created as { track: number }).track;
    steps += 2; // the track, and its name
    reverts += 1;
  }
  let out: Record<string, unknown>;
  try {
    out = await bridge("load_device", { track, path: String(a.path), tree, only_if_no_instrument: true }, 20) as Record<string, unknown>;
  } catch (e) {
    if (created) throw new Error(`${(e as Error).message}. The new empty track ${track} is still there; live_undo with steps ${steps} takes it back.`);
    throw e;
  }
  steps += Number(out.undo_steps ?? 1);
  reverts += 1;
  if (a.arm) {
    const armed = await bridge("arm_track", { track, armed: true }) as { changed?: boolean };
    steps += 1;
    if (armed.changed) reverts += 1;
  }
  return { ...out, track, ...(created ? { new_track: created } : {}), armed: !!a.arm, undo_steps: steps, revert_steps: reverts };
}

// ---------- audition: step through a shortlist on one track (keep / next / back / maybe) ----------
// The state is saved to a file, so a restarted server (or HeyClicky) can carry on. The bridge only replaces the
// track's instrument when it still has the name this audition loaded, so it never swaps out a sound the user chose.
type Audition = { description: string; track: number; picks: Pick[]; at: number; instrument: string; maybes: number[]; started: string };
const AUDITION_FILE = () => path.join(process.env.SECOND_CHAIR_STATE_DIR || path.join(os.homedir(), "SecondChair"), "audition.json");
function readAudition(): Audition | null {
  try { return JSON.parse(fs.readFileSync(AUDITION_FILE(), "utf8")); } catch { return null; }
}
function saveAudition(a: Audition | null) {
  if (!a) { try { fs.rmSync(AUDITION_FILE()); } catch { /* none */ } return; }
  fs.mkdirSync(path.dirname(AUDITION_FILE()), { recursive: true });
  fs.writeFileSync(AUDITION_FILE(), JSON.stringify(a, null, 1));
}
function auditionView(a: Audition, extra: Record<string, unknown> = {}) {
  const p = a.picks[a.at];
  return {
    ...extra,
    now_playing: `${a.at + 1} of ${a.picks.length}: ${p.name}`,
    why: p.why,
    track: a.track,
    shortlist: a.picks.map((x, i) => `${i === a.at ? "▶ " : ""}${i + 1}. ${x.name}${a.maybes.includes(i) ? " (maybe)" : ""}`),
    maybes: a.maybes.map((i) => a.picks[i].name),
    next: `the user plays it on the keys. Then: "keep" (stop here), "next", "back", "maybe" (note it and move on), or "go to" a number.`,
  };
}
async function swapTo(a: Audition, i: number) {
  const p = a.picks[i];
  const out = await bridge("load_device", { track: a.track, path: p.path, tree: p.tree, replace_instrument: a.instrument }, 20) as Record<string, unknown>;
  a.at = i;
  a.instrument = String(out.instrument ?? displayName(p.path));
  saveAudition(a);
  return out;
}

// ---------- pad swaps: saved, so a swapped-out sample can always be put back ----------
// One JSON line per swap in ~/SecondChair/pad-swaps.jsonl (SECOND_CHAIR_STATE_DIR changes the folder; the tests use it).
const SWAP_LOG = () => path.join(process.env.SECOND_CHAIR_STATE_DIR || path.join(os.homedir(), "SecondChair"), "pad-swaps.jsonl");
type SwapEntry = { at: string; track: number; track_name: string; note: number; note_name: string;
  was: { sample: string; file: string }; now: { sample: string; file: string; path: string }; restore_of?: string };
function readSwaps(): SwapEntry[] {
  try { return fs.readFileSync(SWAP_LOG(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function saveSwap(e: SwapEntry) {
  fs.mkdirSync(path.dirname(SWAP_LOG()), { recursive: true });
  fs.appendFileSync(SWAP_LOG(), JSON.stringify(e) + "\n");
}
/** "D1" -> 38 (Live's naming, 36 = C1); null if it isn't a note name. */
function noteFromName(t: string): number | null {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(t.trim());
  if (!m) return null;
  const pc = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as "c"]! + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  const n = (Number(m[3]) + 2) * 12 + pc;
  return n >= 0 && n <= 127 ? n : null;
}
/** The saved swap to undo for one track and pad (number, note, note name or words from either sample's name). */
function swapToRestore(track: number, pad: unknown): SwapEntry {
  const mine = readSwaps().filter((e) => e.track === track);
  const undone = new Set(readSwaps().map((e) => e.restore_of).filter(Boolean));
  const open = mine.filter((e) => !e.restore_of && !undone.has(e.at));
  let hits = open;
  if (pad !== undefined && pad !== null && pad !== "") {
    const s = String(pad).trim();
    const n = /^\d+$/.test(s) ? Number(s) : null;
    const note = n !== null ? (n >= 1 && n <= 16 ? 35 + n : n) : noteFromName(s);
    hits = note !== null ? open.filter((e) => e.note === note)
      : open.filter((e) => s.toLowerCase().split(/\s+/).every((w) => `${e.was.sample} ${e.now.sample}`.toLowerCase().includes(w)));
  }
  const e = hits.at(-1);
  if (!e) throw new Error(`No saved swap to put back on track ${track}${pad !== undefined ? ` for pad ${pad}` : ""}. Saved swaps are in ${SWAP_LOG()}.`);
  return e;
}

const MISSING_DEVICE = "Chord Coach isn't reporting. In Live, drop Chord Coach (User Library > Presets > MIDI Effects > Max MIDI Effect) on the MIDI track you play, and arm the track or set Monitor to In so it hears the keyboard.";
const withDeviceHint = (r: unknown) => ((r as { device?: string }).device === "missing" ? { ...(r as object), hint: MISSING_DEVICE } : r);
// Second Chair Ears: the device's 8 band filters sit an octave apart (see ears/make_amxd.py).
const EARS_BANDS = [["sub", 63], ["bass", 125], ["low mids", 250], ["mids", 500], ["mids", 1000], ["upper mids", 2000], ["presence", 4000], ["air", 8000]] as const;
const EARS_SILENT_DB = -70;
type EarsRow = { track: number; name: string; device_id: number; age_ms: number; peak_db: number; rms_db: number; bands_db: number[]; window_seconds: number; window_peak_db: number; window_rms_db: number };
function earsRow(e: EarsRow) {
  const hz = (f: number) => (f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`);
  const silent = e.window_rms_db < EARS_SILENT_DB;
  const power = e.bands_db.map((d) => 10 ** (d / 10));
  const total = power.reduce((x, y) => x + y, 0) || 1;
  const bands = EARS_BANDS.map(([word, f], i) => ({ band: `${hz(f)} (${word})`, db: e.bands_db[i], share_percent: silent ? 0 : Math.round((100 * power[i]) / total) }));
  const top = [...bands].sort((x, y) => y.db - x.db);
  const peak = e.window_peak_db;
  return {
    track: e.track, name: e.name, age_ms: e.age_ms,
    now: { peak_db: e.peak_db, rms_db: e.rms_db },
    last_moment: { seconds: e.window_seconds, peak_db: peak, rms_db: e.window_rms_db, crest_db: silent ? null : Math.round((peak - e.window_rms_db) * 10) / 10 },
    reads: silent ? "silent" : peak >= -0.1 ? "at the top: likely clipping here" : peak >= -3 ? "hot" : peak >= -18 ? "healthy" : "low",
    most_energy: silent ? "none: nothing is coming through" : `${top[0].band}, then ${top[1].band}`,
    bands,
  };
}
// Live's meter value (Track.output_meter_level) is a straight line in dB: 0 is -70 dB and 1 is +6 dB, so 0 dB sits at 0.921.
// Measured in Live 12.4 with a sine at 14 levels from -62 to +4 dB, against Second Chair Ears and Live's own peak readout.
const meterDb = (v: number) => Math.round((76 * v - 70) * 10) / 10;
function levelRow(r: Record<string, unknown>) {
  if (r.audio === false) return r; // a MIDI track with no instrument: the bridge (0.10.2) already says "no audio"
  const peak = Number(r.peak) || 0;
  const silent = peak < 0.005, db = meterDb(peak);
  return { ...r, peak_db: silent ? null : db, about: silent ? "silent" : `${db} dB`,
    reads: silent ? "silent" : db >= -0.1 ? "near the top" : db >= -3 ? "hot" : db >= -18 ? "healthy" : "low" };
}
/** Live's note names: 60 = C3. */
const noteName = (n: number) => `${SHARPS[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 2}`;

function scaleId(s: unknown): ScaleId {
  const id = String(s ?? "major");
  if (!(id in SCALES)) throw new Error(`Unknown scale "${id}". Use one of: ${SCALE_IDS.join(", ")}`);
  return id as ScaleId;
}
function rootPc(r: unknown): number {
  const pc = typeof r === "number" ? r : parseRoot(String(r));
  if (pc === null || pc < 0 || pc > 11) throw new Error(`Couldn't read the root "${r}". Use a note name like E, F#, Bb, or 0-11.`);
  return pc;
}

// ---------- 0.12.0: tools that need the 0.11.0 Remote Script ----------

const NEW_SCRIPT = "0.11.0";
/** A bridge call for a tool added with Remote Script 0.11.0: an older script gets a plain "update and restart" answer. */
async function bridgeNew(tool: string, action: string, params: Record<string, unknown> = {}, waitSeconds = 12): Promise<unknown> {
  try { return await bridge(action, params, waitSeconds); }
  catch (e) {
    if (/unknown action/.test((e as Error).message)) throw new Error(`${tool} needs the Second Chair script ${NEW_SCRIPT} or newer in Live, and Live is running an older one. Ask the user to update the Live script (run the installer again), then save, fully quit Live and open it again. Nothing was changed.`);
    throw e;
  }
}

/** A WAV file's length in seconds, from its header only (null for other formats or a header this can't read). */
function wavSeconds(file: string): number | null {
  try {
    const fd = fs.openSync(file, "r"); const buf = Buffer.alloc(65536); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    if (n < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
    let pos = 12, byteRate = 0;
    while (pos + 8 <= n) {
      const id = buf.toString("ascii", pos, pos + 4), size = buf.readUInt32LE(pos + 4);
      if (id === "fmt " && pos + 16 <= n) byteRate = buf.readUInt32LE(pos + 16);
      if (id === "data") { const total = size === 0xffffffff || !size ? fs.statSync(file).size - pos - 8 : size; return byteRate ? total / byteRate : null; }
      pos += 8 + size + (size % 2);
    }
    return null;
  } catch { return null; }
}

/** Copies an audio file into the set's project (Samples\Imported), like Live's own "Collect files on import".
 * Never overwrites: a different file with the same name gets " (2)", " (3)"... A file already in the project stays put. */
function copyIntoProject(file: string, setPath: string): { use: string; copied: boolean; note: string } {
  const project = path.dirname(setPath);
  const rel = path.relative(project, file);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return { use: file, copied: false, note: "The file is already inside the set's project folder, so it wasn't copied." };
  const dir = path.join(project, "Samples", "Imported");
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(file), base = path.basename(file, ext);
  const size = fs.statSync(file).size;
  for (let k = 1; k < 100; k++) {
    const dest = path.join(dir, k === 1 ? `${base}${ext}` : `${base} (${k})${ext}`);
    if (fs.existsSync(dest)) {
      if (fs.statSync(dest).size === size && fs.readFileSync(dest).equals(fs.readFileSync(file))) return { use: dest, copied: false, note: `The same file was already in the project: ${dest}` };
      continue;
    }
    fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
    return { use: dest, copied: true, note: `Copied into the project: ${dest}` };
  }
  throw new Error(`Too many files called "${base}${ext}" in ${dir} already. Nothing was changed.`);
}

const CLIP_REF = {
  track: int("The clip's track, from 0"),
  slot: int("Session clip: its slot, from 0"),
  bar: { type: "number", description: "Arrangement clip instead: the bar it starts at (from live_get_arrangement)" },
  name: { type: "string", description: "Arrangement clip: its name (a check against the wrong clip)" },
};
const clipRef = (a: Record<string, unknown>) => {
  if ((a.slot === undefined) === (a.bar === undefined)) throw new Error("Give slot (a Session clip) or bar and name (an Arrangement clip), one of them.");
  if (a.bar !== undefined && a.name === undefined) throw new Error("An Arrangement clip needs its name too (live_get_arrangement shows it).");
  return a.slot !== undefined ? { track: a.track, slot: a.slot } : { track: a.track, bar: a.bar, name: a.name };
};
const GRIDS = ["1/4", "1/8", "1/8t", "1/8+1/8t", "1/16", "1/16t", "1/16+1/16t", "1/32"];

const tools: Tool[] = [
  // --- Live: read ---
  { name: "live_status", description: "Check the connection and read the Live set: which set is open (set: name, unsaved, untitled, and its file path; if it has a warning, tell the user and ask before changing anything), whether Live is waiting on a message box (dialog: open, its text and how many buttons; tell the user and let them answer it in Live), tempo, time signature, playing state, song scale, every track (index, name, MIDI/audio, armed, monitor, devices, group), the return tracks and Main (returns and main: they have track numbers too, right after the regular tracks, so the device, knob, level and automation tools work on them), scenes and the selected track. Call this first.",
    inputSchema: obj({}), run: async () => {
      const [pinged, title] = await Promise.all([bridge("ping").catch((e: Error) => e), openSet()]);
      if (pinged instanceof Error) {
        // Live may be stuck on a message box (a crash-recovery question, say) before or while the script runs.
        const boxes = logMessageBoxes(3).since_live_started;
        if (!boxes.length) throw pinged;
        const last = boxes[boxes.length - 1];
        throw new Error(`${pinged.message} Live's log shows a message box${last.seconds_ago !== null ? ` from ${last.seconds_ago} s ago` : ""}: "${last.text}". It may still be open and waiting for an answer: ask the user to look at Live and answer it there. (The log doesn't say when a box closes.)`);
      }
      const { set_api, dialog: apiDialog, ...ping } = pinged as { bridge?: string; set_api?: ApiSet; dialog?: { open: boolean; count: number; text?: string; buttons?: number } };
      const set = mergeSet(title, set_api);
      const running = ping.bridge;
      const older = (a: string, b: string) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); return false; };
      const versions = running && older(running, NEEDS_BRIDGE)
        ? { version_warning: `Live is running bridge ${running}, but these tools need ${NEEDS_BRIDGE} or newer. New tools may answer "unknown action". Ask the user to update the Live script (run the installer again), then save, fully quit Live (check it's gone from the taskbar) and open it again.` }
        : {};
      const who = profileName();
      const studio = readProfile() ? { studio_profile: who ? `yes (${who})` : "yes" } : { studio_profile: "none yet: call my_studio" };
      const named = (set as { warning?: string }).warning ? { ...set, warning: personalize((set as { warning: string }).warning, who) } : set;
      const guide = { plugin_guide: readPlugins() ? "yes: call my_plugins before recommending a plugin" : "none yet: call my_plugins" };
      const logged = logMessageBoxes(3).since_live_started;
      const dialog: Record<string, unknown> = apiDialog
        ? { open: apiDialog.open, ...(apiDialog.open ? { text: apiDialog.text ?? null, buttons: apiDialog.buttons ?? null } : {}), source: "Live's API" }
        : { open: null, source: "unknown: the Live script is older than 0.11.0, so only Live's log can say" };
      if (apiDialog?.open) dialog.note = "Live is waiting on this message box. Tell the user what it says and let them answer it in Live; nothing here presses its buttons.";
      if (logged.length) dialog.log = { message_boxes_since_live_started: logged, note: "From Live's Log.txt. The log doesn't say when a box closes, so these may be closed already." };
      const session = await bridge("get_session") as { tracks: { index: number; name: string; kind: string }[] };
      const stems = stemJobSummary(session);
      return { ...ping, ...versions, ...studio, ...guide, set: named, dialog, ...(stems ? { stem_separation: stems } : {}), session };
    } },
  { name: "live_get_track", description: "One track in detail, including which clip slots hold clips. Tracks are numbered from 0.",
    inputSchema: obj({ track: int("Track index from 0") }, ["track"]), run: (a) => bridge("get_track", a) },
  { name: "live_get_clip_notes", description: "The MIDI notes in a clip (pitch, start and duration in beats, velocity).",
    inputSchema: obj({ track: int("Track index from 0"), slot: int("Clip slot index from 0") }, ["track", "slot"]), run: (a) => bridge("get_clip_notes", a) },

  // --- Live: write (all undoable with live_undo) ---
  { name: "live_write_clip", description: "Create a new MIDI clip in an EMPTY slot of a MIDI track and fill it with notes. Never overwrites an existing clip. Beats: 4 beats = 1 bar in 4/4.",
    inputSchema: obj({ track: int("MIDI track index from 0"), slot: int("Empty clip slot index from 0"),
      length_beats: { type: "number", description: "Clip length in beats, e.g. 16 for 4 bars of 4/4" },
      notes: { type: "array", items: NOTE, description: "Notes to write" }, name: { type: "string", description: "Clip name" } },
      ["track", "slot", "length_beats", "notes"]), run: (a) => bridge("create_midi_clip", a) },
  { name: "live_add_notes", description: "Add notes to an existing MIDI clip (keeps the notes already there).",
    inputSchema: obj({ track: int("Track index"), slot: int("Slot index"), notes: { type: "array", items: NOTE } }, ["track", "slot", "notes"]),
    run: (a) => bridge("add_notes", a) },
  { name: "live_create_midi_track", description: "Add a new MIDI track and optionally name it. Live may place it right after the selected track rather than at the end: the result's track is where it really is.",
    inputSchema: obj({ name: { type: "string" }, index: int("Position; -1 = end", { default: -1 }) }), run: (a) => bridge("create_midi_track", a) },
  { name: "live_create_audio_track", description: "Add a new audio track and optionally name it: for recording, or as a bus (route other tracks' output to it with live_set_routing io \"output\", then live_set_monitoring \"in\" so it passes their sound on). Only when the user asks (or in demo mode). Revertible with live_revert while it's empty.",
    inputSchema: obj({ name: { type: "string" }, index: int("Position; -1 = end", { default: -1 }) }), run: (a) => bridge("create_audio_track", a) },
  { name: "live_create_return_track", description: "Add a return track (a shared effect, like one reverb for several tracks) and optionally name it. Every track gets a send to it on its mixer. Load the effect on it with live_load_device using the track number it returns. Only when the user asks (or in demo mode). Revertible with live_revert while it has no devices.",
    inputSchema: obj({ name: { type: "string" } }), run: (a) => bridge("create_return_track", a) },
  { name: "live_set_monitoring", description: "Set a track's Monitor switch: \"in\" (always passes its input on: needed for a bus track), \"auto\" (only while armed) or \"off\". Only when the user asks. Revertible.",
    inputSchema: obj({ track: int("Track index from 0"), monitor: { type: "string", enum: ["in", "auto", "off"] } }, ["track", "monitor"]), run: (a) => bridge("set_monitoring", a) },
  { name: "live_set_tempo", description: "Set the song tempo in BPM (20-999).",
    inputSchema: obj({ bpm: { type: "number" } }, ["bpm"]), run: (a) => bridge("set_tempo", a) },
  { name: "live_set_scale", description: "Set Live 12's song scale (the Scale button in the control bar), so devices and MIDI tools follow it.",
    inputSchema: obj({ root: { description: "Root note name (E, F#, Bb) or pitch class 0-11", type: ["string", "integer"] },
      name: { type: "string", description: "Live's scale name exactly as Live lists it, e.g. Major, Minor, Dorian, Mixolydian" },
      enabled: { type: "boolean", description: "Turn scale mode on (default true)" } }, ["root"]),
    run: (a) => bridge("set_scale", { ...a, root: rootPc(a.root) }) },
  // --- the Arrangement timeline (0.9.0) ---
  { name: "live_get_arrangement", description: "Read the Arrangement timeline (read-only): each track's clips with start_bar, end_bar and bars (bars from 1), the last bar used, and the Arrangement Loop (on, start_bar, bars). A loop that's on makes Arrangement Record wrap round and record over earlier bars. Leave track out for every track.",
    inputSchema: obj({ track: int("Track index from 0 (optional)") }), run: (a) => bridge("get_arrangement", a) },
  { name: "live_place_clip", description: "Copy a Session clip onto the Arrangement timeline at a bar (from 1), optionally repeated to fill a number of bars. It never covers clips already on the timeline: it refuses and names them. to_track puts it on another track of the same kind (MIDI or audio). Only when the user asks (or in demo mode). Revertible with live_revert.",
    inputSchema: obj({ track: int("Track of the Session clip, from 0"), slot: int("Slot of the Session clip, from 0"),
      bar: { type: "number", description: "The bar to start at, from 1" },
      bars: { type: "number", description: "Fill this many bars with copies (optional; default one copy)" },
      to_track: int("Put it on this track instead (optional)") }, ["track", "slot", "bar"]),
    run: (a) => bridge("place_clip", a) },
  { name: "live_duplicate_track", description: "Duplicate a track, like Ctrl+D on a track in Live: the copy, with its devices and clips, lands right after it. Only when the user asks. Revertible with live_revert while the copy is unchanged.",
    inputSchema: obj({ track: int("Track index from 0") }, ["track"]), run: (a) => bridge("duplicate_track", a) },
  { name: "live_rename", description: "Rename a track or a scene. Only when the user asks, or for tracks and scenes the bridge made. Revertible with live_revert.",
    inputSchema: obj({ track: int("Track index from 0"), scene: int("Scene index from 0"), name: { type: "string" } }, ["name"]),
    run: (a) => {
      if ((a.track === undefined) === (a.scene === undefined)) throw new Error("Give track or scene (one of them).");
      return a.track !== undefined ? bridge("rename_track", { track: a.track, name: a.name }) : bridge("rename_scene", { scene: a.scene, name: a.name });
    } },
  { name: "live_automate", description: "Write automation into a Session clip (give slot; bars count from the clip's start, bar 1 = its first bar): a ramp, a curve, your own points, or an LFO wobble, on any knob (a device's, a plugin's, a rack's inside, or the mixer's Volume, Pan and sends). Written exactly, with no speed limit. Live refuses this in Arrangement clips: for the timeline use live_record_automation. Only when the user asks (or in demo mode). Revertible with live_revert when the clip had no automation for that knob before.",
    inputSchema: obj({ track: int("Track index from 0"), slot: int("The Session clip's slot"),
      device: { type: ["string", "integer"], description: "Device name, index or rack path (\"808 Rack > Saturator\"), or \"mixer\" for Volume, Pan and sends" },
      param: { type: ["string", "integer"], description: "Knob name or index (live_get_device lists them)" },
      from_bar: { type: "number", description: "Where it starts, from bar 1 of the clip" },
      to_bar: { type: "number", description: "Where it ends" },
      start: { type: "object", description: "Straight or curved ramp: the setting at from_bar, {text: \"-12 dB\"} or {percent: 0-100} or {value}. Plugin knobs take percent or value only" },
      end: { type: "object", description: "The setting at to_bar, same form" },
      curve: { type: "string", enum: ["linear", "ease_in", "ease_out", "s", "step"], description: "How start/end or points join: linear (default), ease_in (slow then fast), ease_out (fast then slow), s (gentle at both ends), step (hold, then jump at the next point)" },
      points: { type: "array", description: "Instead of start/end: [{bar, text|percent|value, curve?}], at least two. Each point's curve shapes the way to the next one", items: { type: "object" } },
      lfo: { type: "object", description: "Instead of start/end: a wobble. {shape: sine|triangle|square|saw_up|saw_down|random, rate: \"1/4\" | \"1/8t\" | \"1 bar\" | beats, low: setting, high: setting, phase: 0-1}" },
    }, ["track", "slot", "device", "param", "from_bar", "to_bar"]),
    run: (a) => bridge("automate", a) },
  // --- devices, meters and clip edits (0.9.2) ---
  { name: "live_move_device", description: "Move a device within its track or rack chain: to position (from 0), or before / after another device by name (\"move Amp after Auto Filter\"). Only when the user asks. Revertible with live_revert.",
    inputSchema: obj({ track: int("Track index from 0"), device: { type: ["string", "integer"], description: "Device name or index, or a path into a rack: \"808 Rack > chain > Amp\"" },
      position: int("New position from 0 (optional)"), before: { type: "string", description: "Put it before this device (optional)" }, after: { type: "string", description: "Put it after this device (optional)" } }, ["track", "device"]),
    run: (a) => bridge("move_device", a) },
  { name: "live_delete_device", description: "Delete one device, only when the user asks for that device to go. name must be the device's exact name (a check, so a stale index can't delete the wrong one). Not revertible with live_revert: live_undo straight away brings it back. For devices the bridge itself just loaded, prefer live_revert.",
    inputSchema: obj({ track: int("Track index from 0"), device: { type: ["string", "integer"], description: "Device name, index or rack path" }, name: { type: "string", description: "The device's exact name" } }, ["track", "device", "name"]),
    run: (a) => bridge("delete_device", a) },
  { name: "live_get_levels", description: "Read the output meters (read-only) while Live plays: each track's and Main's peak over a moment (seconds, default 1.5), in dB as Live's own meter shows it (peak_db; peak is Live's raw meter value 0-1), with a word: silent, low (under -18 dB), healthy, hot (above -3 dB), near the top (0 dB or over). It reads after the track's fader. Return tracks and Main are included (a Second Chair script older than 0.10.1 lists only regular tracks and Main, and fails when asked for a return track or Main by number). Use this for gain staging instead of reading meter colours off a screenshot.",
    inputSchema: obj({ track: int("Just this track (optional)"), seconds: { type: "number", description: "How long to watch, 0.2-5" } }),
    run: async (a) => {
      const r = await bridge("get_levels", a) as { levels?: Record<string, unknown>[] };
      return { ...r, levels: (r.levels ?? []).map(levelRow), note: "peak_db is the peak in dB as Live's track meter shows it, after the fader. peak, left and right are Live's raw meter values from 0 to 1." };
    } },
  { name: "live_listen", description: "How loud a track is right now and where its energy sits (read-only), measured from the audio itself by Second Chair Ears, an optional Max for Live audio effect the user drops on a track. No export needed. Per Ears device: peak and RMS in dBFS now and over the last moment (seconds, default 2), the gap between them (crest), 8 coarse bands with each band's share, and how old the numbers are. It measures at the device's place in the chain, before the track's fader. Refuses when no Ears device is in the set: then use live_get_levels (meters only) or audio_analyze (an exported file).",
    inputSchema: obj({ track: int("Just this track (optional)"), seconds: { type: "number", description: "How far back the window numbers look, 0.25-5 (default 2)" } }),
    run: async (a) => {
      let r: { is_playing: boolean; ears: EarsRow[] };
      try { r = await bridge("get_ears", a) as typeof r; } catch (e) {
        if (/unknown action/.test((e as Error).message)) throw new Error("The Second Chair script running in Live is older than live_listen. Update it, then fully quit Live and open it again.");
        throw e;
      }
      return { is_playing: r.is_playing, ears: r.ears.map(earsRow),
        note: "dBFS where the Ears device sits, before the track fader. Bands are an octave wide and overlap, so read them as a rough shape, not a spectrum. These are numbers, not hearing: say what they show and let the user judge the sound." };
    } },
  { name: "live_copy_clip", description: "Copy a Session clip into an empty slot (same track or another of the same kind). Revertible with live_revert.",
    inputSchema: obj({ track: int("From track"), slot: int("From slot"), to_track: int("To track"), to_slot: int("To slot (must be empty)") }, ["track", "slot", "to_track", "to_slot"]),
    run: (a) => bridge("copy_clip", a) },
  { name: "live_delete_clip", description: "Delete one Session clip (a clip in a slot), only when the user asks for that clip to go. Give the track, the slot and the clip's exact name (live_get_track shows it; an unnamed clip takes \"\"): the name must match, or nothing changes. Not revertible with live_revert: live_undo straight away brings it back. For a clip the tools just wrote, use live_revert instead. Timeline clips: live_arrangement_clip.",
    inputSchema: obj({ track: int("Track index from 0"), slot: int("Slot index from 0"), name: { type: "string", description: "The clip's exact name, as a check" } }, ["track", "slot", "name"]),
    run: (a) => bridge("delete_clip", a) },
  { name: "live_arrangement_clip", description: "Move or delete one Arrangement clip, only when the user asks. Name the clip and the bar it starts at (live_get_arrangement shows both); both must match. move: to_bar (and to_track), never covering clips; revertible with live_revert. delete: not revertible with live_revert, live_undo straight away brings it back. Live has no trim or split for scripts.",
    inputSchema: obj({ action: { type: "string", enum: ["move", "delete"] }, track: int("Track index from 0"), bar: { type: "number", description: "The bar the clip starts at" },
      name: { type: "string", description: "The clip's name" }, to_bar: { type: "number", description: "For move: the new start bar" }, to_track: int("For move: another track (optional)") },
      ["action", "track", "bar", "name"]),
    run: (a) => {
      if (a.action === "move") {
        if (a.to_bar === undefined) throw new Error("Say which bar to move it to (to_bar).");
        return bridge("move_arrangement_clip", { track: a.track, bar: a.bar, name: a.name, to_bar: a.to_bar, to_track: a.to_track });
      }
      if (a.action === "delete") return bridge("delete_arrangement_clip", { track: a.track, bar: a.bar, name: a.name });
      throw new Error(`Unknown action "${a.action}".`);
    } },
  { name: "live_record_automation", description: "Automation on the Arrangement timeline, for any knob Live shows: a device's, a plugin's (only the knobs in the plugin's parameter list; Configure in the plugin's device adds more), a rack's inside, or the mixer's Volume, Pan and sends. Shapes: a ramp (start/end), a curve, your own points, or an LFO wobble; several knobs at once with lanes (a filter sweep and a reverb rise together). Live doesn't let scripts draw on the lane, so this records it the way a controller knob would: Live plays from one bar before from_bar (out loud), Arrangement Record punches in at from_bar, the knobs move until to_bar, then it punches out, stops, and puts back the loop, Automation Arm, the play position and any armed tracks (disarmed during the take so nothing else records). Live must be stopped first. It replaces automation already in those bars; after to_bar the lane goes back to what it had there, so use hold_to_bar to ramp up and stay there. A knob with no automation yet first gets its current setting recorded in the bar before, so earlier bars keep it. Flat takes and holds work (the knob is nudged by a tiny, inaudible step so Live keeps writing). About 10 updates a second, so a wobble must take at least 0.8 seconds per cycle (faster: Live's LFO device, or a Session clip with live_automate). Under about 4.5 minutes per call. Only when the user asks (or in demo mode); say Live will play. Undo with live_undo straight away; live_revert can't.",
    inputSchema: obj({ track: int("Track index from 0 (lanes can name another track)"),
      from_bar: { type: "number", description: "Where it starts, from bar 1" },
      to_bar: { type: "number", description: "Where it ends" },
      device: { type: ["string", "integer"], description: "One knob: device name, index or rack path, or \"mixer\"" },
      param: { type: ["string", "integer"], description: "One knob: its name or index" },
      start: { type: "object", description: "Straight or curved ramp: the setting at from_bar, {text: \"-12 dB\"} or {percent: 0-100} or {value}. Plugin knobs take percent or value only" },
      end: { type: "object", description: "The setting at to_bar, same form" },
      curve: { type: "string", enum: ["linear", "ease_in", "ease_out", "s", "step"], description: "How start/end or points join: linear (default), ease_in (slow then fast), ease_out (fast then slow), s (gentle at both ends), step (hold, then jump at the next point)" },
      points: { type: "array", description: "Instead of start/end: [{bar, text|percent|value, curve?}], at least two. Each point's curve shapes the way to the next one", items: { type: "object" } },
      lfo: { type: "object", description: "Instead of start/end: a wobble. {shape: sine|triangle|square|saw_up|saw_down|random, rate: \"1/4\" | \"1/8t\" | \"1 bar\" | beats, low: setting, high: setting, phase: 0-1}" },
      lanes: { type: "array", description: "Several knobs in one take (up to 8): [{device, param, track?, and start/end, points or lfo, curve?}]", items: { type: "object" } },
      hold_to_bar: { type: ["number", "string"], description: "Keep the end setting until this bar, or \"end\" for the end of the song. Without it, after to_bar the lane goes on with whatever automation it had there before" },
    }, ["track", "from_bar", "to_bar"]),
    run: (a) => bridge("record_automation", a, 320) },
  { name: "live_read_knob", description: "Read a knob's setting at given bars, as its automation leaves it (read-only). Live must be stopped; it moves the play position to each bar, reads, and puts it back. Use it to check automation: bars before, inside and after a ramp. live_record_automation already does this after every take (read_back).",
    inputSchema: obj({ track: int("Track index from 0"),
      device: { type: ["string", "integer"], description: "Device name, index or rack path, or \"mixer\"" },
      param: { type: ["string", "integer"], description: "Knob name or index" },
      bars: { type: "array", items: { type: "number" }, description: "Bars to read at (from 1; 33.5 = half way through bar 33), up to 32" } },
      ["track", "device", "param", "bars"]),
    run: (a) => bridge("read_knob", a) },
  { name: "live_play_bars", description: "Play the Arrangement from from_bar to to_bar once, then stop and put the loop and play position back. For Melodyne's Transfer (Live 12 has no ARA, so Melodyne must hear the part played): give melodyne_track. It checks Melodyne is the first device there and the track has clips in those bars. Before calling, ask the user to open Melodyne and press Transfer. Also for listening to a section. Live must be stopped; it plays out loud.",
    inputSchema: obj({ from_bar: { type: "number", description: "Start bar, from 1" }, to_bar: { type: "number", description: "End bar" },
      melodyne_track: int("The track with Melodyne, to check before a Transfer (optional)") }, ["from_bar", "to_bar"]),
    run: (a) => bridge("play_range", a, 320) },
  { name: "live_bounce_track", description: "Bounce (print) a track to audio: records its sound over the bars onto a new audio track right after it, like resampling. channel: \"Post FX\" (default: the track's devices included, so Melodyne edits and effects are printed, but not its fader or pan), \"Pre FX\" or \"Post Mixer\". Plays out loud from one bar before; puts the loop, play position and armed tracks back. The original is left as it is: tell the user to mute or switch it off. Only when the user asks. Undo with live_undo straight away.",
    inputSchema: obj({ track: int("The track to bounce"), from_bar: { type: "number", description: "Start bar, from 1" }, to_bar: { type: "number", description: "End bar" },
      name: { type: "string", description: "Name for the new track (default: \"<track> (bounce)\")" },
      channel: { type: "string", enum: ["Post FX", "Pre FX", "Post Mixer"] } }, ["track", "from_bar", "to_bar"]),
    run: (a) => bridge("bounce_track", a, 330) },
  { name: "live_transport", description: "Live's transport buttons. play / stop: the transport. stop_all_clips: Live's Stop All Clips (every Session clip stops, so an Arrangement take doesn't keep recording them). back_to_arrangement: Live's Back to Arrangement button (the Arrangement plays again where Session clips took over). record_on / record_off: Arrangement Record. jump: move the play position to bar (from 1). Every action reports is_playing, record, bar and session_overrides_arrangement. Pressing record, play or jump only when the user asks.",
    inputSchema: obj({ action: { type: "string", enum: ["play", "stop", "stop_all_clips", "back_to_arrangement", "record_on", "record_off", "jump"] },
      bar: { type: "number", description: "For jump: the bar to go to, from 1" } }, ["action"]),
    run: (a) => {
      switch (a.action) {
        case "play": return bridge("play");
        case "stop": return bridge("stop");
        case "stop_all_clips": return bridge("stop_all_clips");
        case "back_to_arrangement": return bridge("back_to_arrangement");
        case "record_on": return bridge("set_record", { on: true });
        case "record_off": return bridge("set_record", { on: false });
        case "jump":
          if (a.bar === undefined) throw new Error("Say which bar to jump to (from 1).");
          return bridge("jump_to_bar", { bar: a.bar });
        default: throw new Error(`Unknown action "${a.action}".`);
      }
    } },
  { name: "live_fire_clip", description: "Launch a clip in Session view.",
    inputSchema: obj({ track: int("Track index"), slot: int("Slot index") }, ["track", "slot"]), run: (a) => bridge("fire_clip", a) },
  { name: "live_stop_track", description: "Stop the clips playing on one track.",
    inputSchema: obj({ track: int("Track index") }, ["track"]), run: (a) => bridge("stop_track", a) },
  { name: "live_fire_scene", description: "Launch a scene (a row of clips).",
    inputSchema: obj({ index: int("Scene index from 0") }, ["index"]), run: (a) => bridge("fire_scene", a) },
  { name: "live_arm_track", description: "Arm or disarm a track for recording / playing through.",
    inputSchema: obj({ track: int("Track index"), armed: { type: "boolean" } }, ["track"]), run: (a) => bridge("arm_track", a) },
  { name: "live_mute_track", description: "Mute or unmute a track, or switch its Solo on or off (for an A/B, or to hear or bounce one part alone). Give mute, solo or both. Works on regular and return tracks. Solo set here doesn't unsolo other tracks: the result lists any that are still soloed. Only when the user asks, or as a step of a job they asked for; put it back afterwards. Revertible.",
    inputSchema: obj({ track: int("Track index from 0"), mute: { type: "boolean", description: "true mutes the track, false unmutes it" }, solo: { type: "boolean", description: "true solos the track, false unsolos it" } }, ["track"]), run: (a) => bridge("set_mute", a) },
  { name: "live_create_scene", description: "Add empty scenes (rows of empty slots), for when every slot is full. index -1 (the default) adds them at the end; another index inserts there and moves later scenes down. Returns the new scene numbers, which are free slot numbers on every track. Not revertible by live_revert: use live_undo straight away.",
    inputSchema: obj({ index: int("Where to add: -1 = at the end (default), or a scene index from 0"), count: int("How many, 1-16 (default 1)") }), run: (a) => bridge("create_scene", a) },
  { name: "live_select_track", description: "Select a track in Live so the user can see it.",
    inputSchema: obj({ track: int("Track index") }, ["track"]), run: (a) => bridge("select_track", a) },
  { name: "live_revert", description: "Take back the bridge's own last changes (tempo, scale, clips and notes it wrote, tracks it made, sounds and devices it loaded, knobs, routing, arm), newest first. Safer than live_undo: it never touches the user's own edits, and it stops without changing anything if the user changed that thing since. preview: true lists the recent changes and whether each can be reverted. skip: true drops the newest changes from the list without touching Live (after a stop, when the user wants to keep it). Loading tools say how many changes they made in revert_steps. The list only covers changes since Live started.",
    inputSchema: obj({ steps: int("How many of the bridge's changes, newest first, 1-20 (default 1)", { default: 1 }),
      preview: { type: "boolean", description: "Only list them, change nothing" },
      skip: { type: "boolean", description: "Drop them from the list without changing Live" } }),
    run: (a) => bridge("revert", { steps: a.steps ?? 1, preview: !!a.preview, skip: !!a.skip }, 20) },
  { name: "live_undo", description: "Undo the last change in Live (same as Ctrl+Z). Prefer live_revert: Live's undo is global, so after the user has edited the set it takes back the user's own change instead. Use live_undo only right after a tool call, or for what live_revert can't take back (a pad sample swap). Live can group several bridge changes into one undo step, even ones a minute apart, so one undo may take back more than the last call: undo one step at a time and check with live_status after each. A loading tool says how many steps it used in undo_steps; pass that as steps to take it all back.",
    inputSchema: obj({ steps: int("How many undo steps, 1-40 (default 1)", { default: 1 }) }), run: (a) => bridge("undo", a.steps ? { steps: a.steps } : {}) },

  // --- device settings: read and turn knobs (undoable with live_undo) ---
  { name: "live_get_device", description: "Read every knob and switch on one device: its name, current setting as Live shows it (\"-6.0 dB\", \"30 %\", \"1.20 kHz\"), range, and the choices for switches. device \"mixer\" reads the track's own Volume, Pan and Sends. Use it before live_set_device_param so you know the exact names.",
    inputSchema: obj({ track: int("Track index from 0"),
      device: { type: ["string", "integer"], description: "Device name (\"Drum Buss\"), its index on the track from 0, or \"mixer\"" } }, ["track", "device"]),
    run: (a) => bridge("get_device_params", a) },
  { name: "live_set_device_param", description: "Turn one knob or flip one switch on a device, like the user would with the mouse. Give the setting one of three ways: text in Live's own units (\"-6 dB\", \"30 %\", \"1.2 kHz\", \"250 ms\", or a switch choice like \"Hall\"), percent of the knob's travel (0-100), or Live's raw value. Returns what it was and what it is now. For \"a bit more\", read it with live_get_device first and pick a new number. Plugins (VST/AU) only show their current setting, so text is refused for their knobs: use percent or value (read the range with live_get_device first), and check \"now\" after. Only touches the track and device named. Undo with live_undo.",
    inputSchema: obj({ track: int("Track index from 0"),
      device: { type: ["string", "integer"], description: "Device name, index from 0, or \"mixer\" for the track's Volume, Pan and Sends" },
      param: { type: ["string", "integer"], description: "Knob name as live_get_device lists it (\"Drive\", \"Dry/Wet\", \"Volume\") or its index" },
      text: { type: "string", description: "Target in Live's units, e.g. \"-6 dB\", \"35 %\", \"800 Hz\", or a choice name" },
      percent: { type: "number", description: "0-100 of the knob's travel" },
      value: { type: "number", description: "Live's raw value, between the min and max live_get_device shows" } }, ["track", "device", "param"]),
    run: (a) => {
      if ([a.text, a.percent, a.value].filter((x) => x !== undefined).length !== 1) throw new Error("Give exactly one of text, percent or value.");
      return bridge("set_device_param", a);
    } },

  // --- routing: where a track's audio comes from and goes, and a device's sidechain input ---
  { name: "live_get_routing", description: "Read routing (read-only). With no device: the track's input (\"Audio From\" / \"MIDI From\") and output (\"Audio To\"), with every choice Live offers. With a device: its sidechain input (Live's own Compressor, Glue Compressor, Auto Filter, Gate), with the choices. Plugin (VST/AU) sidechains, like Kickstart 2's, can't be reached by scripts: the user sets those by hand on the device. Use it before live_set_routing to see the exact names.",
    inputSchema: obj({ track: int("Track index from 0"),
      device: { type: ["string", "integer"], description: "A device on the track, by name or index from 0. Leave out for the track's own input and output" } }, ["track"]),
    run: (a) => bridge("get_routing", a) },
  { name: "live_set_routing", description: "Change routing, only when the user asks. Sidechain: give the device and source (the track the audio comes from, e.g. \"Drums\" or \"2-Drums\"), and optionally channel (the tap point, \"Post FX\", or one Drum Rack chain like \"1 kick\"). Track: io \"input\" or \"output\" with source and channel (e.g. an audio track's input from \"Ext. In\", channel \"1\"). Names match Live's choosers; a few words from one choice are enough. Undo with live_undo using the undo_steps it reports.",
    inputSchema: obj({ track: int("Track index from 0"),
      device: { type: ["string", "integer"], description: "The device whose sidechain to set (name or index). Leave out to route the track itself" },
      io: { type: "string", description: "For a track: \"input\" or \"output\". For a device with more than one input: which one, as live_get_routing names it. Default for a device: its sidechain" },
      source: { type: "string", description: "Where the audio comes from (or goes, for output), as live_get_routing lists it" },
      channel: { type: "string", description: "The channel or tap point, e.g. \"Post FX\", \"1 kick\", \"1\"" } }, ["track"]),
    run: (a) => {
      if (!a.source && !a.channel) throw new Error("Give source and/or channel.");
      return bridge("set_routing", a);
    } },

  // --- Live's browser: find and load devices and samples (undoable with live_undo) ---
  { name: "live_browse", description: `Look through Live's browser (read-only). Give a query to search names inside one tree, or a path to list one folder. Trees: ${BROWSER_TREES.join(", ")}. "places" is the folders the user added under Places in Live's browser. Results give each item's path, which live_load_device and live_build_drum_kit accept.`,
    inputSchema: obj({ tree: { type: "string", enum: BROWSER_TREES, description: "Which part of the browser" },
      query: { type: "string", description: "Words to find in item names, e.g. \"drum buss\" or \"reverb\". Leave out to list the folder at path" },
      path: { type: "string", description: "A folder inside the tree, names joined with /, e.g. \"Drums\" or \"Fluffy Kit - finger drums\"" },
      limit: int("Most results to return, 1-200 (default 40)", { default: 40 }) }, ["tree"]),
    run: (a) => bridge("browse", a, 20) },
  { name: "live_load_device", description: "Load an instrument, audio effect or MIDI effect from Live's browser onto the end of one track's device chain, by name (\"Drum Buss\", \"Reverb\", \"Operator\") or by a path from live_browse. Only touches the track you name. Refuses to load an instrument onto a track that already has one, because Live would replace it. Undo with live_undo.",
    inputSchema: obj({ track: int("Track index from 0"),
      name: { type: "string", description: "Device or preset name, e.g. Drum Buss, Glue Compressor, Echo" },
      path: { type: "string", description: "Exact browser path from live_browse, e.g. \"Drum Buss\" or \"Reverb/Hall/Large Hall\"" },
      tree: { type: "string", enum: DEVICE_TREES, description: "Where to look (default: audio effects, then MIDI effects, then instruments)" } }, ["track"]),
    run: (a) => {
      if (!a.name && !a.path) throw new Error("Give a device name (like Drum Buss) or a path from live_browse.");
      return bridge("load_device", a, 20);
    } },
  { name: "live_build_drum_kit", description: "Build a finger-drum kit in one go: put a Drum Rack on an empty MIDI track and load up to 16 samples from one folder onto its pads, in file-name order, starting at C1 (MIDI 36). Most pad controllers' first eight pads send 36-43, so sample 1 plays on pad 1. The folder must be in Places in Live's browser (or the User Library). Optionally sets each pad's volume and puts hi-hats in choke group 1, so an open hat stops when the closed hat plays. Refuses a track that already has an instrument. Undo with live_undo using the undo_steps it reports.",
    inputSchema: obj({ track: int("An empty MIDI track, index from 0 (live_create_midi_track makes one)"),
      folder: { type: "string", description: "The sample folder's name or path as Live's browser shows it, e.g. \"Fluffy Kit - finger drums\". A Windows or Mac file path also works: only its last folder names are used" },
      volumes_db: { type: "array", items: { type: "number" }, description: "Optional volume in dB for each pad in order, e.g. [0, -2, -8, -8]. Missing pads stay at 0 dB" },
      choke_hats: { type: "boolean", description: "Put samples with \"hat\" in their name in choke group 1 (default true)" },
      name: { type: "string", description: "Optional new name for the track, e.g. \"Finger drums\"" } }, ["track", "folder"]),
    run: (a) => bridge("build_drum_kit", { ...a, folder: browserPath(String(a.folder)) }, 50) },

  // --- sounds by description: find a shortlist (read-only), then load the user's pick ---
  { name: "live_find_sound", description: "Find sounds or presets in Live's browser from a plain description, like \"a warm pad\", \"a dusty Rhodes\" or \"a punchy 808 bass\". Read-only: it changes nothing. Returns a short ranked list, each with a plain reason (its name, its folder in Live's Sounds, and Live's own tags such as Lofi & Vinyl or Punchy). Show the user the list by number and let them pick, then load the pick with live_load_sound. Matching is by words, not by listening, so say the picks are a starting point.",
    inputSchema: obj({ description: { type: "string", description: "What the user wants, in their words, e.g. \"a dusty Rhodes\"" },
      trees: { type: "array", items: { type: "string", enum: SOUND_TREES }, description: "Where to look (default [\"sounds\"], Live's ready-made instrument presets). Add \"user_library\" for the user's own presets, \"drums\" for drum kits" },
      limit: int("How many to suggest, 1-12 (default 5)", { default: 5 }),
      refresh: { type: "boolean", description: "Re-read the browser and Live's tags (after installing a pack)" } }, ["description"]),
    run: async (a) => {
      const { r, searched, partial, tags } = await findSounds(String(a.description), a.trees, a.limit, !!a.refresh);
      return {
        description: a.description,
        understood: explain(r.concepts),
        shortlist: r.picks,
        ...(r.picks.length ? {} : { hint: "Nothing matched. Try a plainer word for the kind of sound (pad, keys, bass, lead, pluck, strings, choir, bells) or browse Sounds with live_browse." }),
        next: r.picks.length ? "Ask the user which number they want. Then call live_load_sound with that pick's path and tree, onto a MIDI track with no instrument (or new_track: true). To try them one by one on the keys instead, use live_audition." : undefined,
        searched_items: searched,
        ...(partial ? { note: "The browser list was cut short, so some sounds weren't searched." } : {}),
        live_tags: tags.files ? `read from ${tags.files} pack tag files` : "Live's tag files weren't found, so this matched names and folders only",
      };
    } },
  { name: "live_load_sound", description: "Load one sound or preset (a pick from live_find_sound, or a path from live_browse) onto a MIDI track that has no instrument yet, or onto a new MIDI track. Refuses an audio track and a track that already has an instrument, so it never replaces a sound. Selects the track so the user sees it. Undo with live_undo using the undo_steps it reports.",
    inputSchema: obj({ path: { type: "string", description: "The item's path, exactly as live_find_sound or live_browse gave it, e.g. \"Piano & Keys/E-Piano Rusty.adg\"" },
      tree: { type: "string", enum: SOUND_TREES, description: "The tree the path is in (default \"sounds\")" },
      track: int("A MIDI track with no instrument, index from 0"),
      new_track: { type: "boolean", description: "Make a new MIDI track for it instead (named after the sound unless track_name is given; Live may put it after the selected track, and the result says where)" },
      track_name: { type: "string", description: "Name for the new track" },
      arm: { type: "boolean", description: "Arm the track afterwards so the keyboard plays it (default false)" } }, ["path"]),
    run: async (a) => {
      const out = await loadSound(a);
      return { ...out, play: a.arm ? "Armed: play the keys to hear it." : `Arm track ${out.track} (live_arm_track) to play it on the keys.` };
    } },
  { name: "live_audition", description: "Try a shortlist of sounds one by one on the same track, so the user can play each on their keyboard and decide. step \"start\" finds sounds for a description (like live_find_sound) and loads pick 1 onto an empty MIDI track or a new one (armed by default). Then, as the user says it: \"next\" and \"back\" swap in the neighbouring pick on that track, \"maybe\" notes the current one and moves on, \"go\" jumps to a number, \"keep\" ends with the current sound in place (and lists the maybes), \"status\" shows where it is. It only ever replaces the sound this audition loaded; if the user changed the track's instrument, it stops. Each swap is one live_undo step.",
    inputSchema: obj({ step: { type: "string", enum: ["start", "next", "back", "maybe", "go", "keep", "status"], description: "What the user said" },
      description: { type: "string", description: "For start: what the user wants, e.g. \"a washed-out vocal pad\"" },
      trees: { type: "array", items: { type: "string", enum: SOUND_TREES }, description: "For start: where to look (default [\"sounds\"])" },
      limit: int("For start: how many picks, 2-12 (default 6)", { default: 6 }),
      track: int("For start: an empty MIDI track, index from 0"),
      new_track: { type: "boolean", description: "For start: make a new MIDI track for it" },
      track_name: { type: "string", description: "For start: name for the new track (default \"Audition\")" },
      arm: { type: "boolean", description: "For start: arm the track so the keyboard plays it (default true)" },
      number: int("For go: the pick number, from 1") }, ["step"]),
    run: async (a) => {
      const step = String(a.step);
      if (step === "start") {
        if (!a.description) throw new Error("Give a description to start, e.g. \"a washed-out vocal pad\".");
        const old = readAudition();
        const limit = Math.max(2, Math.min(12, Number(a.limit ?? 6)));
        const { r } = await findSounds(String(a.description), a.trees, limit, false);
        if (!r.picks.length) throw new Error("Nothing matched. Try a plainer word for the kind of sound (pad, keys, bass, lead, pluck, strings, choir, bells).");
        const p = r.picks[0];
        const loaded = await loadSound({ path: p.path, tree: p.tree, track: a.track, new_track: a.new_track,
          track_name: a.track_name || "Audition", arm: a.arm ?? true });
        const au: Audition = { description: String(a.description), track: Number(loaded.track), picks: r.picks, at: 0,
          instrument: String(loaded.instrument ?? displayName(p.path)), maybes: [], started: new Date().toISOString() };
        saveAudition(au);
        return auditionView(au, { understood: explain(r.concepts), undo_steps_to_remove_track: loaded.undo_steps,
          ...(old ? { note: `This replaces the unfinished audition on track ${old.track}; that track keeps ${old.instrument}.` } : {}) });
      }
      const au = readAudition();
      if (!au) throw new Error("No audition is running. Start one with step \"start\" and a description.");
      if (step === "status") return auditionView(au);
      if (step === "keep") {
        saveAudition(null);
        const kept = au.picks[au.at];
        return { kept: kept.name, path: kept.path, track: au.track, maybes: au.maybes.map((i) => ({ name: au.picks[i].name, path: au.picks[i].path, tree: au.picks[i].tree })),
          done: `Kept ${kept.name} on track ${au.track}. The audition is over.` };
      }
      let to: number;
      if (step === "next" || step === "maybe") {
        if (step === "maybe" && !au.maybes.includes(au.at)) au.maybes.push(au.at);
        to = au.at + 1;
        if (to >= au.picks.length) { saveAudition(au); return auditionView(au, { end: "That was the last pick. Say keep, back, go to a number, or start again with other words." }); }
      } else if (step === "back") {
        to = au.at - 1;
        if (to < 0) throw new Error("This is the first pick already.");
      } else if (step === "go") {
        to = Number(a.number) - 1;
        if (!(to >= 0 && to < au.picks.length)) throw new Error(`Pick a number from 1 to ${au.picks.length}.`);
        if (to === au.at) return auditionView(au);
      } else throw new Error(`Unknown step "${step}".`);
      try {
        await swapTo(au, to);
      } catch (e) {
        throw new Error(`${(e as Error).message}. The audition is paused; say keep to end it, or start a new one.`);
      }
      return auditionView(au, { undo_steps: 1 });
    } },

  { name: "live_load_sample", description: "Sample chopping: put an audio file into a new Simpler on a MIDI track with no instrument (or a new MIDI track), ready to play from the keys or pads. The audio is a file (a full path, or its name or words from it, looked up in the User Library's Samples folder, where Live saves Splice downloads, and Documents\\Samples), or an audio clip already in the set (from_clip, keeping its transpose). Optionally sets Simpler's mode (slice cuts it onto the pads from C1), slicing, warp and transpose in the same call. Refuses a track that already has an instrument. Take it back with live_revert (revert_steps).",
    inputSchema: obj({ track: int("A MIDI track with no instrument"), new_track: { type: "boolean", description: "Make a new MIDI track for it instead" },
      track_name: { type: "string", description: "Name for the new track (default: the file's name)" },
      file: { type: "string", description: "Full path, or the file's name or words from it" },
      from_clip: obj({ track: int("The audio clip's track"), slot: int("Its slot") }, ["track", "slot"]),
      arm: { type: "boolean", description: "Arm the track so the keyboard plays it (default true)", default: true },
      ...SIMPLER_SETTINGS }),
    run: async (a) => {
      const hasTrack = a.track !== undefined && a.track !== null;
      if (hasTrack === !!a.new_track) throw new Error("Give either track (a MIDI track with no instrument) or new_track: true.");
      if (!a.file === !a.from_clip) throw new Error("Give either file or from_clip.");
      const file = a.file ? findAudioFile(String(a.file)) : undefined;
      let track = Number(a.track), reverts = 0, created: unknown;
      if (a.new_track) {
        const base = file ? path.basename(file).replace(/\.[^.]+$/, "") : "Sample";
        created = await bridge("create_midi_track", { name: String(a.track_name || base).slice(0, 40) });
        track = (created as { track: number }).track; reverts += 1;
      }
      let out: Record<string, unknown>;
      try {
        out = await bridge("load_sample", { track, ...(file ? { file } : { from_clip: a.from_clip }), ...pickSettings(a) }, 20) as Record<string, unknown>;
      } catch (e) {
        if (created) throw new Error(`${(e as Error).message}. The new empty track ${track} is still there; live_revert takes it back.`);
        throw e;
      }
      reverts += 1;
      if (a.arm !== false) {
        const armed = await bridge("arm_track", { track, armed: true }) as { changed?: boolean };
        if (armed.changed) reverts += 1;
      }
      return { ...out, track, ...(created ? { new_track: created } : {}), armed: a.arm !== false, revert_steps: reverts };
    } },
  { name: "live_get_simpler", description: "Read a Simpler's settings: mode, sample file, warp and warp mode, slicing (by, sensitivity, beat division, regions, how many slices) and transpose.",
    inputSchema: obj({ track: int("Track index"), device: { type: ["string", "integer"], description: "Which Simpler, if the track has more than one" } }, ["track"]),
    run: (a) => bridge("get_simpler", a) },
  { name: "live_set_simpler", description: "Change a Simpler's mode, slicing, warp or transpose (only what you give). Returns was and now. Take it back with live_revert.",
    inputSchema: obj({ track: int("Track index"), device: { type: ["string", "integer"], description: "Which Simpler, if the track has more than one" }, ...SIMPLER_SETTINGS }, ["track"]),
    run: (a) => bridge("set_simpler", { track: a.track, ...(a.device !== undefined ? { device: a.device } : {}), ...pickSettings(a) }) },
  { name: "live_set_audio_clip", description: "Change an audio clip's transpose (semitones), warp on/off, or warp mode. Returns was and now. Take it back with live_revert.",
    inputSchema: obj({ track: int("Track index"), slot: int("Slot index"), transpose: int("-48 to 48 semitones"),
      warp: { type: "boolean" }, warp_mode: SIMPLER_SETTINGS.warp_mode }, ["track", "slot"]),
    run: (a) => bridge("set_audio_clip", a) },
  { name: "live_align_audio", description: "Line an audio take up with another take (stacked vocals, doubles) or with a grid, so the notes start together. It finds where notes start in each take's WAV file, then adds warp markers to the clip: a start within max_ms of the lead's nearest start (or grid line) moves onto it; every other start is pinned where it is, so nothing drifts. The lead isn't changed. preview: true shows what would move without changing anything: use it first and tell the user the count and the biggest shift. Only when the user asks. Works on WAV takes with clear starts; soft, slurred starts are left alone. Live switches the clip's Warp on if it was off. Revertible with live_revert. You can't hear it: ask the user to listen for stretched or squashed words.",
    inputSchema: obj({
      clip: { type: "object", description: "The take to move: {track, bar, name} for an Arrangement clip (from live_get_arrangement) or {track, slot} for a Session clip" },
      to: { type: "object", description: "The take to match (the lead), same form. Give this or grid" },
      grid: { type: "string", description: "Or line up with a grid: \"1/8\", \"1/16\", \"1/8t\"" },
      max_ms: { type: "number", description: "Only move a start that's within this many milliseconds of its target (5-250, default 60)" },
      sensitivity: { type: "number", description: "0-100, default 50. Higher finds softer note starts" },
      preview: { type: "boolean", description: "true = report what would move, change nothing" } }, ["clip"]),
    run: async (a) => {
      const starts = async (ref: unknown) => {
        const info = await bridge("audio_clip_info", { clip: ref }) as { file: string; clip: string };
        if (!info.file) throw new Error(`Live gave no file for the clip "${info.clip}".`);
        const wav = readWav(info.file);
        return { onsets: findOnsets(wav, a.sensitivity ?? 50), seconds: wav.seconds };
      };
      const mine = await starts(a.clip);
      const lead = a.to ? await starts(a.to) : undefined;
      return bridge("align_audio", { clip: a.clip, onsets: mine.onsets, file_seconds: mine.seconds, to: a.to, to_onsets: lead?.onsets, to_file_seconds: lead?.seconds,
        grid: a.grid, max_ms: a.max_ms ?? 60, preview: !!a.preview }, 30);
    } },
  { name: "audio_analyze", description: "Measure an audio file the way a mastering meter does, since you can't hear it: loudness (integrated LUFS, as streaming services measure it), true peak, loudness range, how far peaks sit above the average (crest), tone balance in six bands, stereo width and mono safety, and clipping. Give file (a full path to a WAV, e.g. an exported mix, or a name to look for in the sample folders) or clip (an audio clip in Live: {track, bar, name} or {track, slot}, e.g. a bounce from live_bounce_track). reference: another file (a released song the user likes, as WAV) measured the same way, with the differences. It changes nothing, and file works without Live. The numbers are measurements; the reading is a starting point. Say what they suggest, then ask the user to listen.",
    inputSchema: obj({ file: { type: "string", description: "Full path to a WAV, or a name to find in the sample folders" },
      clip: { type: "object", description: "Or an audio clip in Live: {track, bar, name} or {track, slot}" },
      reference: { type: "string", description: "A reference WAV to compare against (full path or name)" } }),
    run: async (a) => {
      if ((a.file === undefined) === (a.clip === undefined)) throw new Error("Give file or clip (one of them).");
      const find = (f: string) => (path.isAbsolute(f) && fs.existsSync(f) ? f : findAudioFile(f));
      const file = a.file !== undefined ? find(String(a.file)) : (await bridge("audio_clip_info", { clip: a.clip }) as { file: string }).file;
      if (!file) throw new Error("Live gave no file for that clip.");
      const mix = analyze(file);
      const out: Record<string, unknown> = { ...mix, reading: reading(mix) };
      if (a.reference !== undefined) {
        const ref = analyze(find(String(a.reference)));
        const d = (x: number | null, y: number | null) => (x === null || y === null ? null : Math.round((x - y) * 10) / 10);
        const bands = Object.fromEntries(Object.keys(mix.bands_db).map((k) => [k, d(mix.bands_db[k], ref.bands_db[k])]));
        const tone = Object.entries(bands).filter(([, v]) => v !== null && Math.abs(v as number) >= 2)
          .map(([k, v]) => `${k}: ${(v as number) > 0 ? "+" : ""}${v} dB against the reference`);
        out.reference = { ...ref, reading: reading(ref) };
        out.against_reference = { louder_by_lu: d(mix.integrated_lufs, ref.integrated_lufs), true_peak_db: d(mix.true_peak_db, ref.true_peak_db),
          loudness_range_lu: d(mix.loudness_range_lu, ref.loudness_range_lu), crest_db: d(mix.crest_db, ref.crest_db), bands_db: bands,
          tone: tone.length ? tone : ["Tone balance is within 2 dB of the reference in every band."],
          note: "Band differences compare each song's own balance, so they hold even when one is louder. Different songs differ for good reasons: treat a gap as a question, not a fault." };
      }
      return out;
    } },
  { name: "song_analyze", description: "Measure what the music in a song is doing, since you can't hear it: the key (with the runner-up, the relative key always named, and the scale's notes), tuning in cents from A440, tempo with the half and double readings side by side, how often the music repeats, a one-bar map of where low, mid and high hits land (kick, snare, hats), a rough bass note per bar, and loudness and tone (audio_analyze's numbers). Each reading has a confidence and a check-by-ear step. Give file (a full path to a WAV, or a name to look for in the sample folders) or clip (an audio clip in Live: {track, bar, name} or {track, slot}). WAV only. It changes nothing, and file works without Live; a 2-minute song takes a few seconds. These are measurements and options, not answers: report them, then let the user decide by ear, above all which key feels like home (a key and its relative share every note) and whether the beat feels like the half or the double. A full mix can't tell drums from other parts, or the bass from a low kick: stems settle that. stems: the index of the group track Live's Separate Stems made (\"<song> Stems\"; the tool reads each stem clip's file), or WAV paths {vocals, drums, bass, others} (any of the four). With stems it adds each stem's level (a near-silent stem means that part isn't in the song), the tempo feel from where the snare lands, the bass line and its timeline, the singer's range (held notes, the usual 10th-90th zone, the notes with the most time), a cleaner key and chord loop from the Others stem, the key the chords lean to and the key the melody leans to, and keys that suit the singer as options. A stems run takes about 10 to 20 seconds for a 2-minute song. To make the stems, live_separate_stems runs Live's Separate Stems (on the user's request; its check gives the group index for stems).",
    inputSchema: obj({ file: { type: "string", description: "Full path to a WAV, or a name to find in the sample folders" },
      clip: { type: "object", description: "Or an audio clip in Live: {track, bar, name} or {track, slot}" },
      stems: { type: ["integer", "object"], description: "The stem group track's index (from live_status: the group Separate Stems made), or {vocals, drums, bass, others}: full paths to stem WAVs. With stems, file or clip is optional: it's the full mix; without it the stems are added together.",
        properties: { vocals: { type: "string" }, drums: { type: "string" }, bass: { type: "string" }, others: { type: "string" } }, additionalProperties: false } }),
    run: async (a) => {
      if (a.stems === undefined && (a.file === undefined) === (a.clip === undefined)) throw new Error("Give file or clip (one of them), or stems.");
      if (a.file !== undefined && a.clip !== undefined) throw new Error("Give file or clip, not both.");
      const mixFile = a.file !== undefined ? (path.isAbsolute(String(a.file)) && fs.existsSync(String(a.file)) ? String(a.file) : findAudioFile(String(a.file)))
        : a.clip !== undefined ? (await bridge("audio_clip_info", { clip: a.clip }) as { file: string }).file : undefined;
      if ((a.file !== undefined || a.clip !== undefined) && !mixFile) throw new Error("Live gave no file for that clip.");
      if (a.stems === undefined) return analyzeSong(mixFile!);
      if (typeof a.stems === "number") {
        const { files, tempo, group } = await stemGroupFiles(a.stems);
        const out = analyzeStems(files, { mixFile, liveTempo: tempo });
        return { stem_group: group, ...out };
      }
      const files: StemFiles = {};
      for (const n of STEM_NAMES) {
        const f = (a.stems as Record<string, unknown>)[n];
        if (f === undefined) continue;
        if (!path.isAbsolute(String(f)) || !fs.existsSync(String(f))) throw new Error(`The ${n} stem ${JSON.stringify(f)} isn't a file. Give full paths to the stem WAVs.`);
        files[n] = String(f);
      }
      return analyzeStems(files, { mixFile });
    } },
  { name: "live_audio_clip_info", description: "What Live reports about an audio clip (read-only): its file, warp state, and the raw warp markers, start and end markers and position. For checking a clip before live_align_audio, and for reporting a wrong reading.",
    inputSchema: obj({ clip: { type: "object", description: "{track, bar, name} for an Arrangement clip or {track, slot} for a Session clip" } }, ["clip"]),
    run: (a) => bridge("audio_clip_info", { clip: a.clip }) },
  { name: "live_delete_track", description: "Delete ONE track, only when the user asks for that track to go. name must match the track's name (a check against the wrong index). Refuses a track that holds clips. live_undo, straight away, brings it back. Track numbers after it move down by one.",
    inputSchema: obj({ track: int("Track index"), name: { type: "string", description: "The track's name, as live_status shows it" } }, ["track", "name"]),
    run: (a) => bridge("delete_track", a) },
  { name: "live_swap_pad_sample", description: "Replace the sample on ONE Drum Rack pad, only when the user asks for that swap. Keeps the pad's Simpler settings, volume and choke group. Refuses empty or layered pads, and undoes itself if any other pad changed. Every swap is saved (the old sample's name and file), so restore: true puts the old sample back later, even after undo is gone. live_undo also takes it back. Find the new sample's path with live_browse first (trees places or samples).",
    inputSchema: obj({ track: int("The track with the Drum Rack, index from 0"),
      pad: { type: ["string", "integer"], description: "Which pad: 1-16 (the pads, from C1 up), a note like \"D1\", or words from its sample's name like \"snare\"" },
      sample: { type: "string", description: "The new sample's path from live_browse, e.g. \"Samples/Snares/Crunchy Snare.wav\". A Windows or Mac file path also works if its folder is in Places" },
      tree: { type: "string", enum: ["places", "samples", "user_library", "drums"], description: "Where the sample is (default: Places, then the User Library, Samples, Drums)" },
      restore: { type: "boolean", description: "Put back the sample a saved swap replaced, instead of loading a new one" } }, ["track"]),
    run: async (a) => {
      const track = Number(a.track);
      if (a.restore) {
        if (a.sample) throw new Error("Give sample or restore: true, not both.");
        const e = swapToRestore(track, a.pad);
        const out = await bridge("swap_pad_sample", { track, pad: e.note, sample: browserPath(e.was.file) }, 20) as SwapEntry & Record<string, unknown>;
        saveSwap({ at: new Date().toISOString(), track, track_name: String(out.track_name), note: out.note, note_name: out.note_name,
          was: out.was, now: out.now, restore_of: e.at });
        return { ...out, restored: `put back ${e.was.sample} (swapped out ${e.at.slice(0, 16).replace("T", " ")})` };
      }
      if (a.pad === undefined || a.pad === null || !a.sample) throw new Error("Give the pad and the new sample's path (or restore: true).");
      const out = await bridge("swap_pad_sample", { track, pad: a.pad, sample: browserPath(String(a.sample)), ...(a.tree ? { tree: a.tree } : {}) }, 20) as SwapEntry & Record<string, unknown>;
      const at = new Date().toISOString();
      saveSwap({ at, track, track_name: String(out.track_name), note: out.note, note_name: out.note_name, was: out.was, now: out.now });
      return { ...out, saved: `The old sample is saved in ${SWAP_LOG()}. restore: true puts it back.` };
    } },

  // --- Chord Coach (the Max for Live device): light chords on its keys, read what the user plays ---
  { name: "live_show_on_keys", description: "Light a chord on Chord Coach's keyboard in Live (the Max for Live device on a MIDI track), so the user sees where to put their fingers on a 25-key keyboard. Give a chord symbol (\"Dm7\", \"A13\", \"B7b9\", \"G/B\", \"F sharp minor\"), or chord tones, or exact MIDI notes. Chords are voiced for 25 keys (MIDI 48-72) with Spur's voicing. clear: true goes back to the device's own chord. Changes only the display, never the set.",
    inputSchema: obj({ chord: { type: "string", description: "Chord symbol, e.g. Dm7, A13, Cmaj9, B7b9, G/B" },
      tones: { type: "array", items: { type: ["string", "integer"] }, description: "Chord tones, root first (note names or pitch classes)" },
      notes: { type: "array", items: { type: "integer" }, description: "Exact MIDI notes to light (48-72 are a 25-key keyboard's keys)" },
      label: { type: "string", description: "Text shown on the device (defaults to the chord's name)" },
      clear: { type: "boolean", description: "Clear the shown chord" } }),
    run: async (a) => {
      if (a.clear) return withDeviceHint(await bridge("clear_keys"));
      let notes: number[], label: string;
      if (a.chord) { const c = parseChordSymbol(String(a.chord)); notes = keysFor(c.pcs, c.bass); label = c.label; }
      else if (Array.isArray(a.tones) && a.tones.length) {
        notes = keysFor((a.tones as unknown[]).map(rootPc));
        const s = chordShape(notes);
        label = s ? shapeLabel(s) : (a.tones as unknown[]).join(" ");
      } else if (Array.isArray(a.notes) && a.notes.length) { notes = a.notes as number[]; label = ""; }
      else throw new Error("Give a chord (like Dm7), tones, or notes. Or clear: true.");
      const out = await bridge("show_on_keys", { notes, label: a.label ?? label }) as Record<string, unknown>;
      return withDeviceHint({ ...out, note_names: notes.map(noteName) });
    } },
  { name: "live_what_am_i_playing", description: "What the user is playing right now on their keyboard, from Chord Coach in Live: the held notes, the chord's name read against the key (Live's Scale setting, or root/scale given here), the last few chords (the trail) and a short timeline of recent notes. Released notes ring for 1.2 s, so an arpeggio still reads as a chord.",
    inputSchema: obj({ root: { type: ["string", "integer"], description: "Key root (optional; defaults to Live's song scale when Scale is on)" },
      scale: { type: "string", enum: SCALE_IDS, description: "Scale for the key (default major when root is given)" } }),
    run: async (a) => {
      const p = await bridge("get_played") as { now: number; device: string; held: number[]; events: NoteEvent[]; shown: unknown };
      let key: { pc: number; sc: ScaleId; from: string } | null = null;
      if (a.root !== undefined) key = { pc: rootPc(a.root), sc: scaleId(a.scale ?? "major"), from: "given" };
      else {
        try {
          const s = await bridge("get_session") as { root_note?: number; scale_name?: string; scale_mode?: boolean };
          const sc = scaleFromLive(s.scale_name);
          if (s.scale_mode && typeof s.root_note === "number" && sc) key = { pc: s.root_note, sc, from: "Live's Scale setting" };
        } catch { /* no key: name chords without one */ }
      }
      const name = (notes: number[], fallback: string) => {
        if (!key) return fallback;
        const r = nameChord(notes, key.pc, key.sc) as { name?: string; extensions?: string[] };
        return r.name ? r.name + (r.extensions?.length ? ` add ${r.extensions.join(" ")}` : "") : fallback;
      };
      const { ringing } = soundingAt(p.events, p.now);
      const held = p.held; // the bridge's own held set also covers notes pressed more than 30 s ago
      const now = soundingChord(held, ringing.filter((n) => !held.includes(n)));
      const trail = chordTrail(p.events, p.now, (n, s) => name(n, shapeLabel(s))).slice(-8)
        .map((t) => ({ chord: t.chord, seconds_ago: Math.round((p.now - t.at) / 100) / 10 }));
      const recent = createRecentPlaying();
      recent.ingest(p.events, p.now);
      return withDeviceHint({
        device: p.device,
        key: key ? `${keyCard(key.pc, key.sc).title} (from ${key.from})` : "none (turn on Scale in Live, or pass root and scale)",
        holding: held.map(noteName),
        ringing: ringing.filter((n) => !held.includes(n)).map(noteName),
        chord: now ? { ...(key ? nameChord(now.notes, key.pc, key.sc) : { name: shapeLabel(now.shape) }), notes: now.notes.map(noteName), counted_ringing_notes: now.usedRinging } : null,
        ...(!now && trail.length ? { last_played: trail.at(-1) } : {}),
        trail_oldest_first: trail,
        recent_midi: recent.summary(p.now),
        note_naming: "holding, ringing and chord notes use Live's names (MIDI 60 = C3; a 25-key keyboard's lowest key, 48, = C2). recent_midi comes from Spur and names one octave higher (60 = C4).",
      });
    } },

  // --- the studio guide (the second-chair skill), for clients that can't load skills ---
  { name: "studio_guide", description: "The user's studio setup and how to help in Live: how to talk to the user, which tool fits which request, the safety rules, the gear and folder facts, fixes for common problems, and HeyClicky notes. Read it at the start of a music session if you don't have the second-chair skill. section narrows it, e.g. \"fixes\" or \"which tool\". Works without Live.",
    inputSchema: obj({ section: { type: "string", description: "Words from a section title: \"how to work\", \"start\", \"playbooks\", \"which tool\", \"safety\", \"facts\", \"fixes\", \"heyclicky\", \"working on the tools\", \"mac\", \"my studio\"" },
      playbook: { type: "string", enum: PLAYBOOKS, description: "Step-by-step best practices for one kind of job; read it before the first write of that kind" } }),
    run: (a) => ({ mcpContent: [{ type: "text", text: personalize(studioGuide(a.section ? String(a.section) : undefined, a.playbook ? String(a.playbook) : undefined)) }] }) },
  { name: "my_studio", description: "The user's studio profile: their name, how they like to be taught, their controller, interface, instruments, sample folders and plugins, and fixes that are about their machine. Read it once at the start of a session (no arguments). If there is none yet, this returns the questions to ask: ask a few at a time, in conversation, and don't guess. Save with text (the whole profile as Markdown, keeping the '- **Name:** ...' line): only what the user told you, and only when they agree to save it. Saving keeps the previous version next to it. Works without Live.",
    inputSchema: obj({ text: { type: "string", description: "The whole profile as Markdown, to save. Leave out to read" } }),
    run: (a) => {
      if (a.text !== undefined) {
        const file = writeProfile(String(a.text));
        return { saved: file, name: profileName(), note: "Saved. The tools use the name from the next request on." };
      }
      const profile = readProfile();
      if (profile) return { mcpContent: [{ type: "text", text: profile }] };
      return { profile: null, file: profilePath(), questions: QUESTIONS,
        note: "No studio profile yet. Ask the user these questions a few at a time (not all at once, and not before helping with what they asked), then save their answers with my_studio text. Don't ask what the computer can tell you: the installer's --survey mode (install.ps1 or install.sh at the top of the tools' folder) lists the Live version, the sample folders and the plugins, and changes nothing." };
    } },
  { name: "my_plugins", description: "The user's plugin guide: one line per plugin they own, saying what it is and what it's good for. Call it before you recommend a plugin or an effect for a job, so you recommend what the user has; find narrows it to the lines about one job or plugin (\"compressor\", \"reverb vocal\", \"Ozone\"). Live's own devices are always there too. If there is no guide yet, this returns the outline and how to write it. Save with text (the whole guide as Markdown): write each line from what you know about that plugin, mark it (unconfirmed) until the user has checked it, put plugins you don't know under \"Not sure what these are\", and save only when the user agrees. Saving keeps the previous version next to it. Works without Live.",
    inputSchema: obj({ text: { type: "string", description: "The whole plugin guide as Markdown, to save. Leave out to read" },
      find: { type: "string", description: "Words to look for, e.g. \"compressor\" or \"reverb vocal\". Returns only the matching lines" } }),
    run: (a) => {
      if (a.text !== undefined) return { saved: writePlugins(String(a.text)), note: "Saved." };
      const guide = readPlugins();
      if (!guide) return { guide: null, file: pluginsPath(), outline: PLUGIN_OUTLINE,
        note: "No plugin guide yet. Get the plugin names from the installer's --survey mode (install.ps1 or install.sh at the top of the tools' folder; it changes nothing). Write one line per plugin in the outline's shape, from what you know about that plugin: what it is, and two or three jobs it's good for. Mark every line (unconfirmed). Don't invent: a plugin you don't know goes under \"Not sure what these are\". Show the user the guide, fix what they correct, and save it with my_plugins text when they agree." };
      if (a.find === undefined) return { mcpContent: [{ type: "text", text: guide }] };
      const hits = findPlugins(guide, String(a.find));
      return { mcpContent: [{ type: "text", text: hits || `Nothing in the plugin guide matches "${String(a.find)}". Call my_plugins with no arguments to read all of it. Live's own devices may do the job.` }] };
    } },

  // --- 0.12.0 (needs the 0.11.0 Remote Script): select, import, convert, quantize without the screen ---
  { name: "live_select_clip", description: "Select a Session clip slot in Live, the way a click on it does: the track is selected, the slot highlighted, and the clip shown in Clip View (show: false leaves the views alone). Use it before a live_menu command that acts on the selected clip (Create > Separate Stems to New Audio Tracks, the Convert commands), so the command has a target; then live_menu Navigate > Session View before the command (Live 12.4.16 ignored Separate Stems after the select alone). For stems, live_separate_stems does all of it. Returns what Live says is selected afterwards. Changes only the selection and which view shows, never the set.",
    inputSchema: obj({ track: int("Track index, from 0"), slot: int("Slot index, from 0"),
      show: { type: "boolean", description: "Also show Session View and Clip View (default true)" } }, ["track", "slot"]),
    run: (a) => bridgeNew("live_select_clip", "select_clip", { track: a.track, slot: a.slot, show: a.show !== false }) },
  { name: "live_import_audio", description: "Put an audio file from disk into the set with no browser and no dragging: into an EMPTY Session slot of an audio track (slot), or onto an audio track's Arrangement at a bar (bar, from 1), never covering clips. The file is a full path, or its name or words from it (looked up in the sample folders). When the set has been saved, the file is first copied into the project's Samples\\Imported folder (never overwriting), so the set keeps it. A long file can take Live a while to read. Only when the user asks. Revertible with live_revert (the clip goes; the copied file stays in the project).",
    inputSchema: obj({ file: { type: "string", description: "Full path, or the file's name or words from it" },
      track: int("An audio track, from 0"), slot: int("An empty Session slot, from 0"),
      bar: { type: "number", description: "Or a bar on the Arrangement (from 1)" },
      copy: { type: "boolean", description: "Copy the file into the project first (default true; only possible once the set is saved)" } }, ["file", "track"]),
    run: async (a) => {
      if ((a.slot === undefined) === (a.bar === undefined)) throw new Error("Give slot (an empty Session slot) or bar (a place on the Arrangement), one of them.");
      const file = findAudioFile(String(a.file ?? ""));
      const ping = await bridge("ping") as { set_api?: ApiSet };
      if (!ping.set_api) await bridgeNew("live_import_audio", "import_audio", {}); // an old script answers "unknown action": say so
      const setPath = String(ping.set_api?.path ?? "");
      let use = file, copied = false, note: string;
      if (a.copy === false) note = "Not copied (copy: false): Live plays the file from where it is.";
      else if (!setPath) note = "The set has never been saved, so the file wasn't copied: Live plays it from where it is. After the user saves the set, File > Collect All and Save keeps a copy with the project.";
      else ({ use, copied, note } = copyIntoProject(file, setPath));
      const params: Record<string, unknown> = { path: use, track: a.track, ...(a.slot !== undefined ? { slot: a.slot } : { bar: a.bar }) };
      if (a.bar !== undefined) {
        const secs = wavSeconds(use);
        if (secs !== null) {
          const tempo = Number((await bridge("get_session") as { tempo?: number }).tempo) || 120;
          params.length_beats = Math.round((secs * tempo / 60 + 1) * 1000) / 1000;
        }
      }
      let out: Record<string, unknown>;
      try { out = await bridgeNew("live_import_audio", "import_audio", params, 125) as Record<string, unknown>; }
      catch (e) {
        if (copied) { try { fs.unlinkSync(use); } catch { /* leave it */ } }
        throw e;
      }
      return { ...out, file: { from: file, used: use, copied, note }, revert: "live_revert takes the clip out again." + (copied ? " The copied file stays in Samples\\Imported." : "") };
    } },
  { name: "live_convert_to_midi", description: "Live's Convert Harmony, Melody or Drums to New MIDI Track, on an audio clip, with no menus: Live works out the notes and puts them in a new MIDI track (with an instrument) next to it. kind: harmony (chords, from a pad or piano), melody (one note at a time: a voice, a bass, a lead), drums (kick, snare and hats, from a beat). The audio clip isn't changed. Live checks first that the clip can be converted. A long clip can take Live a while. Only when the user asks. Revertible with live_revert (it deletes the new track while nobody has changed it). Live's guess at the notes is a starting point: ask the user to listen.",
    inputSchema: obj({ ...CLIP_REF, kind: { type: "string", enum: ["harmony", "melody", "drums"] } }, ["track", "kind"]),
    run: (a) => bridgeNew("live_convert_to_midi", "convert_to_midi", { ...clipRef(a), kind: a.kind }, 125) },
  { name: "live_quantize_audio", description: "Quantize an audio clip, like Live's Quantize on an audio clip: Live moves its warp markers (the note starts) toward a grid, by an amount. The clip's Warp must be on. grid: 1/4, 1/8, 1/8t, 1/8+1/8t, 1/16, 1/16t, 1/16+1/16t, 1/32; amount: percent, 1-100 (100 = right on the grid; 50 = halfway, which keeps some feel). It changes the clip itself, so only when the user asks. Revertible with live_revert (it puts the old warp markers back). Ask the user to listen for stretched or squashed sounds.",
    inputSchema: obj({ ...CLIP_REF, grid: { type: "string", enum: GRIDS }, amount: { type: "number", description: "Percent, 1-100 (default 100)" } }, ["track", "grid"]),
    run: (a) => bridgeNew("live_quantize_audio", "quantize_audio", { ...clipRef(a), grid: a.grid, amount: a.amount ?? 100 }, 35) },
  { name: "live_probe", description: "Diagnostic (read-only): what this Live's Python API offers the newer tools: the descriptions (signatures) of create_audio_clip, the audio-to-MIDI conversion, Clip.quantize, undo steps and the message-box calls; the set's name and file; whether a message box is open; which Python modules the Live script can load. Changes nothing and presses nothing. For checking a new Live version or reporting a problem, not for music work.",
    inputSchema: obj({}), run: () => bridgeNew("live_probe", "probe") },

  // --- seeing Live ---
  { name: "live_screenshot", description: "Take a picture of Ableton Live's window so you can see what the user sees: the set, a device, a plugin window, Settings. Only Live's own windows, never the rest of the screen. Works when other windows cover Live, not when it's minimised. windows: \"all\" adds Live's open plugin and device windows. Changes nothing.",
    inputSchema: obj({ windows: { type: "string", enum: ["main", "all"], description: "main = Live's main window (default); all = also its open plugin/device windows" },
      max_width: int("Shrink to this width in pixels (400-3000, default 1600). Wider shows small text better but costs more.") }),
    run: async (a) => {
      const shots = await captureLive(a.windows === "all" ? "all" : "main", a.max_width ?? 1600);
      const note = shots.map((s, i) => `${i + 1}. ${s.title || "Live window"} (${s.width}×${s.height})`).join("\n");
      return { mcpContent: [{ type: "text", text: `Captured ${shots.length} Live window${shots.length > 1 ? "s" : ""}:\n${note}` },
        ...shots.map((s) => ({ type: "image", data: s.data, mimeType: "image/png" }))] };
    } },

  // --- Live's menu bar, without the screen (menu.ts) ---
  { name: "live_menu", description: "Fire one of Live's menu commands by name, e.g. \"View > Browser\" or \"Create > Separate Stems to New Audio Tracks\", with no screen control: Live can stay in the background, and the mouse, keys and clipboard aren't touched. Use only when the user asks for that command, and tell them what was fired. Only an allow-list fires: commands that open a dialog (nothing changes until the user confirms it there; press nothing in it yourself), change only the view, or (through live_save) save. New, Open, Close Window and Quit are always refused. An unknown path is refused with the close matches. On Windows, Live doesn't mark which commands are greyed out, so one that needs a selected clip or track is sent anyway and Live may just ignore it: check with live_screenshot. Windows; the Mac route is written but not yet tested.",
    inputSchema: obj({ path: { type: "string", description: "Menu path with > between levels, as Live shows it, e.g. \"View > Browser\"" } }, ["path"]),
    run: (a) => liveMenu(String(a.path ?? "")) },
  { name: "live_separate_stems", description: "Run Live's Stem Separation on a Session audio clip without taking over the screen (Windows, Live Suite 12.3 or later; the set must be saved, since the stems go in its project folder). Only when the user asks for stems. action start (the default): selects the clip, fires Create > Separate Stems to New Audio Tracks, ticks the stems asked for (vocals, drums, bass, others; default all four), sets quality (fast = High Speed, high = High Quality, the default) and merge (one track instead of a group; default off) in Live's Separate Stems window, presses Separate, and returns at once. It presses only Separate or Cancel, only in that window. It takes minutes (High Quality: about 9 minutes for a 2-minute song) and Live stops playback. action check: which stem files exist so far, and when done the new group track's index, which is exactly what song_analyze's stems input takes; it also reports if Live changed the set's tempo (it guesses one): tell the user and offer to set it back with live_set_tempo, never without asking. With no separation running, check lists the stem groups already in the set. action cancel: presses Cancel in Live's Separate Stems window while it's open. live_revert can't take a separation back: Live makes the tracks itself. Mac: refuses, with the by-hand steps.",
    inputSchema: obj({ action: { type: "string", enum: ["start", "check", "cancel"], description: "start (default), check or cancel" },
      track: int("start: the clip's track, from 0"), slot: int("start: the clip's Session slot, from 0"),
      bar: { type: "number", description: "Arrangement clips aren't supported yet (refused with the by-hand steps)" },
      stems: { type: "array", items: { type: "string", enum: ["vocals", "drums", "bass", "others"] }, description: "Which stems (default all four)" },
      quality: { type: "string", enum: ["fast", "high"], description: "fast = High Speed, high = High Quality (default)" },
      merge: { type: "boolean", description: "Merge the stems into one track (default false; song_analyze needs them separate)" } }),
    run: async (a) => {
      const action = a.action ?? "start";
      if (action === "check") return checkStems(bridge);
      if (action === "cancel") return cancelStems();
      return startStems(bridge, a);
    } },
  { name: "live_save", description: "Save the open set (File > Save Live Set), then check it landed: Live's title loses its *, the .als file's time changes, and Live shows no message box. Only for a set that already has a file; a new Untitled set needs Save As, which this refuses. Use when the user asks to save, and say it was saved. If it fails, it says so: ask the user to press Ctrl+S (Cmd+S on the Mac), or offer computer use.",
    inputSchema: obj({}), run: () => liveSave() },

  // --- theory: computed locally, no Live needed ---
  { name: "theory_key", description: `Everything about a key: its notes, the chords that fit (with roman numerals), common progressions, and which of a 25-key keyboard's keys are in it. Scales: ${SCALE_IDS.join(", ")}.`,
    inputSchema: obj({ root: { type: ["string", "integer"], description: "Root note, e.g. E or F#" }, scale: { type: "string", enum: SCALE_IDS } }, ["root", "scale"]),
    run: (a) => {
      const c = keyCard(rootPc(a.root), scaleId(a.scale));
      return {
        key: c.title, notes: c.notes, chords_from: c.chordsFrom,
        chords: c.chords.map((x) => ({ roman: x.roman, name: x.name, notes: x.notes })),
        progressions: c.progressions.map((p) => ({ name: p.name, feel: p.feel, chords: p.chords.map((x) => x.name) })),
        keys_in_scale: c.keyboard.map((k, i) => (k.inScale ? `${i}:${k.name}${k.root ? "(root)" : ""}` : null)).filter(Boolean),
      };
    } },
  { name: "theory_name_chord", description: "Name the chord in a set of MIDI notes and read it against a key: roman numeral, in the key or borrowed, and what usually comes next.",
    inputSchema: obj({ notes: { type: "array", items: { type: "integer" }, description: "MIDI note numbers" },
      root: { type: ["string", "integer"], description: "Key root" }, scale: { type: "string", enum: SCALE_IDS } }, ["notes", "root", "scale"]),
    run: (a) => nameChord(a.notes as number[], rootPc(a.root), scaleId(a.scale)) },
  { name: "theory_voice_chord", description: "Lay a chord out for a 25-key keyboard (root low, tones stacked above) and give MIDI notes to write into a clip, with the root doubled an octave down.",
    inputSchema: obj({ tones: { type: "array", items: { type: ["string", "integer"] }, description: "Chord tones, root first, as note names (E, G, B, D, F#) or pitch classes" } }, ["tones"]),
    run: (a) => {
      const pcs = (a.tones as unknown[]).map(rootPc);
      return { offsets_from_low_C: voicing(pcs), midi: chordMidi(pcs) };
    } },
];

// ---------- MCP (JSON-RPC 2.0): stdio by default, or HTTP on this computer only with --http ----------

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const byName = new Map(tools.map((t) => [t.name, t]));
type Send = (msg: unknown) => void;

async function handle(msg: any, send: Send) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications need no reply
  try {
    if (method === "initialize") {
      const want = params?.protocolVersion;
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "second-chair", version: VERSION },
        instructions: personalize("Controls the user's Ableton Live 12 set through the SecondChair Remote Script. Call live_status first; if its set has a warning (an empty Untitled set), tell the user and ask before changing anything. Tracks, slots and scenes are numbered from 0. Writes never overwrite clips. To take back a change these tools made, use live_revert (it only touches the bridge's own changes); live_undo is Live's global undo and can take back the user's edits. theory_* tools work without Live. Read the user's studio profile with my_studio once per session: it says who they are and what's in their studio. Before you recommend a plugin or an effect for a job, call my_plugins (find narrows it), so you recommend what the user owns; say when a line is unconfirmed. For how to work with them, read studio_guide (unless you have the second-chair skill). \"Show me <chord> (on the keys)\" means live_show_on_keys: it only lights Chord Coach's display, so call it straight away and don't write a clip. \"What am I playing\" means live_what_am_i_playing. To see Live (\"look at my set\", \"what's on screen\"), use live_screenshot. For a sound by description (\"a warm pad\"), call live_find_sound, show the user the numbered shortlist, and load their pick with live_load_sound; to try picks one by one on the keys, use live_audition. Change routing or sidechains (live_set_routing) only when the user asks. To chop a sample, live_load_sample puts an audio file or clip into Simpler (mode slice puts the slices on the pads). Delete a track (live_delete_track) only when the user asks for that track to go. Replace a pad's sample (live_swap_pad_sample) only when the user asks for that swap. Only write clips or change tempo, scale or tracks when the user asks for that, or while the user has switched on demo mode (see studio_guide). If a tool says Live or the token can't be reached, tell the user in one line; don't search the disk for installers."),
      } });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") {
      const who = profileName();
      const named = (x: unknown): unknown => typeof x === "string" ? personalize(x, who) : Array.isArray(x) ? x.map(named)
        : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "description" ? named(v) : typeof v === "object" ? named(v) : v])) : x;
      return send({ jsonrpc: "2.0", id, result: { tools: tools.map(({ name, description, inputSchema }) => named({ name, description, inputSchema })) } });
    }
    if (method === "tools/call") {
      const tool = byName.get(params?.name);
      if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      try {
        const out = await tool.run(params?.arguments ?? {});
        // a tool can hand back MCP content directly (images); everything else goes out as JSON text
        const content = (out as { mcpContent?: unknown[] } | null)?.mcpContent ?? [{ type: "text", text: JSON.stringify(out, null, 1) }];
        return send({ jsonrpc: "2.0", id, result: { content, isError: false } });
      } catch (e) {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: personalize((e as Error).message) }], isError: true } });
      }
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: (e as Error).message } });
  }
}

// HTTP door (MCP "Streamable HTTP", JSON answers only), for apps that can't start a local command, or whose runner
// for local commands fails (HeyClicky 1.1.5 on Windows). Start it with:  node server.ts --http [port]
// Safety: it listens on 127.0.0.1 only, every request needs the bridge token ("Authorization: Bearer <token>" or
// "X-SecondChair-Token"), and requests sent by a web page (an Origin that isn't this computer) are refused.
const httpAt = process.argv.indexOf("--http");
if (httpAt >= 0 || process.env.SECOND_CHAIR_HTTP_PORT) {
  const port = Number((httpAt >= 0 && /^\d+$/.test(process.argv[httpAt + 1] ?? "") ? process.argv[httpAt + 1] : process.env.SECOND_CHAIR_HTTP_PORT) || 9887);
  const local = (h: string) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h);
  const server = http.createServer((req, res) => {
    const reply = (code: number, body?: unknown) => {
      res.writeHead(code, body === undefined ? {} : { "Content-Type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const origin = req.headers.origin;
    if (!local(String(req.headers.host ?? "")) || (origin && !local(origin.replace(/^https?:\/\//i, "")))) return reply(403, { error: "this door only opens from this computer" });
    let token: string;
    try { token = readToken(); } catch (e) { return reply(500, { error: (e as Error).message }); }
    const given = String(req.headers["x-secondchair-token"] ?? "") || String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return reply(401, { error: "send the bridge token as 'Authorization: Bearer <token>'" });
    if (req.method === "DELETE") return reply(200, {});
    if (req.method !== "POST") return reply(405, { error: "POST JSON-RPC messages here" });
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => { body += c; if (body.length > 4_000_000) req.destroy(); });
    req.on("end", async () => {
      let msg: any;
      try { msg = JSON.parse(body); } catch { return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
      const list = Array.isArray(msg) ? msg : [msg];
      const answers: unknown[] = [];
      await Promise.all(list.map((m) => handle(m, (a) => answers.push(a))));
      if (!answers.length) return reply(202); // only notifications
      reply(200, Array.isArray(msg) ? answers : answers[0]);
    });
  });
  server.listen(port, "127.0.0.1", () => console.error(`second-chair ${VERSION}: MCP over HTTP at http://127.0.0.1:${port}/mcp (this computer only; needs the bridge token)`));
} else {
  const send: Send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
      void handle(msg, send);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
