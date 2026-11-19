// Tool profiles and tool marks (0.16.0).
// Every tool gets MCP annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) from its kind below, so
// clients like LM Studio know which calls only read and which can change or delete things.
// SECOND_CHAIR_TOOLS=offline lists only a small set of tools that read, play or show (no changes to the set), plus
// hand_to_stronger_model, and the server refuses every other call. That is the strongest guard for a small local model:
// a tool it can't see, it can't misuse. Unset (or "all") is everything, as before.
// Background: Brain inbox/music-studio/offline-mode-research.md (2026-11-18). The goal Cello picked for offline mode is
// working with no internet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** read: changes nothing. play: changes only what's playing or shown, nothing saved in the set. edit: changes the set,
 *  but only adds or adjusts (revertible with live_revert, or a new file). risky: can delete, replace, or reach past
 *  the bridge's own undo (global undo, saving, Live's menus and dialogs). */
export type Kind = "read" | "play" | "edit" | "risky";
export const KIND: Record<string, Kind> = {
  // read
  live_status: "read", live_get_track: "read", live_get_clip_notes: "read", live_get_arrangement: "read", live_get_levels: "read",
  live_listen: "read", live_read_knob: "read", live_get_device: "read", live_get_routing: "read", live_browse: "read",
  live_find_sound: "read", live_get_simpler: "read", audio_analyze: "read", song_analyze: "read", live_audio_clip_info: "read",
  live_what_am_i_playing: "read", studio_guide: "read", live_probe: "read", live_screenshot: "read",
  theory_key: "read", theory_name_chord: "read", theory_voice_chord: "read", hand_to_stronger_model: "read",
  // my_studio and my_plugins read by default; with text they save the user's own profile file (not the set)
  my_studio: "edit", my_plugins: "edit",
  // play
  live_transport: "play", live_fire_clip: "play", live_fire_scene: "play", live_stop_track: "play", live_play_bars: "play",
  live_select_track: "play", live_select_clip: "play", live_show_on_keys: "play",
  // edit
  live_write_clip: "edit", live_add_notes: "edit", live_create_midi_track: "edit", live_create_audio_track: "edit",
  live_create_return_track: "edit", live_set_monitoring: "edit", live_set_tempo: "edit", live_set_scale: "edit",
  live_place_clip: "edit", live_duplicate_track: "edit", live_rename: "edit", live_automate: "edit", live_move_device: "edit",
  live_copy_clip: "edit", live_record_automation: "edit", live_bounce_track: "edit", live_arm_track: "edit",
  live_mute_track: "edit", live_create_scene: "edit", live_set_device_param: "edit", live_load_device: "edit",
  live_build_drum_kit: "edit", live_load_sound: "edit", live_audition: "edit", live_load_sample: "edit", live_set_simpler: "edit",
  live_set_audio_clip: "edit", live_align_audio: "edit", live_revert: "edit", live_import_audio: "edit",
  live_convert_to_midi: "edit", live_quantize_audio: "edit",
  // risky
  live_delete_device: "risky", live_delete_clip: "risky", live_arrangement_clip: "risky", live_undo: "risky",
  live_set_routing: "risky", live_delete_track: "risky", live_swap_pad_sample: "risky", live_menu: "risky",
  live_separate_stems: "risky", live_save: "risky", live_export: "risky", live_file_dialog: "risky",
};

/** MCP tool annotations from a tool's kind. A tool missing from KIND is treated as risky (a new tool must be sorted). */
export function annotations(name: string) {
  const k = KIND[name] ?? "risky";
  return {
    readOnlyHint: k === "read",
    destructiveHint: k === "risky",
    idempotentHint: k === "read",
    openWorldHint: false,
  };
}

// ---------- the offline profile ----------

/** The tools a small local model sees with SECOND_CHAIR_TOOLS=offline: theory, looking and listening, playing, finding a
 *  sound, the user's own profile (read only), and handing a request on. Nothing that changes the set. */
export const OFFLINE_TOOLS = [
  "theory_key", "theory_name_chord", "theory_voice_chord", "live_show_on_keys",
  "live_status", "live_get_track", "live_get_clip_notes", "live_get_arrangement", "live_get_levels", "live_listen",
  "live_what_am_i_playing", "live_get_device", "live_read_knob", "live_audio_clip_info", "audio_analyze", "song_analyze",
  "live_find_sound", "live_browse", "my_studio", "my_plugins", "studio_guide",
  "live_transport", "live_fire_clip", "live_fire_scene", "live_stop_track",
  "hand_to_stronger_model",
];
/** One-line descriptions for the offline profile: a small model reads the whole tool list on every request, and long
 *  descriptions make it pick worse (offline-mode research, section 1). The full descriptions stay for the full profile. */
export const SHORT: Record<string, string> = {
  theory_key: "The notes and chords of a key (root like E or F#, and a scale).",
  theory_name_chord: "Name the chord made by some notes, in a key. Give the note names low to high (C, E, G, Bb), and the key's root and scale.",
  theory_voice_chord: "How to play a chord on a 25-key keyboard (which keys).",
  live_show_on_keys: "Light a chord on Chord Coach's keyboard in Live, so the user sees where to put their fingers. Give chord, like Dm7.",
  live_status: "The open set: tempo, playing or not, tracks with their index, devices and clips. Call this first.",
  live_get_track: "One track's clip slots and devices. track counts from 0.",
  live_get_clip_notes: "The notes in a Session clip (track, slot).",
  live_get_arrangement: "The clips on the Arrangement timeline, by track and bar.",
  live_get_levels: "How loud each track is right now, in dB, from Live's meters.",
  live_listen: "Loudness and where the energy sits on a track, if the Second Chair Ears device is on it.",
  live_what_am_i_playing: "The notes and chord the user is playing on their keyboard right now.",
  live_get_device: "A device's knobs and their values on a track.",
  live_read_knob: "One knob's value, watched for a moment.",
  live_audio_clip_info: "An audio clip's file, length, warp and tempo.",
  audio_analyze: "Loudness (LUFS), peaks and tone of a WAV file.",
  song_analyze: "Key, tempo and chords of a song from a WAV file.",
  live_find_sound: "Find sounds in Live's browser from a description, like a warm pad. Shows a numbered list; loads nothing. Not a way to load or build: hand those on.",
  live_browse: "Search or list Live's browser by name. Read only: not a way to load or build anything.",
  my_studio: "The user's studio profile (name, gear, how they like to learn). Read only here.",
  my_plugins: "The user's plugins and what each is good for. find narrows it. Read only here.",
  studio_guide: "This guide: what offline mode can do and when to hand on.",
  live_transport: "Play or stop Live, stop all clips, or jump to a bar. Never record.",
  live_fire_clip: "Start a Session clip by its track and slot (live_status lists each track's clips and slots).",
  live_fire_scene: "Start a scene (a row of Session clips) by index.",
  live_stop_track: "Stop the clips playing on one track.",
  hand_to_stronger_model: "Call this FIRST for any request to change, add, load, delete, record, mix, save or build anything, or for mix advice or the screen: offline mode can't do those. It saves the request for when the user is online.",
};
/** A schema with its argument descriptions cut to the first sentence, for the offline profile. */
export function shortSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(shortSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema as Record<string, unknown>).map(([k, v]) =>
    [k, k === "description" && typeof v === "string" ? v.replace(/^(.{0,110}?(?<!\be\.g|\bi\.e)[.;])\s.*$/s, "$1").slice(0, 130).replace(/\s*[:(]\s*$/, "") : shortSchema(v)]));
}

/** Arguments the offline profile refuses even on its own tools: saving the user's files, and recording. */
const OFFLINE_ARG_RULES: Record<string, (a: Record<string, unknown>) => string | null> = {
  my_studio: (a) => a.text !== undefined ? "Offline mode only reads the studio profile; saving it needs the full Second Chair." : null,
  my_plugins: (a) => a.text !== undefined ? "Offline mode only reads the plugin guide; saving it needs the full Second Chair." : null,
  live_transport: (a) => /^record_/.test(String(a.action ?? "")) ? "Offline mode doesn't start or stop recording; that changes the set. Ask the user to press Record in Live, or hand it on." : null,
};

export type Profile = "all" | "offline";
export function profile(): Profile {
  const p = String(process.env.SECOND_CHAIR_TOOLS ?? "all").trim().toLowerCase();
  if (p === "offline") return "offline";
  if (p && p !== "all") process.stderr.write(`second-chair: unknown SECOND_CHAIR_TOOLS "${p}"; using all tools\n`);
  return "all";
}
export const listed = (name: string, p: Profile = profile()) => p === "all" ? name !== "hand_to_stronger_model" : OFFLINE_TOOLS.includes(name);

/** Why a call is refused in this profile, or null. Also catches what small models get wrong: unknown argument names,
 *  and leaving out required ones (an empty {} is a known Qwen chat-template bug). */
export function refusal(name: string, args: Record<string, unknown>, schema: { properties?: Record<string, unknown>; required?: string[] }, p: Profile = profile()): string | null {
  if (p === "all") return null;
  if (!OFFLINE_TOOLS.includes(name)) {
    return `${name} isn't available in offline mode: offline mode only reads, plays and shows, and never changes the set. Nothing was done. Call hand_to_stronger_model with the user's request, so it's saved for the full Second Chair.`;
  }
  const known = Object.keys(schema.properties ?? {});
  const extra = Object.keys(args ?? {}).filter((k) => !known.includes(k));
  if (extra.length) return `${name} has no argument ${extra.map((x) => `"${x}"`).join(", ")}. Its arguments are: ${known.join(", ") || "none"}. Nothing was done.`;
  const missing = (schema.required ?? []).filter((k) => (args ?? {})[k] === undefined);
  if (missing.length) return `${name} needs ${missing.map((x) => `"${x}"`).join(", ")}. Nothing was done.`;
  return OFFLINE_ARG_RULES[name]?.(args ?? {}) ?? null;
}

// ---------- hand_to_stronger_model ----------

const stateDir = () => process.env.SECOND_CHAIR_STATE_DIR || path.join(os.homedir(), "SecondChair");
export const HAND_ON_DESCRIPTION = "Hand a request on to the full Second Chair (a stronger model) because offline mode can't or shouldn't do it: anything that changes the set (writing clips, loading or deleting, tempo, mixing changes, recording), building something in several steps, mix or mastering advice, looking at the screen, or anything you aren't sure about. With no internet it can't reach the stronger model now, so it saves the request for later and tells you what to say to the user. Give request (the user's words) and reason (one short line).";
export const HAND_ON_SCHEMA = { type: "object", additionalProperties: false, required: ["request", "reason"],
  properties: { request: { type: "string", description: "The user's request, in their words" }, reason: { type: "string", description: "Why offline mode can't do it, in one short line" } } };
export function handOn(a: { request?: unknown; reason?: unknown }) {
  const request = String(a.request ?? "").trim(), reason = String(a.reason ?? "").trim();
  if (!request) throw new Error("Give request: the user's words.");
  const file = path.join(stateDir(), "handed-on.jsonl");
  let saved: string | null = file;
  try { fs.mkdirSync(stateDir(), { recursive: true }); fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), request, reason }) + "\n"); }
  catch { saved = null; }
  return { handed_on: true, request, reason, saved_to: saved,
    say: `Tell the user, in one or two short sentences: this needs the full Second Chair, which isn't available offline${reason ? ` (${reason})` : ""}. Their request is saved, so it can be picked up when they're back online. Then offer what offline mode can do instead, if anything fits (theory, looking at the set, levels, playing, finding a sound).` };
}

// ---------- the word rule ----------

/** Words that mean a request would change the set, or needs the full model (offline-mode research, section 3, step 1:
 *  "a word rule runs first, no model"). A client (the in-Live chat panel later, or the benchmark with --word-rule)
 *  sends a match straight to hand_to_stronger_model, without asking the local model. Kept narrow on purpose: a miss
 *  only means the local model decides, and it can't change the set anyway. */
const CHANGE_WORDS: RegExp[] = [
  /\b(load|add|insert|put|place|write|create|make (a|an|me|some|new)\b|delete|remove|erase|clear the (set|track|clip))/i,
  /\b(mute|unmute|solo|arm|disarm|rename|duplicate|quantize|bounce|freeze|consolidate|sidechain|route|automate|record)\b/i,
  /\b(set|change) (the |my )?((set|song)'s )?(tempo|bpm|scale|key|volume|level|send)\b|\bset .* to \d/i,
  /\bturn (it |the |my )?.*\b(up|down)\b|\b(raise|lower|boost|cut) (the )?\w+/i,
  /\b(mix|master|mastering|eq|compress|save|export|undo|redo)\b/i,
  /\b(build|set up|chain)\b/i,
  /\blook at (my|the) (set|screen)|\bscreenshot\b/i,
];
/** The reason a request goes straight to the stronger model, or null to let the local model answer. */
export function wordRule(text: string): string | null {
  const t = String(text ?? "");
  for (const re of CHANGE_WORDS) { const m = re.exec(t); if (m) return `"${m[0].trim()}" needs the full Second Chair`; }
  return null;
}

// ---------- the short guide ----------

export const OFFLINE_GUIDE = `# Second Chair, offline mode

You run on the user's own computer, with no internet. You help a producer inside Ableton Live.

## The first rule
If the user asks you to change, add, load, delete, record, mix, save or build anything, call hand_to_stronger_model straight away, as your first step. Don't search the browser or read the set first to try to do it some other way: you can't, offline. Then say what the tool told you to say.
If you can't do something, never just say "I can't": hand it on, so it's saved.

## How to talk
- Plain, short sentences. One step at a time.
- The user is colorblind: never point at things by colour alone; use names, numbers and positions.
- You can't hear the audio. Mark guesses as guesses.
- You are a mentor, not a ghostwriter: the user owns the ideas. Offer options; the user decides by ear.

## What you can do offline
- Theory: keys, chord names, chord shapes (theory_key, theory_name_chord, theory_voice_chord); show a chord on Chord Coach's keyboard (live_show_on_keys).
- Look and listen: the set (live_status first; tracks, slots and scenes count from 0), a track, a clip's notes, the Arrangement, levels (live_get_levels, live_listen), what the user is playing, a device's knobs.
- Measure a WAV: audio_analyze (loudness), song_analyze (key, tempo, chords).
- Play: start or stop the transport, fire a clip or a scene, stop a track. Never record.
- Find a sound by description (live_find_sound) and show the numbered list. Loading it needs the full Second Chair.
- The user's own studio and plugins (my_studio, my_plugins), read only.

## What you hand on
Call hand_to_stronger_model with the user's words when they ask for anything that changes the set (write or edit clips, load, delete, tempo, mixing changes, routing, saving, exporting), a build in several steps, mix or mastering advice, or a look at the screen. Also when you're not sure. Then say what it told you to say.

## Rules
- One tool at a time. Use exact argument names; never send empty arguments.
- If a tool says something isn't possible, don't try the same call again: explain, or hand it on.
- Keep answers short: the facts, then one next step.
`;
