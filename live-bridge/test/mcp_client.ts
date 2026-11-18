// Drives the second-chair MCP server over stdio like Claude or HeyClicky would, and prints each result.
import { spawn } from "node:child_process";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import { synthLoop, synthStems, writeWav16 } from "./song_loop.ts";

// Live's tags come from a small stand-in tag file, so results don't depend on which packs are installed.
const STUDIO_FILE = path.join(os.tmpdir(), `second-chair-studio-test-${process.pid}.md`);
// live_menu / live_save read a stand-in menu, log and project folder, never the real Live that may be open alongside.
const MENU_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "second-chair-menu-test-"));
Object.assign(process.env, { SECOND_CHAIR_LIVE_MENU: path.join(MENU_DIR, "menu.json"), SECOND_CHAIR_LIVE_LOG: path.join(MENU_DIR, "Log.txt"),
  SECOND_CHAIR_PROJECT_DIRS: MENU_DIR, SECOND_CHAIR_SAVE_WAIT_MS: "1500", SECOND_CHAIR_STEMS_UIA: path.join(MENU_DIR, "stems-window.json"),
  SECOND_CHAIR_FILE_DIALOG: path.join(MENU_DIR, "picker.json"), SECOND_CHAIR_FILE_WAIT_MS: "800", SECOND_CHAIR_FILE_OPEN_MS: "1500",
  SECOND_CHAIR_LIVE_WINDOW: path.join(MENU_DIR, "export-window.json"), SECOND_CHAIR_EXPORT_OPEN_MS: "1500", SECOND_CHAIR_EXPORT_PICKER_MS: "1500", SECOND_CHAIR_EXPORT_WAIT_MS: "800" });
const server = spawn(process.execPath, [path.join(import.meta.dirname, "..", "mcp", "server.ts")], { stdio: ["pipe", "pipe", "inherit"],
  // Saved pad swaps go to a fresh temp folder, never the user's real ~/SecondChair/pad-swaps.jsonl.
  env: { ...process.env, SECOND_CHAIR_STUDIO_FILE: STUDIO_FILE, SECOND_CHAIR_PLUGINS_FILE: STUDIO_FILE.replace(/\.md$/, "-plugins.md"), SECOND_CHAIR_SAMPLE_DIRS: os.tmpdir(), SECOND_CHAIR_LIVE_TITLE: "my-song* - Ableton Live 12 Suite", SECOND_CHAIR_ABLETON_LIBRARIES: path.join(import.meta.dirname, "fixtures"),
    SECOND_CHAIR_STATE_DIR: path.join(os.tmpdir(), `second-chair-test-${process.pid}`) } });
let buf = ""; const waiting = new Map<number, (m: any) => void>();
server.stdout.on("data", (c) => {
  buf += c; let nl;
  while ((nl = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1); waiting.get(m.id)?.(m); }
});
let id = 0;
const rpc = (method: string, params?: unknown) => new Promise<any>((res) => { const i = ++id; waiting.set(i, res); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
const call = async (name: string, args: unknown = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
  console.log(`\n# ${name} ${r.result?.isError ? "(ERROR)" : ""}\n${text.length > 600 ? text.slice(0, 600) + " …" : text}`);
  return r;
};

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
console.log("initialize ->", init.result.serverInfo, init.result.protocolVersion);
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const list = await rpc("tools/list");
console.log("tools:", list.result.tools.map((t: any) => t.name).join(", "));

await call("theory_key", { root: "E", scale: "dorian" });
await call("theory_name_chord", { notes: [52, 55, 59, 62, 66], root: "E", scale: "dorian" });
await call("theory_voice_chord", { tones: ["A", "C#", "E", "G"] });
const status = await call("live_status");
// The write tests below change the set (tempo, scale, a clip, a track, transport) and undo only once.
// Run them against fake_live.py only, unless someone passes --real on purpose.
if (!/"live": "0\.0\.0"/.test(status.result?.content?.[0]?.text ?? "") && !process.argv.includes("--real")) {
  console.log("\nStopped: this is real Live, not fake_live.py. The write tests would change the user's set. Pass --real to run them anyway.");
  server.stdin.end();
  process.exit(1);
}
await call("live_set_tempo", { bpm: 170 });
await call("live_set_scale", { root: "E", name: "Dorian" });
await call("live_write_clip", { track: 0, slot: 0, length_beats: 8, name: "Em9 to A13", notes: [
  { pitch: 52, start: 0, duration: 4 }, { pitch: 55, start: 0, duration: 4 }, { pitch: 59, start: 0, duration: 4 },
  { pitch: 57, start: 4, duration: 4 }, { pitch: 61, start: 4, duration: 4 }, { pitch: 66, start: 4, duration: 4 }] });
await call("live_get_clip_notes", { track: 0, slot: 0 });
await call("live_write_clip", { track: 0, slot: 0, length_beats: 4, notes: [{ pitch: 60, start: 0, duration: 1 }] }); // must refuse: slot full
await call("live_write_clip", { track: 1, slot: 0, length_beats: 4, notes: [{ pitch: 60, start: 0, duration: 1 }] }); // must refuse: audio track
await call("live_write_clip", { track: 0, slot: 1, length_beats: 4, notes: [{ pitch: 200, start: 0, duration: 1 }] }); // must refuse: pitch
await call("live_get_track", { track: 9 }); // must refuse: no such track
await call("live_create_midi_track", { name: "Vital pad" });
await call("live_transport", { action: "play" });
// Chord Coach: fake_live.py's stand-in device holds Em9 (E2 G B D F#) from about 2 s in, plus a quick B note
await call("live_show_on_keys", { chord: "Dm7" });
await call("live_show_on_keys", { chord: "G/B", label: "G over B" });
await call("live_show_on_keys", { chord: "F sharp minor" });
await call("live_show_on_keys", { chord: "H7" }); // must refuse: not a chord
await call("live_what_am_i_playing", { root: "E", scale: "dorian" });
await call("live_what_am_i_playing"); // key from Live's Scale (set to E Dorian above)
await call("live_show_on_keys", { clear: true });

// Browser: find and load devices, build a finger-drum kit. Each line says whether it must work or be refused.
let failed = 0;
const expect = async (want: "ok" | "refused", name: string, args: unknown, mustSay = "") => {
  const r = await call(name, args);
  const text: string = r.result?.content?.[0]?.text ?? "";
  const ok = r.result && !r.result.isError;
  if ((want === "ok") !== ok || (mustSay && !text.includes(mustSay))) { failed++; console.log(`!! expected ${want}${mustSay ? ` with "${mustSay}"` : ""}`); }
  return text;
};
await expect("ok", "live_browse", { tree: "audio_effects", query: "drum buss" }, "Drum Buss");
await expect("ok", "live_browse", { tree: "places" }, "Samples");
const listing = await expect("ok", "live_browse", { tree: "places", path: "Samples/Fluffy Kit - finger drums" }, "1 kick.wav");
if (listing.includes(".asd")) { failed++; console.log("!! .asd files should be hidden"); }
await expect("refused", "live_browse", { tree: "nowhere" });
await expect("ok", "studio_guide", { section: "safety" }, "pad-swaps.jsonl");                 // the second-chair skill, for HeyClicky
await expect("refused", "studio_guide", { section: "nope" }, "Sections:");
await expect("ok", "live_load_device", { track: 1, name: "Drum Buss" }, "Drum Buss");                // audio effect on the bass track
await expect("ok", "live_load_device", { track: 1, path: "Reverb/Hall/Large Hall" }, "Large Hall");
// device settings, on the two effects just loaded onto track 1 (Drum Buss = device 0, Large Hall = device 1)
await expect("ok", "live_get_device", { track: 1, device: "Drum Buss" }, "Drive");
await expect("ok", "live_set_device_param", { track: 1, device: "drum buss", param: "Drive", text: "35 %" }, "\"now\": \"35 %\"");
await expect("ok", "live_set_device_param", { track: 1, device: 0, param: "drive", percent: 50 }, "\"now\": \"50 %\"");
await expect("ok", "live_set_device_param", { track: 1, device: "Drum Buss", param: "Boom", text: "1.2 kHz" }, "1.20 kHz");
await expect("ok", "live_set_device_param", { track: 1, device: "Drum Buss", param: "Type", text: "hard" }, "\"now\": \"Hard\"");
await expect("refused", "live_set_device_param", { track: 1, device: "Drum Buss", param: "Type", text: "Spicy" }, "can be");
await expect("refused", "live_set_device_param", { track: 1, device: "Drum Buss", param: "Locked Knob", percent: 10 }, "locked");
await expect("refused", "live_set_device_param", { track: 1, device: "Drum Buss", param: "d", percent: 10 }, "more than one");
await expect("refused", "live_set_device_param", { track: 1, device: "Drum Buss", param: "Drive", percent: 10, text: "5 %" });
await expect("refused", "live_set_device_param", { track: 1, device: "Drum Buss", param: "Drive", value: 7 }, "values from");
await expect("ok", "live_set_device_param", { track: 1, device: "Large Hall", param: "Decay", text: "2 s" }, "\"now\": \"2.00 s\"");
await expect("ok", "live_set_device_param", { track: 1, device: "Large Hall", param: "Decay", text: "500 ms" }, "\"now\": \"500 ms\"");
await expect("ok", "live_set_device_param", { track: 1, device: "mixer", param: "Volume", text: "-6 dB" }, "\"now\": \"-6.0 dB\"");
await expect("ok", "live_set_device_param", { track: 1, device: "mixer", param: "Pan", value: 0.4 }, "\"now\": \"20R\"");
await expect("ok", "live_get_device", { track: 1, device: "mixer" }, "Send A");
await expect("refused", "live_get_device", { track: 1, device: "Glue" }, "no device called");
await expect("refused", "live_get_device", { track: 1, device: 5 }, "doesn't exist");
await expect("refused", "live_load_device", { track: 1, name: "Operator" }, "audio track");          // instrument on an audio track
await expect("refused", "live_load_device", { track: 0, name: "Operator" }, "already has an instrument");
await expect("refused", "live_load_device", { track: 0, name: "No Such Device" }, "couldn't find");
await expect("refused", "live_load_device", { track: 0 });
await expect("refused", "live_build_drum_kit", { track: 2, folder: "Not In Places" }, "Add Folder");
await expect("refused", "live_build_drum_kit", { track: 1, folder: "Fluffy Kit - finger drums" }, "audio track");
await expect("refused", "live_build_drum_kit", { track: 0, folder: "Fluffy Kit - finger drums" }, "already has an instrument");
const kit = await expect("ok", "live_build_drum_kit", { track: 2, folder: "C:\\Users\\sam\\Documents\\Samples\\Fluffy Kit - finger drums",
  volumes_db: [0, -2, -8, -6], name: "Finger drums" }, "\"note_name\": \"G1\"");
for (const s of ["1 kick.wav", "8 ride.wav", "\"choke_group\": 1", "-8.0 dB"]) if (!kit.includes(s)) { failed++; console.log(`!! kit result is missing ${s}`); }
await expect("refused", "live_build_drum_kit", { track: 2, folder: "Fluffy Kit - finger drums" }, "already has an instrument"); // no second kit
await expect("ok", "live_get_track", { track: 2 }, "Drum Rack");
// Swapping one pad's sample, on the kit just built on track 2 (pad 2 = "2 snare", pads 3 and 4 are hats)
await expect("refused", "live_swap_pad_sample", { track: 0, pad: 2, sample: "Samples/Extra hits/Crunchy Snare.wav" }, "no Drum Rack");
await expect("refused", "live_swap_pad_sample", { track: 2, pad: 9, sample: "Samples/Extra hits/Crunchy Snare.wav" }, "is empty");
await expect("refused", "live_swap_pad_sample", { track: 2, pad: "hat", sample: "Samples/Extra hits/Crunchy Snare.wav" }, "more than one pad");
await expect("refused", "live_swap_pad_sample", { track: 2, pad: "snare", sample: "Samples/Nope.wav" }, "couldn't find the sample");
await expect("refused", "live_swap_pad_sample", { track: 2, pad: "C#1", sample: "Samples/Fluffy Kit - finger drums/2 snare.wav" }, "already plays");
await expect("refused", "live_swap_pad_sample", { track: 2, pad: 2 }, "Give the pad");
await expect("refused", "live_swap_pad_sample", { track: 2, pad: 2, restore: true }, "No saved swap");
const swap = await expect("ok", "live_swap_pad_sample", { track: 2, pad: "snare", sample: "Samples/Extra hits/Crunchy Snare.wav" }, "\"note_name\": \"C#1\"");
for (const s of ["\"sample\": \"2 snare\"", "Crunchy Snare", "Simpler settings, volume and choke group", "restore: true"]) if (!swap.includes(s)) { failed++; console.log(`!! swap result is missing ${s}`); }
// a disk path works too, and the hat's choke group stays
const hat = await expect("ok", "live_swap_pad_sample", { track: 2, pad: 3, sample: "C:\\Users\\sam\\Documents\\Samples\\Extra hits\\Crunchy Snare.wav" }, "Crunchy Snare");
if (!hat.includes("3 closed hat")) { failed++; console.log("!! the hat swap should report the old closed hat"); }
await expect("ok", "live_swap_pad_sample", { track: 2, pad: "C#1", restore: true }, "put back 2 snare");
await expect("ok", "live_swap_pad_sample", { track: 2, restore: true }, "put back 3 closed hat");   // no pad: the last open swap
await expect("refused", "live_swap_pad_sample", { track: 2, restore: true }, "No saved swap");     // both are back now
// Sounds by description: a ranked shortlist (read-only), then loading the pick onto an empty MIDI track.
const pick1 = (text: string) => { try { return JSON.parse(text).shortlist[0]?.name; } catch { return undefined; } };
const want1 = async (description: string, name: string, mustSay = "") => {
  const text = await expect("ok", "live_find_sound", { description }, mustSay);
  if (pick1(text) !== name) { failed++; console.log(`!! "${description}" should rank ${name} first, got ${pick1(text)}`); }
};
await want1("a warm pad", "Warm Analog Pad", "Live tags it Analog");
await want1("a dusty Rhodes", "E-Piano Rusty", "Lofi & Vinyl");
await want1("a punchy 808 bass", "808 Drifter", "808 Bass");
await expect("ok", "live_find_sound", { description: "airy pad" }, "made for MPE controllers");   // MPE sounds are marked (and ranked a bit lower)
const mpe = await expect("ok", "live_find_sound", { description: "soft MPE pad" });               // ...unless the user asks for MPE
if (pick1(mpe) !== "MPE Airy Pad" || mpe.includes("made for MPE")) { failed++; console.log("!! asking for MPE should rank MPE Airy Pad first, unmarked"); }
await expect("ok", "live_find_sound", { description: "zzz qqq" }, "Nothing matched");
await expect("refused", "live_find_sound", { description: "pad", trees: ["nowhere"] }, "Unknown tree");
await expect("refused", "live_load_sound", { path: "Pad/Warm Analog Pad.adg" }, "either track");
await expect("refused", "live_load_sound", { path: "Pad/Warm Analog Pad.adg", track: 0 }, "already has an instrument");
await expect("refused", "live_load_sound", { path: "Pad/Warm Analog Pad.adg", track: 1 }, "audio track");
await expect("refused", "live_load_sound", { path: "Pad/No Such Pad.adg", track: 0, new_track: true }, "either track");
const snd = await expect("ok", "live_load_sound", { path: "Pad/Noisy Pad.adv", new_track: true, arm: true }, "\"loaded\": \"Pad/Noisy Pad.adv\"");
for (const s of ["\"armed\": true", "\"name\": \"Noisy Pad\"", "\"undo_steps\": 4"]) if (!snd.includes(s)) { failed++; console.log(`!! sound load result is missing ${s}`); }
await expect("refused", "live_load_sound", { path: "Pad/Warm Analog Pad.adg", track: 3 }, "already has an instrument"); // never a second instrument
await expect("ok", "live_get_track", { track: 3 }, "Noisy Pad");
await expect("ok", "live_undo", { steps: 2 }, "\"steps\": 2");
// Plugin knobs (bridge 0.6.0): a VST3 knob only shows its current setting, so text is refused; percent works and "now" is re-read.
await expect("ok", "live_load_device", { track: 1, name: "Kickstart 2", tree: "plugins" }, "Kickstart 2");
await expect("refused", "live_set_device_param", { track: 1, device: "Kickstart 2", param: "LowCut", text: "250 Hz" }, "only shows its current setting");
await expect("ok", "live_set_device_param", { track: 1, device: "Kickstart 2", param: "LowCut", percent: 12 }, "\"now\": \"249 Hz\"");
// Routing (bridge 0.6.0): a plugin's sidechain is out of the API's reach (0.8.2 says so), Compressor's own sidechain
// from one Drum Rack chain, a track's input.
await expect("refused", "live_get_routing", { track: 1, device: "Kickstart 2" }, "set by hand");
await expect("refused", "live_set_routing", { track: 1, device: "Kickstart 2", source: "drums" }, "set by hand");
await expect("ok", "live_load_device", { track: 1, name: "Compressor" }, "Compressor");
const sc = await expect("ok", "live_set_routing", { track: 1, device: "Compressor", source: "finger drums", channel: "1 kick" }, "1 kick");
if (!sc.includes("\"undo_steps\": 2") || !sc.includes("Finger drums")) { failed++; console.log("!! sidechain result should name the drums track and use 2 undo steps"); }
await expect("refused", "live_set_routing", { track: 1, device: "Compressor", source: "Nowhere" }, "no source called");
await expect("refused", "live_set_routing", { track: 1, device: "Compressor", source: "drums", channel: "hat" }, "more than one channel");
await expect("ok", "live_set_routing", { track: 1, device: "Compressor", source: "keys" }, "\"io\": \"sidechain\"");
await expect("refused", "live_get_routing", { track: 1, device: "Drum Buss" }, "no input that can be routed");
await expect("refused", "live_set_routing", { track: 1, device: "mixer", source: "keys" }, "mixer has no routing");
await expect("ok", "live_get_routing", { track: 1 }, "Ext. In");
await expect("ok", "live_set_routing", { track: 1, io: "input", source: "Ext. In", channel: "2" }, "\"channel\": \"2\"");
await expect("refused", "live_set_routing", { track: 1, source: "Ext. In" }, "say io");
await expect("refused", "live_set_routing", { track: 1, io: "input" }, "source and/or channel");
// Audition (0.6.0): step through a shortlist on one track, replacing only the sound the audition loaded.
await expect("refused", "live_audition", { step: "next" }, "No audition is running");
await expect("refused", "live_audition", { step: "start", description: "pad", track: 0 }, "already has an instrument");
const au = await expect("ok", "live_audition", { step: "start", description: "pad", new_track: true }, "1 of");
const auTrack = (() => { try { return JSON.parse(au).track; } catch { return -1; } })();
const first = (() => { try { return JSON.parse(au).now_playing.split(": ")[1]; } catch { return ""; } })();
const nx = await expect("ok", "live_audition", { step: "next" }, "2 of");
const second = (() => { try { return JSON.parse(nx).now_playing.split(": ")[1]; } catch { return "?"; } })();
const tr = await expect("ok", "live_get_track", { track: auTrack }, second);
if (tr.includes(`"${first}"`)) { failed++; console.log("!! the first pick should have been replaced"); }
await expect("ok", "live_audition", { step: "maybe" }, "3 of");
await expect("ok", "live_audition", { step: "back" }, "(maybe)");
await expect("ok", "live_audition", { step: "go", number: 1 }, "1 of");
await expect("refused", "live_audition", { step: "back" }, "first pick");
await expect("refused", "live_audition", { step: "go", number: 99 }, "Pick a number");
await expect("ok", "live_audition", { step: "keep" }, `Kept ${first}`);
await expect("refused", "live_audition", { step: "status" }, "No audition is running");
await call("live_screenshot", { max_width: 800 }); // fake_live has no Live window: expect "Live is not open" (or a picture if real Live is also open)
await call("live_undo");

// Which set is open (0.6.1): read from Live's window title (the test sets SECOND_CHAIR_LIVE_TITLE).
for (const [title, want, warn] of [["my-song* - Ableton Live 12 Suite", "my-song", false], ["Untitled - Ableton Live 12 Suite", "Untitled", true]] as const) {
  const { parseTitle } = await import("../mcp/liveset.ts");
  const r = parseTitle(title) as any;
  if (r.name !== want || !!r.warning !== warn || (want === "my-song" && !r.unsaved)) { failed++; console.log(`!! set title "${title}" read as ${JSON.stringify(r)}`); }
}
if (!/"set": \{\s*"name": "my-song",\s*"unsaved": true/.test(status.result?.content?.[0]?.text ?? "")) { failed++; console.log("!! live_status should report the open set"); }
// A new track's real index (0.6.1): real Live puts it after the selected track, not at the end.
const fakeOnly = (action: string, params: Record<string, unknown> = {}) => new Promise<void>((res) => {
  const s = net.createConnection({ host: "127.0.0.1", port: Number(process.env.SECOND_CHAIR_PORT || 9885) }, () =>
    s.write(JSON.stringify({ id: 1, token: fs.readFileSync(path.join(os.homedir(), "SecondChair", "token"), "utf8").trim(), action, params }) + "\n"));
  s.on("data", () => { s.destroy(); res(); });
});
await fakeOnly("fake_after_selected");
await expect("ok", "live_select_track", { track: 0 }, "\"selected_track\": 0");
await expect("ok", "live_create_midi_track", { name: "Placed" }, "\"track\": 1");
await expect("ok", "live_get_track", { track: 1 }, "Placed");

// Revert (0.7.0): the bridge takes back only its own changes, and stops if the user changed that thing since.
await expect("ok", "live_set_tempo", { bpm: 100 }, "100");
await expect("ok", "live_revert", { preview: true }, "set the tempo from");
await expect("ok", "live_revert", {}, "\"reverted\"");
await expect("ok", "live_status", {}, "\"tempo\": 170");
await expect("ok", "live_write_clip", { track: 0, slot: 5, length_beats: 4, notes: [{ pitch: 60, start: 0, duration: 1 }] }, "notes_written");
await expect("ok", "live_add_notes", { track: 0, slot: 5, notes: [{ pitch: 64, start: 1, duration: 1 }] }, "notes_added");
await expect("ok", "live_revert", {}, "added 1 note to");
await expect("ok", "live_get_clip_notes", { track: 0, slot: 5 }, "\"pitch\": 60");
await expect("ok", "live_revert", {}, "wrote the clip");
const t0 = await expect("ok", "live_get_track", { track: 0 }, "clips");
if (t0.includes("\"slot\": 5")) { failed++; console.log("!! the reverted clip should be gone"); }
await expect("ok", "live_set_tempo", { bpm: 111 }, "111");
await fakeOnly("fake_user_tempo", { bpm: 123 }); // the user changes the tempo by hand
await expect("refused", "live_revert", {}, "was changed since");
await expect("ok", "live_status", {}, "\"tempo\": 123");
await expect("ok", "live_revert", { skip: true }, "dropped_from_list");
const ld = await expect("ok", "live_load_sound", { path: "Pad/Noisy Pad.adv", new_track: true, arm: true, track_name: "Revert me" }, "\"revert_steps\": 3");
await expect("ok", "live_revert", { steps: 3 }, "made the MIDI track");
const st = await expect("ok", "live_status", {}, "tracks");
if (st.includes("Revert me")) { failed++; console.log("!! the reverted track should be gone"); }

// Sample chopping (0.8.0): a file into Simpler, slice settings, an audio clip's transpose, and deleting a track on request.
const js = (t: string) => { try { return JSON.parse(t); } catch { return {}; } };
await expect("refused", "live_load_sample", { new_track: true, file: "no such vocal zzz" }, "No audio file matching");
const ch = js(await expect("ok", "live_load_sample", { new_track: true, file: "fake-live-vocal 97", mode: "slice", slice_by: "region",
  regions: 8, warp: false, transpose: -6 }, "\"mode\": \"slice\""));
if (ch.regions !== 8 || ch.transpose !== "-6 st" || ch.warp !== false || ch.revert_steps !== 3 || ch.slices !== 8) { failed++; console.log("!! the chop load should set slice/region 8/-6 st/warp off with 3 revert steps"); }
await expect("ok", "live_get_simpler", { track: ch.track }, "\"slice_by\": \"region\"");
await expect("refused", "live_set_simpler", { track: ch.track, mode: "chopped" }, "mode can be");
await expect("ok", "live_set_simpler", { track: ch.track, slice_by: "transient", sensitivity: 50 }, "\"slice_by\": \"transient\"");
await expect("ok", "live_revert", {}, "reverted");
await expect("ok", "live_get_simpler", { track: ch.track }, "\"slice_by\": \"region\"");
await expect("ok", "live_revert", { steps: 3 }, "made the MIDI track");
const st2 = await expect("ok", "live_status", {}, "tracks");
if (st2.includes("fake-live-vocal")) { failed++; console.log("!! the reverted chop track should be gone"); }
const audioTrack = (js(st2).session?.tracks ?? []).findIndex((t: any) => t.name === "Bass guitar");
await expect("ok", "live_set_audio_clip", { track: audioTrack, slot: 7, transpose: -6, warp: false }, "\"transpose\": -6");
const fc = js(await expect("ok", "live_load_sample", { new_track: true, track_name: "Vox Chops", from_clip: { track: audioTrack, slot: 7 }, mode: "one-shot" }, "one-shot"));
if (fc.transpose !== "-6 st") { failed++; console.log("!! from_clip should keep the clip's transpose"); }
await expect("refused", "live_delete_track", { track: fc.track, name: "Wrong Name" }, "nothing was deleted");
await expect("refused", "live_delete_track", { track: audioTrack, name: "Bass guitar" }, "has clips");
await expect("ok", "live_delete_track", { track: fc.track, name: "Vox Chops" }, "\"had_devices\"");
if ((await call("live_status")).result?.content?.[0]?.text.includes("Vox Chops")) { failed++; console.log("!! Vox Chops should be deleted"); }

// Transport buttons (0.8.1): stop all clips, back to arrangement, arrangement record, jump to a bar.
await expect("ok", "live_fire_clip", { track: 0, slot: 0 }, "fired");
await expect("ok", "live_transport", { action: "stop_all_clips" }, "\"is_playing\"");
const tk = await expect("ok", "live_get_track", { track: 0 }, "clips");
if (tk.includes("\"playing\": true")) { failed++; console.log("!! stop_all_clips should stop every clip"); }
await expect("ok", "live_transport", { action: "record_on" }, "\"record\": true");
await expect("ok", "live_transport", { action: "record_off" }, "\"record\": false");
await expect("ok", "live_transport", { action: "jump", bar: 9 }, "\"bar\": 9");
await expect("refused", "live_transport", { action: "jump" }, "which bar");
await expect("ok", "live_transport", { action: "back_to_arrangement" }, "\"session_overrides_arrangement\": false");

// The Arrangement timeline (0.9.0): read it, place a Session clip at a bar (filling bars), never cover clips,
// duplicate and rename a track, rename a scene, and take it all back.
await expect("ok", "live_create_midi_track", { name: "Timeline" }, "Timeline");
const tlTrack = (js(await expect("ok", "live_status", {}, "Timeline")).session?.tracks ?? []).findIndex((t: any) => t.name === "Timeline");
await expect("ok", "live_write_clip", { track: tlTrack, slot: 0, length_beats: 16, name: "Pad", notes: [{ pitch: 60, start: 0, duration: 4 }] }, "notes_written");
const arr0 = await expect("ok", "live_get_arrangement", {}, "arrangement_loop");
if (!arr0.includes("\"on\": true")) { failed++; console.log("!! get_arrangement should show the Arrangement Loop is on"); }
const pl = js(await expect("ok", "live_place_clip", { track: tlTrack, slot: 0, bar: 17, bars: 10 }, "placed"));
if (pl.placed?.length !== 3 || pl.placed[0].start_bar !== 17 || pl.placed[2].end_bar !== 29 || !String(pl.note).includes("past")) { failed++; console.log("!! 10 bars of a 4-bar clip from bar 17 should be 3 copies to bar 29, with a note"); }
await expect("refused", "live_place_clip", { track: tlTrack, slot: 0, bar: 20 }, "never covers");
await expect("refused", "live_place_clip", { track: tlTrack, slot: 0, bar: 1, to_track: audioTrack }, "can't go on track");
await expect("ok", "live_get_arrangement", { track: tlTrack }, "\"start_bar\": 21");
await expect("ok", "live_rename", { scene: 0, name: "Verse" }, "\"was\": \"Intro\"");
await expect("refused", "live_rename", { name: "Nothing" }, "Give track or scene");
const dup = js(await expect("ok", "live_duplicate_track", { track: tlTrack }, "copied_from"));
if (dup.track !== tlTrack + 1) { failed++; console.log("!! the copy should sit right after the track"); }
await expect("ok", "live_rename", { track: dup.track, name: "Timeline 2" }, "Timeline 2");
// Automation (0.9.0): a volume fade over Arrangement clips, a filter sweep inside a Session clip, and the refusals.
await expect("refused", "live_automate", { track: tlTrack, device: "mixer", param: "Volume", from_bar: 25, to_bar: 29,
  start: { text: "0 dB" }, end: { text: "-inf dB" } }, "doesn't let scripts write automation into Arrangement clips");
const fade = js(await expect("ok", "live_automate", { track: tlTrack, device: "mixer", param: "Volume", slot: 0, from_bar: 1, to_bar: 5,
  start: { text: "0 dB" }, end: { text: "-inf dB" } }, "\"steps\""));
if (!["0.0 dB", "-0.0 dB"].includes(fade.start) || fade.end !== "-inf dB" || fade.steps !== 64 || !fade.revertible) { failed++; console.log("!! the Session-clip fade should go 0 dB to -inf in 64 steps, revertible"); }
await expect("refused", "live_automate", { track: tlTrack, device: "mixer", param: "Volume", from_bar: 40, to_bar: 44, start: { percent: 0 }, end: { percent: 100 } }, "live_record_automation");
await expect("refused", "live_automate", { track: tlTrack, slot: 0, device: "mixer", param: "Volume", from_bar: 5, to_bar: 3, start: { percent: 0 }, end: { percent: 100 } }, "before to_bar");
await expect("ok", "live_automate", { track: tlTrack, device: "mixer", param: "Pan", slot: 0, from_bar: 1, to_bar: 3, start: { percent: 0 }, end: { percent: 100 } }, "Session clip in slot 0");
const again = js(await expect("ok", "live_automate", { track: tlTrack, device: "mixer", param: "Volume", slot: 0, from_bar: 2, to_bar: 3, start: { percent: 50 }, end: { percent: 60 } }, "\"steps\""));
if (again.revertible !== false) { failed++; console.log("!! writing over existing automation should say it isn't revertible"); }
await expect("refused", "live_revert", {}, "live_undo");
await expect("ok", "live_revert", { skip: true }, "dropped_from_list");
const rvA = js(await expect("ok", "live_revert", { steps: 2 }, "reverted"));
if (rvA.reverted?.length !== 2) { failed++; console.log("!! the two new automation envelopes should revert"); }
const rv = await expect("ok", "live_revert", { steps: 4 }, "reverted");
const arr1 = js(await expect("ok", "live_get_arrangement", {}, "tracks"));
if ((arr1.tracks ?? []).some((t: any) => t.name === "Timeline 2") || (arr1.tracks ?? []).find((t: any) => t.name === "Timeline")?.clips.length !== 0) { failed++; console.log("!! reverting should remove the copy track and the placed clips: " + rv); }
if (!(await call("live_status")).result?.content?.[0]?.text.includes("Intro")) { failed++; console.log("!! the scene name should be back to Intro"); }

// A load that lands on the wrong track (0.9.1): real Live once loaded on the previously selected track.
await fakeOnly("fake_stuck_selection", { on: true });
const stuckBefore = await expect("ok", "live_get_track", { track: 0 }, "devices");
await expect("refused", "live_load_device", { track: tlTrack, name: "Compressor" }, "took that back off");
const stuckAfter = await expect("ok", "live_get_track", { track: 0 }, "devices");
if (JSON.stringify(js(stuckBefore).devices) !== JSON.stringify(js(stuckAfter).devices)) { failed++; console.log("!! the stray Compressor should be gone from track 0"); }
await fakeOnly("fake_stuck_selection", { on: false });
await expect("ok", "live_load_device", { track: tlTrack, name: "Compressor" }, "Compressor");

// Devices, meters and clip edits (0.9.2).
await expect("ok", "live_load_device", { track: tlTrack, name: "808 Rack" }, "808 Rack");
const rk = await expect("ok", "live_get_device", { track: tlTrack, device: "808 Rack" }, "Saturator");
if (!rk.includes("chains")) { failed++; console.log("!! a rack should list its chains"); }
await expect("ok", "live_set_device_param", { track: tlTrack, device: "808 Rack > Drum Buss", param: "Drive", percent: 40 }, "\"now\": \"40 %\"");
await expect("refused", "live_get_device", { track: tlTrack, device: "Compressor > Thing" }, "isn't a rack");
const mv = js(await expect("ok", "live_move_device", { track: tlTrack, device: "808 Rack > Drum Buss", before: "Saturator" }, "\"moved\": true"));
if (JSON.stringify(mv.devices) !== JSON.stringify(["Operator", "Drum Buss", "Saturator"])) { failed++; console.log("!! Drum Buss should now sit before Saturator: " + JSON.stringify(mv.devices)); }
await expect("ok", "live_revert", {}, "reverted");
await expect("ok", "live_get_device", { track: tlTrack, device: "808 Rack > 1" }, "Saturator");
await expect("refused", "live_delete_device", { track: tlTrack, device: "Compressor", name: "Glue Compressor" }, "nothing was deleted");
await expect("ok", "live_delete_device", { track: tlTrack, device: "Compressor", name: "Compressor" }, "\"deleted\"");
const lv = js(await expect("ok", "live_get_levels", { seconds: 0.3 }, "levels"));
if ((!lv.is_playing && !lv.warning) || !(lv.levels ?? []).some((r: any) => r.track === "main" && r.peak > 0)) { failed++; console.log("!! levels should include Main and warn when Live isn't playing"); }
const lvReturn = (lv.levels ?? []).find((r: any) => r.kind === "return"), lvMain = (lv.levels ?? []).filter((r: any) => typeof r.track === "number").length;
if (!(lv.levels ?? []).some((r: any) => r.audio === false && r.reads === "no audio")) { failed++; console.log("!! a MIDI track with no instrument should read no audio, not fail"); }
if (!lvReturn) { failed++; console.log("!! levels should include the return tracks"); }
else {
  await expect("ok", "live_get_levels", { track: lvReturn.track, seconds: 0.2 }, "\"kind\": \"return\"");
  await expect("ok", "live_get_levels", { track: lvMain, seconds: 0.2 }, "\"track\": \"main\"");
}
if (!(lv.levels ?? []).some((r: any) => r.peak === 0.62 && r.peak_db === -22.9 && r.about === "-22.9 dB" && r.reads === "low")) { failed++; console.log("!! levels: a meter value of 0.62 is -22.9 dB (76 x value - 70), which reads low: " + JSON.stringify(lv.levels?.[0])); }
await expect("ok", "live_copy_clip", { track: tlTrack, slot: 0, to_track: tlTrack, to_slot: 1 }, "copied");
await expect("refused", "live_copy_clip", { track: tlTrack, slot: 0, to_track: tlTrack, to_slot: 1 }, "already has a clip");
await expect("ok", "live_revert", {}, "reverted");
await expect("ok", "live_place_clip", { track: tlTrack, slot: 0, bar: 1 }, "placed");
await expect("refused", "live_arrangement_clip", { action: "move", track: tlTrack, bar: 1, name: "Wrong", to_bar: 9 }, "nothing was changed");
await expect("refused", "live_arrangement_clip", { action: "move", track: tlTrack, bar: 2, name: "Pad", to_bar: 9 }, "no clip starts at bar 2");
await expect("ok", "live_arrangement_clip", { action: "move", track: tlTrack, bar: 1, name: "Pad", to_bar: 9 }, "\"start_bar\": 9");
await expect("ok", "live_revert", {}, "reverted");
await expect("ok", "live_get_arrangement", { track: tlTrack }, "\"start_bar\": 1,");
await expect("ok", "live_arrangement_clip", { action: "delete", track: tlTrack, bar: 1, name: "Pad" }, "\"deleted\"");
const af = js(await expect("ok", "live_get_arrangement", { track: tlTrack }, "tracks"));
if (af.tracks?.[0]?.clips?.length !== 0) { failed++; console.log("!! the deleted Arrangement clip should be gone"); }

// Recorded automation (0.9.3): plays from a bar early, punches in at from_bar, turns the knob, puts everything back.
await expect("ok", "live_transport", { action: "stop" }, "is_playing");
await expect("ok", "live_arm_track", { track: 0, armed: true }, "armed");
await expect("refused", "live_record_automation", { track: tlTrack, device: "mixer", param: "Volume", from_bar: 3, to_bar: 2, start: { percent: 0 }, end: { percent: 100 } }, "before to_bar");
const ra = js(await expect("ok", "live_record_automation", { track: tlTrack, device: "mixer", param: "Volume", from_bar: 2, to_bar: 3,
  start: { text: "-12 dB" }, end: { text: "0 dB" } }, "\"recorded\": true"));
const rb = (ra.read_back ?? []).map((r: any) => [r.bar, Object.values(r.settings)[0]]);
if (ra.read_back_ok !== true || ra.read_back_mismatch) { failed++; console.log("!! a clean take should read back as planned: " + JSON.stringify(ra.read_back_mismatch)); }
console.log("read_back:", JSON.stringify(rb));
const at = (bar: number) => String((rb.find((r: any[]) => r[0] === bar) ?? [])[1] ?? "");
if (!at(1.5).startsWith("-0.0") && !at(1.5).startsWith("0.0")) { failed++; console.log("!! before the ramp the old 0 dB should read back"); }
const mid = parseFloat(at(2.5));
if (!(mid > -11 && mid < -1)) { failed++; console.log("!! half way through the ramp should read between -12 and 0 dB"); }
const fakeAsk = (action: string, params: Record<string, unknown> = {}) => new Promise<any>((res) => {
  let got = "";
  const s = net.createConnection({ host: "127.0.0.1", port: Number(process.env.SECOND_CHAIR_PORT || 9885) }, () =>
    s.write(JSON.stringify({ id: 1, token: fs.readFileSync(path.join(os.homedir(), "SecondChair", "token"), "utf8").trim(), action, params }) + "\n"));
  s.on("data", (c) => { got += c; if (got.includes("\n")) { s.destroy(); res(js(got).result ?? {}); } });
});
const rr = await fakeAsk("fake_recorded", { track: tlTrack });
console.log("recorded:", JSON.stringify(rr));
if (!(ra.steps > 3) || !(ra.re_armed ?? []).includes("Keys")) { failed++; console.log("!! the take should step the knob several times and re-arm Keys: " + JSON.stringify(ra)); }
if (!(rr.points > 3) || rr.loop !== true || rr.automation_arm !== false || rr.record !== false || rr.playing !== false || JSON.stringify(rr.armed) !== JSON.stringify(ra.re_armed)) { failed++; console.log("!! the take should record points and put loop, Automation Arm, record, transport and arm back"); }
// The lane was empty, so the bar before (bar 1) keeps the old 0 dB (0.85) and the ramp runs from bar 2 to bar 3.
const vp: number[][] = rr.volume_points ?? [];
const pre1 = vp.filter((x) => x[0] < 4), ramp = vp.filter((x) => x[0] >= 4);
if (!pre1.length || pre1.some((x) => Math.abs(x[1] - 0.85) > 0.001) || !ramp.length || ramp[ramp.length - 1][0] < 8 - 0.3 || ramp[0][1] >= ramp[ramp.length - 1][1]) { failed++; console.log("!! the bar before should hold the old value, then the ramp rise from bar 2 to 3: " + JSON.stringify(vp.slice(0, 4))); }
if (!String(js(JSON.stringify(ra)).lanes?.[0]?.kept_before).includes("0.0 dB")) { failed++; console.log("!! the result should say the old setting was kept before from_bar"); }
await expect("ok", "live_arm_track", { track: 0, armed: false }, "armed");

// Shapes (0.9.4): points with curves and an LFO in one take, the speed limit, Session-clip LFOs, plugin knobs.
await fakeAsk("fake_clear_recorded", { track: tlTrack });
const two = js(await expect("ok", "live_record_automation", { track: tlTrack, from_bar: 2, to_bar: 4, lanes: [
  { device: "mixer", param: "Volume", curve: "s", points: [{ bar: 2, percent: 20 }, { bar: 3, percent: 60, curve: "step" }, { bar: 4, percent: 90 }] },
  { device: "mixer", param: "Pan", lfo: { shape: "sine", rate: "1/2", low: { percent: 0 }, high: { percent: 100 } } } ] }, "\"recorded\": true"));
const rr2 = await fakeAsk("fake_recorded", { track: tlTrack });
console.log("two lanes:", JSON.stringify({ lanes: two.lanes, pan_min: rr2.pan_min, pan_max: rr2.pan_max, pan_points: rr2.pan_points }));
if (two.lanes?.length !== 2 || !(rr2.pan_points > 5) || !(rr2.pan_min < -0.8) || !(rr2.pan_max > 0.8)) { failed++; console.log("!! the LFO lane should swing Pan right across while Volume follows its points"); }
const vols = rr2.volume_values ?? [];
if (!vols.length || vols.some((v: number, k: number) => k > 0 && v < vols[k - 1] - 0.001)) { failed++; console.log("!! the Volume points only go up, so the recorded values should never fall"); }
await expect("refused", "live_record_automation", { track: tlTrack, from_bar: 2, to_bar: 4, device: "mixer", param: "Pan", lfo: { rate: "1/16" } }, "too fast");
// Real-Live gotchas (0.9.4): a flat take still writes, and hold_to_bar keeps the end value.
await fakeAsk("fake_clear_recorded", { track: tlTrack });
await expect("ok", "live_record_automation", { track: tlTrack, from_bar: 2, to_bar: 3, hold_to_bar: 4, device: "mixer", param: "Volume", start: { percent: 50 }, end: { percent: 70 } }, "\"held_to_bar\": 4");
const rh = await fakeAsk("fake_recorded", { track: tlTrack });
// Read-back (0.9.4): the knob's setting at bars before, inside and after, read by moving the play position.
const rk2 = js(await expect("ok", "live_read_knob", { track: tlTrack, device: "mixer", param: "Volume", bars: [3.5, 4.5] }, "\"automated\": true"));
console.log("read_knob:", JSON.stringify(rk2.at));
await expect("refused", "live_read_knob", { track: tlTrack, device: "mixer", param: "Volume", bars: [] }, "1-32");
const held: number[][] = (rh.volume_points ?? []).filter((x: number[]) => x[0] > 8 + 0.2);
if (held.length < 5 || held[held.length - 1][0] < 12 - 0.3 || held.some((x) => Math.abs(x[1] - 0.7) > 0.001)) { failed++; console.log("!! bars 3-4 should keep writing 70 % (with tiny nudges): " + JSON.stringify(held.slice(-3))); }
await fakeAsk("fake_clear_recorded", { track: tlTrack });
await expect("ok", "live_record_automation", { track: tlTrack, from_bar: 2, to_bar: 3, device: "mixer", param: "Volume", start: { percent: 40 }, end: { percent: 40 } }, "\"recorded\": true");
const rf = await fakeAsk("fake_recorded", { track: tlTrack });
if (!(rf.points > 5)) { failed++; console.log("!! a flat take should still write points"); }
await expect("refused", "live_record_automation", { track: tlTrack, from_bar: 2, to_bar: 3, hold_to_bar: 2.5, device: "mixer", param: "Volume", start: { percent: 40 }, end: { percent: 50 } }, "after to_bar");
await expect("refused", "live_record_automation", { track: tlTrack, from_bar: 2, to_bar: 4, device: "mixer", param: "Pan", start: { percent: 0 }, end: { percent: 9 }, curve: "wobbly" }, "curve can be");
await expect("refused", "live_record_automation", { track: tlTrack, from_bar: 2, to_bar: 4, device: "mixer", param: "Pan", lfo: { rate: "soon" } }, "isn't like");
const slfo = js(await expect("ok", "live_automate", { track: tlTrack, slot: 0, device: "mixer", param: "Send A", from_bar: 1, to_bar: 2, lfo: { shape: "triangle", rate: "1/16" } }, "triangle"));
if (slfo.steps !== 256) { failed++; console.log("!! a 1/16 LFO over one bar in a Session clip should be written in 256 steps (16 per cycle)"); }
await expect("refused", "live_record_automation", { track: audioTrack, from_bar: 2, to_bar: 3, device: "Kickstart 2", param: "Mix", start: { text: "10 %" }, end: { text: "90 %" } }, "only shows its current setting");
await expect("ok", "live_record_automation", { track: audioTrack, from_bar: 2, to_bar: 3, device: "Kickstart 2", param: "Mix", start: { percent: 10 }, end: { percent: 90 } }, "\"recorded\": true");

// Note-length knobs (0.8.2): "1/4" on Echo's L Synced must set 1/4, not the lowest step.
await expect("ok", "live_load_device", { track: 1, name: "Echo" }, "Echo");
await expect("ok", "live_set_device_param", { track: 1, device: "Echo", param: "L Synced", text: "1/16" }, "\"now\": \"1/16\"");
await expect("ok", "live_set_device_param", { track: 1, device: "Echo", param: "L Synced", text: "1/4" }, "\"now\": \"1/4\"");
await expect("ok", "live_set_device_param", { track: 1, device: "Echo", param: "L Synced", text: "1/1" }, "\"now\": \"1/1\"");

// Buses and return tracks (0.9.5): returns and Main have track numbers, a vocal bus without grouping.
const st5 = js(await expect("ok", "live_status", {}, "returns")).session;
const nReg = st5.tracks.length;
if (st5.returns?.[0]?.index !== nReg || st5.returns[0].name !== "A-Reverb" || st5.returns[0].send !== "Send A" || st5.main?.index !== nReg + st5.returns.length) { failed++; console.log("!! returns and Main should be numbered after the regular tracks: " + JSON.stringify([st5.returns, st5.main])); }
await expect("ok", "live_load_device", { track: nReg, name: "Reverb" }, "Reverb");
await expect("ok", "live_set_device_param", { track: nReg, device: "Reverb", param: "Dry/Wet", percent: 100 }, "\"now\": \"100 %\"");
await expect("ok", "live_load_device", { track: st5.main.index, name: "Compressor" }, "Compressor");
await expect("refused", "live_delete_track", { track: nReg, name: "A-Reverb" }, "regular tracks");
// Real Live raises on clip properties of return tracks and Main (found on the Mac): these must answer cleanly.
await expect("ok", "live_get_track", { track: nReg }, "\"slot_count\": 0");
await expect("refused", "live_fire_clip", { track: st5.main.index, slot: 0 }, "no clip slots");
await expect("ok", "live_get_arrangement", { track: nReg }, "\"clips\": []");
await expect("refused", "live_duplicate_track", { track: st5.main.index }, "regular tracks");
const rt = js(await expect("ok", "live_create_return_track", { name: "Vox Verb" }, "\"send\": \"Send C\""));
await expect("ok", "live_revert", {}, "reverted");
if ((js(await expect("ok", "live_status", {}, "returns")).session.returns ?? []).length !== 2) { failed++; console.log("!! reverting should remove the new return track: " + JSON.stringify(rt)); }
const bus = js(await expect("ok", "live_create_audio_track", { name: "Vocals Bus" }, "\"kind\": \"audio\""));
await expect("ok", "live_set_monitoring", { track: bus.track, monitor: "in" }, "\"was\": \"auto\"");
await expect("refused", "live_set_monitoring", { track: bus.track, monitor: "loud" }, "in, auto, off");
const busInfo = (js(await expect("ok", "live_status", {}, "Vocals Bus")).session.tracks ?? []).find((t: any) => t.name === "Vocals Bus");
if (busInfo?.monitor !== "in") { failed++; console.log("!! the bus should show monitor: in"); }
await expect("ok", "live_set_routing", { track: 0, io: "output", source: "Sends Only" }, "Sends Only");
await expect("ok", "live_revert", { steps: 3 }, "reverted");

// Melodyne Transfer and bouncing (0.9.4).
const bassIdx = (js(await expect("ok", "live_status", {}, "Bass guitar")).session?.tracks ?? []).findIndex((t: any) => t.name === "Bass guitar");
await expect("refused", "live_play_bars", { from_bar: 2, to_bar: 3, melodyne_track: bassIdx }, "has no Melodyne");
await expect("ok", "live_load_device", { track: bassIdx, name: "Melodyne", tree: "plugins" }, "Melodyne");
await expect("refused", "live_play_bars", { from_bar: 2, to_bar: 3, melodyne_track: bassIdx }, "position 0");
await expect("ok", "live_move_device", { track: bassIdx, device: "Melodyne", position: 0 }, "\"position\": 0");
await expect("refused", "live_play_bars", { from_bar: 40, to_bar: 41, melodyne_track: bassIdx }, "nothing for Melodyne");
await expect("ok", "live_place_clip", { track: bassIdx, slot: 7, bar: 2 }, "placed");
const pb = js(await expect("ok", "live_play_bars", { from_bar: 2, to_bar: 3, melodyne_track: bassIdx }, "\"played\": true"));
if (!String(pb.note).includes("Transfer")) { failed++; console.log("!! the Melodyne play should say what to do if nothing shows"); }
const bo = js(await expect("ok", "live_bounce_track", { track: bassIdx, from_bar: 2, to_bar: 3 }, "\"recorded\": true"));
if (bo.track !== bassIdx + 1 || bo.name !== "Bass guitar (bounce)" || bo.source?.channel !== "Post FX" || bo.clips?.length !== 1 || bo.clips[0].start_bar !== 2 || bo.clips[0].end_bar !== 3) { failed++; console.log("!! the bounce should be one clip, bars 2-3, on a new track right after: " + JSON.stringify(bo)); }
const after = js(await expect("ok", "live_status", {}, "tracks")).session?.tracks ?? [];
if (after.some((t: any) => t.armed && t.name === "Bass guitar (bounce)")) { failed++; console.log("!! the bounce track should be disarmed afterwards"); }

// Lining up stacked takes (0.9.6): the stack's notes start 30 ms late (one 200 ms late, which must stay).
const vs = await fakeAsk("fake_vocal_stack");
const leadRef = { track: vs.lead, bar: 5, name: "Lead Vox take" }, stackRef = { track: vs.stack, bar: 5, name: "Stack Vox take" };
await expect("ok", "live_audio_clip_info", { clip: stackRef }, "first_markers");
const pv = js(await expect("ok", "live_align_audio", { clip: stackRef, to: leadRef, preview: true }, "\"preview\": true"));
if (pv.starts_found !== 7 || pv.moved !== 6 || pv.left_in_place !== 1 || Math.abs(pv.biggest_shift_ms - 30) > 3) { failed++; console.log("!! preview should find 7 starts, move 6 by about 30 ms and leave 1: " + JSON.stringify(pv)); }
if ((await fakeAsk("fake_stack_markers", { track: vs.stack })).markers.length !== 2) { failed++; console.log("!! a preview must not add markers"); }
const al = js(await expect("ok", "live_align_audio", { clip: stackRef, to: leadRef }, "\"markers_added\": 7"));
const mk: number[][] = (await fakeAsk("fake_stack_markers", { track: vs.stack })).markers;
// The lead's starts are every half second from 0.5 s; the late one stays at 2.2 s. In beats at the fake's tempo:
const want = [0.5, 1.0, 1.5, 2.2, 2.5, 3.0, 3.5].map((sec) => sec * vs.tempo / 60);
const got = mk.slice(1, -1).map((m) => m[1]);
if (got.length !== 7 || got.some((b, k) => Math.abs(b - want[k]) > 0.012)) { failed++; console.log("!! the stack's starts should sit on the lead's (the late one pinned at 4.4): " + JSON.stringify(got)); }
await expect("refused", "live_align_audio", { clip: stackRef, to: stackRef }, "same clip");
await expect("refused", "live_align_audio", { clip: stackRef }, "to (the clip to match) or grid");
await expect("ok", "live_revert", {}, "reverted");
if ((await fakeAsk("fake_stack_markers", { track: vs.stack })).markers.length !== 2) { failed++; console.log("!! reverting should remove the added warp markers: " + JSON.stringify(al.moved)); }
await expect("ok", "live_align_audio", { clip: stackRef, grid: "1/4", max_ms: 40 }, "the 1/4 grid");

// Measuring a file (0.9.7): works on the generated take, with a reference, and refuses a file that isn't audio.
const leadWav = path.join(os.tmpdir(), "fake-live-lead-vox.wav");
const an = js(await expect("ok", "audio_analyze", { file: leadWav, reference: leadWav }, "integrated_lufs"));
if (typeof an.integrated_lufs !== "number" || an.channels !== 1 || an.against_reference?.louder_by_lu !== 0 || !Array.isArray(an.reading)) { failed++; console.log("!! analyze should give loudness, a reading and a zero difference against itself: " + JSON.stringify(an).slice(0, 300)); }
await expect("refused", "audio_analyze", { file: path.join(os.tmpdir(), "fake-live-vocal_97_A#m.wav") }, "isn't a WAV file");
await expect("refused", "audio_analyze", {}, "file or clip");
// Song analysis (song_analyze): the made-up G minor loop at 92 BPM (test/song_loop.ts; test/song_analyze.ts checks it in detail).
const loopWav = path.join(os.tmpdir(), `second-chair-song-loop-${process.pid}.wav`);
writeWav16(loopWav, synthLoop());
const song = js(await expect("ok", "song_analyze", { file: loopWav }, "\"best\": \"G minor\""));
if (Math.abs(song.tempo?.bpm - 92) > 0.25) { failed++; console.log(`!! song_analyze should find 92 BPM, got ${song.tempo?.bpm}`); }
fs.rmSync(loopWav, { force: true });
await expect("refused", "song_analyze", {}, "file or clip");
// Stems (0.12.1): made-up Vocals, Drums (near silent), Bass and Others in a group track, as Separate Stems leaves them.
const stemParts = synthStems(92, 8);
const stemFiles = Object.fromEntries(Object.entries(stemParts).map(([k, x]) => { const f = path.join(os.tmpdir(), `second-chair-stem-${process.pid}-${k}.wav`); writeWav16(f, x); return [k, f]; }));
const sg = await fakeAsk("fake_stem_group", { files: stemFiles });
const stemRep = js(await expect("ok", "song_analyze", { stems: sg.group }, "\"stem_group\""));
if (Object.keys(stemRep.stem_group?.stems ?? {}).length !== 4 || !stemRep.levels?.drums?.near_silent || stemRep.levels?.vocals?.near_silent) { failed++; console.log("!! the stem group should give four stems, the drums near silent: " + JSON.stringify(stemRep.stem_group) + JSON.stringify(stemRep.levels)); }
if (!/G minor/.test(stemRep.key?.harmony?.best) || !/B♭ major/.test(stemRep.key?.melody?.best) || !/relative keys/.test(stemRep.key?.reading)) { failed++; console.log("!! the chords should lean G minor and the melody B♭ major: " + JSON.stringify(stemRep.key)); }
if (!stemRep.keys_for_singer?.options?.length || !stemRep.summary.some((l: string) => l.startsWith("No drums"))) { failed++; console.log("!! stems should offer keys for the singer and say there are no drums"); }
const sp = js(await expect("ok", "song_analyze", { stems: { vocals: stemFiles.vocals, others: stemFiles.others } }, "\"harmony\""));
if (sp.levels?.drums || !/B♭ major/.test(sp.key?.melody?.best)) { failed++; console.log("!! two stem paths should read just those two: " + JSON.stringify(sp.levels)); }
await expect("refused", "song_analyze", { stems: 0 }, "isn't a group track");
await expect("refused", "song_analyze", { stems: { vocals: "no-such-file.wav" } }, "isn't a file");
for (const f of Object.values(stemFiles)) fs.rmSync(f as string, { force: true });
await expect("ok", "studio_guide", { playbook: "mastering" }, "LUFS");
if (js(await expect("ok", "live_status", {}, "bridge")).version_warning) { failed++; console.log("!! a newer server with a current Remote Script shouldn't warn"); }

// The studio profile (0.9.8): none at first, the questions come back; once saved, the tools use the user's name.
const noProf = js(await expect("ok", "my_studio", {}, "questions"));
if (noProf.profile !== null || !String(noProf.questions).includes("Name")) { failed++; console.log("!! with no profile, my_studio should give the questions"); }
const listed = (await rpc("tools/list")).result.tools as { name: string; description: string }[];
if (listed.some((t) => /\bCello\b/.test(JSON.stringify(t))) || !listed.find((t) => t.name === "live_delete_track")!.description.toLowerCase().includes("the user")) { failed++; console.log("!! without a profile the tools should say 'the user', and never a person's name"); }
await expect("refused", "my_studio", { text: "hi" }, "too short");
await expect("ok", "my_studio", { text: "# My studio\n\n- **Name:** Sam\n\n## Gear and folders\n\n- **Controller:** a 49-key keyboard\n" }, "\"name\": \"Sam\"");
await expect("ok", "my_studio", {}, "49-key");
const listed2 = (await rpc("tools/list")).result.tools as { name: string; description: string }[];
if (!listed2.find((t) => t.name === "live_delete_track")!.description.includes("Sam")) { failed++; console.log("!! with a profile the tools should use the user's name"); }
await expect("ok", "studio_guide", { section: "my studio" }, "49-key");

// Mute, solo and new scenes (0.9.9)
await expect("ok", "live_mute_track", { track: 1, mute: true }, "\"mute\": true");
if (!js(await expect("ok", "live_status", {}, "bridge")).session.tracks[1].mute) { failed++; console.log("!! live_mute_track should mute the track"); }
await expect("ok", "live_mute_track", { track: 0, solo: true }, "\"solo\": true");
await expect("ok", "live_mute_track", { track: 1, solo: true }, "also_soloed");
await expect("refused", "live_mute_track", { track: 1 }, "give mute, solo or both");
await expect("refused", "live_mute_track", { track: 999, mute: true }, "doesn't exist");
await expect("ok", "live_mute_track", { track: 1, mute: false, solo: false }, "\"mute\": false");
await expect("ok", "live_mute_track", { track: 0, solo: false }, "\"solo\": false");
const scn = js(await expect("ok", "live_create_scene", { count: 2 }, "new_scenes"));
if (scn.new_scenes.length !== 2 || scn.new_scenes[1] !== scn.scenes - 1) { failed++; console.log("!! live_create_scene should add two scenes at the end"); }
await expect("ok", "live_create_scene", { index: 0 }, "moved down by 1");
await expect("refused", "live_create_scene", { count: 40 }, "count must be 1-16");

// Deleting a Session clip (0.9.9): only with the clip's name
const delT = js(await expect("ok", "live_create_midi_track", { name: "Delete test" }, "track")).track;
await expect("ok", "live_write_clip", { track: delT, slot: 0, length_beats: 4, name: "Scratch idea", notes: [{ pitch: 60, start: 0, duration: 1 }] }, "notes_written");
await expect("refused", "live_delete_clip", { track: delT, slot: 0, name: "Other clip" }, "so nothing was changed");
await expect("refused", "live_delete_clip", { track: delT, slot: 1, name: "Scratch idea" }, "already empty");
await expect("ok", "live_delete_clip", { track: delT, slot: 0, name: "scratch idea" }, "\"deleted\"");
await expect("refused", "live_delete_clip", { track: delT, slot: 0, name: "Scratch idea" }, "already empty");

// The plugin guide: none at first, the outline comes back; once saved, find returns only the lines for a job.
const noGuide = js(await expect("ok", "my_plugins", {}, "outline"));
if (noGuide.guide !== null || !String(noGuide.outline).includes("Not sure what these are")) { failed++; console.log("!! with no plugin guide, my_plugins should give the outline"); }
await expect("refused", "my_plugins", { text: "hi" }, "too short");
await expect("ok", "my_plugins", { text: "# My plugins\n\n## Effects\n\n- **Valhalla Room** (VST3): a reverb. Good for: vocals, drums. (unconfirmed)\n- **Kickstart 2** (VST3): a volume ducker. Good for: sidechain pumping. (unconfirmed)\n\n## Mixing and mastering\n\n- **Ozone 11** (VST3): a mastering suite. Good for: loudness, tone. (unconfirmed)\n" }, "saved");
const found = await expect("ok", "my_plugins", { find: "reverb" }, "Valhalla Room");
if (found.includes("Kickstart") || found.includes("Ozone")) { failed++; console.log("!! my_plugins find should return only the matching lines"); }
await expect("ok", "my_plugins", { find: "mastering" }, "Ozone 11");
await expect("ok", "my_plugins", { find: "granular" }, "Nothing in the plugin guide matches");
await expect("ok", "my_plugins", {}, "Kickstart 2");
if (!js(await expect("ok", "live_status", {}, "plugin_guide")).plugin_guide.startsWith("yes")) { failed++; console.log("!! live_status should say the plugin guide exists"); }
if (!js(await expect("ok", "live_status", {}, "studio_profile")).studio_profile.includes("Sam")) { failed++; console.log("!! live_status should say the profile exists"); }
await expect("refused", "live_delete_track", { track: 0, name: "Wrong" }, "nothing was deleted");
fs.rmSync(STUDIO_FILE, { force: true }); fs.rmSync(STUDIO_FILE.replace(/\.md$/, "") + ".previous.md", { force: true });

// Second Chair Ears (optional Max for Live audio effect): live_listen refuses until a device reports, then gives its numbers.
await expect("refused", "live_listen", {}, "no Second Chair Ears device is reporting");
await fakeOnly("fake_ears", { track: 1 }); // the stand-in device lands on track 1
await new Promise((r) => setTimeout(r, 1200));
const ear = js(await expect("ok", "live_listen", {}, "125 Hz (bass)"));
const e0 = ear.ears?.[0];
if (ear.ears?.length !== 1 || e0?.track !== 1) { failed++; console.log("!! live_listen should report one Ears device, on track 1 (reports from a made-up track kind or a missing track are dropped)"); }
if (!(e0?.age_ms >= 0 && e0?.age_ms < 1000)) { failed++; console.log("!! live_listen should say how old the numbers are, and they should be fresh"); }
if (e0?.last_moment?.peak_db !== -6 || e0?.last_moment?.rms_db !== -18 || e0?.last_moment?.crest_db !== 12 || e0?.reads !== "healthy") { failed++; console.log("!! live_listen: wrong peak, RMS, crest or word: " + JSON.stringify(e0?.last_moment)); }
if (e0?.bands?.length !== 8 || !String(e0?.most_energy).startsWith("125 Hz") || !(e0?.bands[1].share_percent > 50)) { failed++; console.log("!! live_listen: the bass band should hold most of the energy"); }
await expect("ok", "live_listen", { track: 1, seconds: 1 }, "\"track\": 1");
await expect("refused", "live_listen", { track: 0 }, "no Ears device on track 0");
await expect("refused", "live_listen", { track: 99 }, "doesn't exist");
await fakeOnly("fake_ears", {}); // the device is removed: after 3 s of silence it counts as gone
await new Promise((r) => setTimeout(r, 3400));
await expect("refused", "live_listen", {}, "no Second Chair Ears device is reporting");

// 0.12.0 (Remote Script 0.11.0): set identity and dialogs from the API, select, import, convert, quantize.
{
  const st = js(await expect("ok", "live_status", {}, "\"dialog\""));
  const project = (await fakeAsk("fake_set_path")).project as string;
  if (st.set?.name !== "my-song" || st.set?.unsaved !== true || st.set?.path !== path.join(project, "my-song.als") || !/API/.test(st.set?.source)) { failed++; console.log("!! live_status should take the set's name and path from Live's API, and the * from the title: " + JSON.stringify(st.set)); }
  if (st.dialog?.open !== false || st.dialog?.source !== "Live's API") { failed++; console.log("!! live_status should say no message box is open: " + JSON.stringify(st.dialog)); }
  if (st.set_api || st.version_warning) { failed++; console.log("!! live_status shouldn't pass on the raw set_api, or warn with a current script"); }
  await fakeAsk("fake_dialog", { text: "This action will stop audio. Proceed?", buttons: 2 });
  const dl = js(await expect("ok", "live_status", {}, "This action will stop audio")).dialog;
  if (dl?.open !== true || dl?.buttons !== 2 || !/answer it in Live/.test(dl?.note)) { failed++; console.log("!! live_status should report the open message box: " + JSON.stringify(dl)); }
  await fakeAsk("fake_dialog", {});
  // Message boxes in Live's log since it last started (before an older start don't count).
  fs.writeFileSync(process.env.SECOND_CHAIR_LIVE_LOG!, "2026-11-18T05:00:00.000001: info: Message Box: an old one\n2026-11-18T06:00:00.000001: info: Started: Live 12.4.16 Build: x\n2026-11-18T06:01:02.123456: info: Message Box: Live unexpectedly quit. Would you like to recover your work?\n");
  const lg = js(await expect("ok", "live_status", {}, "recover your work")).dialog?.log?.message_boxes_since_live_started ?? [];
  if (lg.length !== 1 || lg[0].at !== "2026-11-18T06:01:02.123456" || typeof lg[0].seconds_ago !== "number") { failed++; console.log("!! live_status should list only the log's message boxes since Live started: " + JSON.stringify(lg)); }
  const unsaved = (await fakeAsk("fake_set_path", { path: "" }));
  const un = js(await expect("ok", "live_status", {}, "\"untitled\": true")).set;
  if (!un?.warning || un?.path !== "") { failed++; console.log("!! a set with no file should be untitled, with the warning: " + JSON.stringify(un) + JSON.stringify(unsaved)); }
  await fakeAsk("fake_set_path");

  const probe = js(await expect("ok", "live_probe", {}, "\"python\""));
  if (!probe.docs?.["Conversions.audio_to_midi_clip"]?.includes("(Song)arg1") || probe.imports?.subprocess !== "works" || probe.values?.["Song.name"] !== "my-song") { failed++; console.log("!! live_probe should read docstrings, values and imports: " + JSON.stringify(probe).slice(0, 400)); }
  if (!/missing/.test(probe.docs?.["ClipSlot.create_audio_clip"] ?? "")) { failed++; console.log("!! live_probe should say missing for a name the stand-in lacks, and carry on"); }
  await fakeAsk("fake_old_script", { on: true });
  await expect("refused", "live_probe", {}, "needs the Second Chair script 0.11.0 or newer");
  await fakeAsk("fake_old_script", { on: false });

  const tracks = js(await expect("ok", "live_status", {}, "Bass guitar")).session.tracks as any[];
  const bass = tracks.findIndex((t) => t.name === "Bass guitar"), keys = tracks.findIndex((t) => t.name === "Keys");
  const vl = (js(await expect("ok", "live_get_track", { track: bass }, "vocal loop")).clips as any[]).find((c) => c.name === "vocal loop").slot; // scenes added earlier moved it
  const free = (js(await expect("ok", "live_get_track", { track: bass }, "slot_count")).clips as any[]).map((c) => c.slot);
  const [s1, s2, s3] = [0, 1, 2, 3, 4, 5, 6, 7].filter((k) => !free.includes(k));
  const sel = js(await expect("ok", "live_select_clip", { track: bass, slot: vl }, "\"selected\": true"));
  if (sel.detail_clip?.name !== "vocal loop" || sel.selected_track !== bass || sel.focused_view !== "Session" || sel.highlighted_slot?.has_clip !== true) { failed++; console.log("!! live_select_clip should select the slot, show the clip and the Session view: " + JSON.stringify(sel)); }
  await expect("ok", "live_select_clip", { track: bass, slot: s1, show: false }, "That slot is empty");
  await expect("refused", "live_select_clip", { track: bass, slot: 99 }, "doesn't exist");

  // Import from disk: copied into the project once, never over a different file, refused into a full slot or a MIDI track.
  const wav = path.join(os.tmpdir(), `second-chair-import-${process.pid}.wav`);
  writeWav16(wav, new Float32Array(44100 * 2).map((_, i) => Math.sin(i / 20) * 0.3));
  const imp = js(await expect("ok", "live_import_audio", { file: wav, track: bass, slot: s1 }, "\"copied\": true"));
  const copy = path.join(project, "Samples", "Imported", path.basename(wav));
  if (imp.file?.used !== copy || !fs.existsSync(copy) || imp.clip?.file !== copy || imp.slot !== s1) { failed++; console.log("!! live_import_audio should copy into Samples\\Imported and load the copy: " + JSON.stringify(imp)); }
  await expect("ok", "live_import_audio", { file: wav, track: bass, slot: s2 }, "The same file was already in the project");
  writeWav16(wav, new Float32Array(44100).fill(0.1)); // a different file with the same name
  const imp2 = js(await expect("ok", "live_import_audio", { file: wav, track: bass, slot: s3 }, "\"copied\": true"));
  if (!String(imp2.file?.used).endsWith(` (2).wav`)) { failed++; console.log("!! a different file with the same name should get (2): " + imp2.file?.used); }
  await expect("refused", "live_import_audio", { file: wav, track: bass, slot: vl }, "already has a clip");
  await expect("refused", "live_import_audio", { file: wav, track: keys, slot: 6 }, "is a MIDI track");
  await expect("refused", "live_import_audio", { file: wav, track: bass }, "Give slot");
  if (fs.readdirSync(path.join(project, "Samples", "Imported")).length !== 2) { failed++; console.log("!! a refused import must not leave a copy behind"); }
  await expect("ok", "live_revert", { steps: 3 }, "reverted");
  const empty = js(await expect("ok", "live_get_track", { track: bass }, "clips")).clips.map((c: any) => c.slot);
  if (empty.some((s: number) => [s1, s2, s3].includes(s))) { failed++; console.log("!! live_revert should take the imported clips out: " + empty); }
  // Arrangement: at a bar on an empty audio track; a second one on top is refused; an unsaved set isn't copied to.
  const at = js(await expect("ok", "live_create_audio_track", { name: "Imports" }, "track")).track;
  const ar = js(await expect("ok", "live_import_audio", { file: wav, track: at, bar: 3 }, "\"start_bar\": 3"));
  if (ar.clip?.end_bar !== 5) { failed++; console.log("!! the Arrangement import should run bars 3-5: " + JSON.stringify(ar.clip)); }
  await expect("refused", "live_import_audio", { file: wav, track: at, bar: 4 }, "never covers clips");
  // The WAV says 1 s (about 3 beats), so bar 2 passes the first check, but the stand-in makes an 8-beat clip that
  // covers the one at bar 3: the bridge must notice, undo it and say so. (The stand-in's undo changes nothing.)
  await expect("refused", "live_import_audio", { file: wav, track: at, bar: 2 }, "so it was undone");
  await fakeAsk("fake_set_path", { path: "" });
  await expect("ok", "live_import_audio", { file: wav, track: at, bar: 9 }, "never been saved");
  await fakeAsk("fake_set_path");
  await expect("ok", "live_revert", { steps: 3 }, "reverted"); // both clips, then the track
  if (js(await expect("ok", "live_status", {}, "tracks")).session.tracks.some((t: any) => t.name === "Imports")) { failed++; console.log("!! live_revert should take the Imports track back"); }

  // Convert to MIDI: a new MIDI track right after the audio track; live_revert deletes it while it's unchanged.
  const cv = js(await expect("ok", "live_convert_to_midi", { track: bass, slot: vl, kind: "melody" }, "new_tracks"));
  const nt = cv.new_tracks?.[0];
  if (nt?.track !== bass + 1 || nt?.name !== "Melody" || nt?.clips?.[0]?.notes !== 4 || !nt?.devices?.length) { failed++; console.log("!! live_convert_to_midi should report the new track with its notes: " + JSON.stringify(cv)); }
  await expect("ok", "live_revert", {}, "reverted");
  if (js(await expect("ok", "live_status", {}, "tracks")).session.tracks.some((t: any) => t.name === "Melody")) { failed++; console.log("!! live_revert should delete the converted track"); }
  const midiClip = (js(await expect("ok", "live_get_track", { track: keys }, "clips")).clips as any[]).find((c) => c.midi);
  if (midiClip) await expect("refused", "live_convert_to_midi", { track: keys, slot: midiClip.slot, kind: "harmony" }, "is MIDI");
  await expect("refused", "live_convert_to_midi", { track: bass, slot: vl, kind: "piano" }, "harmony, melody or drums");
  await expect("refused", "live_convert_to_midi", { track: bass, kind: "drums" }, "Give slot");

  // Quantize audio: Warp off is refused; warp markers move; live_revert puts the old ones back.
  await expect("refused", "live_quantize_audio", { track: bass, slot: vl, grid: "1/3" }, "grid is one of");
  await expect("refused", "live_quantize_audio", { track: bass, slot: vl, grid: "1/8", amount: 0 }, "percent, 1 to 100");
  await expect("ok", "live_set_audio_clip", { track: bass, slot: vl, warp: false }, "\"warp\": false");
  await expect("refused", "live_quantize_audio", { track: bass, slot: vl, grid: "1/8" }, "has Warp off");
  await expect("ok", "live_set_audio_clip", { track: bass, slot: vl, warp: true }, "\"warp\": true");
  const before = js(await expect("ok", "live_audio_clip_info", { clip: { track: bass, slot: vl } }, "warp_markers")).raw;
  const qz = js(await expect("ok", "live_quantize_audio", { track: bass, slot: vl, grid: "1/16", amount: 50 }, "\"changed\": true"));
  const given = (await fakeAsk("fake_quantized", { track: bass, slot: vl })).last_quantize;
  if (qz.warp_markers_after !== 3 || given?.[0] !== 5 || given?.[1] !== 0.5) { failed++; console.log("!! quantize should pass grid 1/16 (5) and 50 % (0.5) to Live: " + JSON.stringify({ qz, given })); }
  await expect("ok", "live_revert", {}, "reverted");
  const back = js(await expect("ok", "live_audio_clip_info", { clip: { track: bass, slot: vl } }, "warp_markers"));
  if (back.warp_markers !== 2 || JSON.stringify(back.raw.first_markers) !== JSON.stringify(before.first_markers)) { failed++; console.log("!! live_revert should put the old warp markers back: " + JSON.stringify(back.raw)); }
  // Again without move_warp_marker (Live 12.4.16 has it; an older Live may not): the first marker is swapped instead.
  await fakeAsk("fake_move_markers", { on: false });
  await expect("ok", "live_quantize_audio", { track: bass, slot: vl, grid: "1/8t", amount: 100 }, "\"changed\": true");
  await expect("ok", "live_revert", {}, "reverted");
  const back2 = js(await expect("ok", "live_audio_clip_info", { clip: { track: bass, slot: vl } }, "warp_markers"));
  if (back2.warp_markers !== 2 || JSON.stringify(back2.raw.first_markers) !== JSON.stringify(before.first_markers)) { failed++; console.log("!! live_revert (without move_warp_marker) should put the old warp markers back: " + JSON.stringify(back2.raw)); }
  await fakeAsk("fake_move_markers", { on: true });
  await expect("ok", "live_revert", { steps: 2 }, "reverted"); // Warp back as it was
  fs.rmSync(wav, { force: true });
}

// Live's menu bar (live_menu, live_save): a stand-in menu. Real Live is never touched here.
const item = (name: string, id: number, enabled = true) => ({ name, id, enabled, checked: false });
fs.writeFileSync(process.env.SECOND_CHAIR_LIVE_MENU!, JSON.stringify({ title: "my-song* - Ableton Live 12 Suite", version: "12.4.16", menus: [
  { name: "File", items: [item("New Live Set", 2070), item("Save Live Set", 2081), item("Save Live Set As...", 2082), item("Save a Copy...", 2083), item("Quit", 2091)] },
  { name: "Edit", items: [item("Consolidate", 2139)] },
  { name: "Create", items: [item("Separate Stems to New Audio Tracks", 2175, false)] },
  { name: "View", items: [item("Browser", 2229), item("Full Screen", 2200), { name: "Zoom", enabled: true, checked: false, items: [item("Zoom In", 2203)] }] }] }));
fs.writeFileSync(process.env.SECOND_CHAIR_LIVE_LOG!, "info: started\n");
fs.writeFileSync(path.join(MENU_DIR, "my-song.als"), "");
await expect("ok", "live_menu", { path: "view > browser" }, "\"fired\": \"View > Browser\"");
await expect("ok", "live_menu", { path: "View > Zoom > Zoom In" }, "Only the view changed");
await expect("refused", "live_menu", { path: "View > Browsr" }, "Close matches: \"View > Browser\"");
await expect("refused", "live_menu", { path: "File > Quit" }, "could lose work");
await expect("refused", "live_menu", { path: "File > New Live Set" }, "could lose work");
await expect("refused", "live_menu", { path: "View > Full Screen" }, "isn't on live_menu's list");
await expect("refused", "live_menu", { path: "Edit > Consolidate" }, "isn't on live_menu's list");
await expect("refused", "live_menu", { path: "Create > Separate Stems to New Audio Tracks" }, "greyed out");
await expect("refused", "live_menu", { path: "File > Save Live Set" }, "use live_save");
// The stand-in Live never clears its *, so live_save must fire Save, then say it didn't land and ask for Ctrl+S.
await expect("refused", "live_save", {}, "please press Ctrl+S");
// A message box appearing in Live's log stops the wait and is reported.
setTimeout(() => fs.appendFileSync(process.env.SECOND_CHAIR_LIVE_LOG!, "info: Message Box: The file could not be written.\n"), 500);
await expect("refused", "live_save", {}, "The file could not be written");
// Live 12.4.16 answered Save with its Save As window for a set copied from the default set (seen 2026-11-18).
const menuNow = JSON.parse(fs.readFileSync(process.env.SECOND_CHAIR_LIVE_MENU!, "utf8"));
fs.writeFileSync(process.env.SECOND_CHAIR_LIVE_MENU!, JSON.stringify({ ...menuNow, opens: { "File > Save Live Set": "Save Live Set As:", "File > Save a Copy...": "Save a Copy:" } }));
await expect("refused", "live_save", {}, "Live opened its Save As window");
await expect("refused", "live_save", {}, "already has \"Save Live Set As:\" open");
await expect("ok", "live_menu", { path: "File > Save a Copy" }, 'opened: \\"Save a Copy:');
const fired = fs.readFileSync(path.join(os.tmpdir(), `second-chair-test-${process.pid}`, "menu-fired.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).path);
if (fired.join("|") !== "View > Browser|View > Zoom > Zoom In|File > Save Live Set|File > Save Live Set|File > Save Live Set|File > Save a Copy...") { failed++; console.log("!! live_menu fired the wrong commands: " + fired.join(" | ")); }
// A set file last saved by an older Live: Save would open Save As, so live_save fires nothing and says why.
fs.writeFileSync(path.join(MENU_DIR, "my-song.als"), (await import("node:zlib")).gzipSync('<?xml version="1.0" encoding="UTF-8"?>\n<Ableton MajorVersion="5" MinorVersion="12.0_12117" Creator="Ableton Live 12.1d1">\n</Ableton>\n'));
await expect("refused", "live_save", {}, "last saved by Ableton Live 12.1d1");
fs.writeFileSync(process.env.SECOND_CHAIR_LIVE_MENU!, JSON.stringify({ window: false })); // like fake_live: no Live window
await expect("refused", "live_menu", { path: "View > Browser" }, "Live is not open");
await expect("refused", "live_save", {}, "Save didn't go through");
// Stem Separation (live_separate_stems, 0.13.0): a stand-in menu and Separate Stems window; fake_live plays the set.
// Real Live and its window are never touched here (the UIA part has its own check: test/separate_uia.ps1).
{
  const MENU = process.env.SECOND_CHAIR_LIVE_MENU!, UIA = process.env.SECOND_CHAIR_STEMS_UIA!;
  const stemMenu = (version = "12.4.16", windows: string[] = []) => fs.writeFileSync(MENU, JSON.stringify({ title: "my-song* - Ableton Live 12 Suite", version, windows,
    menus: [{ name: "Create", items: [item("Separate Stems to New Audio Tracks", 2231)] }, { name: "Navigate", items: [item("Session View", 2332)] }], opens: { "Create > Separate Stems to New Audio Tracks": "Separate Stems" } }));
  const stemWindow = (extra: Record<string, unknown> = {}) => fs.writeFileSync(UIA, JSON.stringify({ boxes: { vocals: true, drums: true, bass: true, others: true, merge: false, high: true }, pressed: [], ...extra }));
  const uiaNow = () => JSON.parse(fs.readFileSync(UIA, "utf8"));
  stemMenu(); stemWindow();
  await fakeAsk("fake_set_path", {});
  const st = js(await expect("ok", "live_status", {}, "\"session\""));
  const project = path.dirname(st.set.path), stemDir = path.join(project, "Samples", "Processed", "Stems");
  let src: { track: number; slot: number } | null = null, midi: { track: number; slot: number } | null = null;
  for (const t of st.session.tracks as any[]) {
    const tr = js((await rpc("tools/call", { name: "live_get_track", arguments: { track: t.index } })).result?.content?.[0]?.text ?? "{}");
    for (const c of tr.clips ?? []) { if (!c.midi && !src) src = { track: t.index, slot: c.slot }; if (c.midi && !midi) midi = { track: t.index, slot: c.slot }; }
  }
  if (!src || !midi) { failed++; console.log("!! the fake set should have an audio and a MIDI Session clip"); }
  else {
    await expect("refused", "live_separate_stems", { track: src.track }, "Give track and slot");
    await expect("refused", "live_separate_stems", { track: src.track, bar: 1 }, "Arrangement clips");
    await expect("refused", "live_separate_stems", { ...midi }, "is MIDI");
    await expect("refused", "live_separate_stems", { ...src, stems: ["guitar"] }, "Unknown stem");
    await fakeAsk("fake_set_path", { path: "" });
    await expect("refused", "live_separate_stems", { ...src }, "never been saved");
    await fakeAsk("fake_set_path", {});
    stemMenu("12.2.5");
    await expect("refused", "live_separate_stems", { ...src }, "12.3 or later");
    stemMenu("12.4.16", ["Export Audio/Video"]);
    await expect("refused", "live_separate_stems", { ...src }, "\"Export Audio/Video\" open");
    // A failed toggle: Cancel is pressed so nothing is left half set.
    stemMenu(); stemWindow({ fail: "toggle" });
    await expect("refused", "live_separate_stems", { ...src }, "Its Cancel was pressed");
    if (uiaNow().pressed.join() !== "Cancel") { failed++; console.log("!! a failed toggle should press Cancel and nothing else: " + uiaNow().pressed); }
    // The window already open (the user opened it): refused; then cancel presses its Cancel.
    stemWindow();
    await expect("ok", "live_menu", { path: "Create > Separate Stems to New Audio Tracks" }, "opened: \\\"Separate Stems");
    await expect("refused", "live_separate_stems", { ...src }, "already open");
    await expect("ok", "live_separate_stems", { action: "cancel" }, "\"pressed\": \"Cancel\"");
    await expect("ok", "live_separate_stems", { action: "cancel" }, "Nothing to cancel");
    if (uiaNow().pressed.join() !== "Cancel") { failed++; console.log("!! cancel should press Cancel once: " + uiaNow().pressed); }
    // A real start: three stems, fast, no merge.
    stemWindow();
    const tempo = js(await expect("ok", "live_status", {}, "\"tempo\"")).session.tempo;
    const go = js(await expect("ok", "live_separate_stems", { ...src, stems: ["vocals", "bass", "other"], quality: "fast" }, "\"started\": true"));
    const w = uiaNow();
    if (w.pressed.join() !== "Separate" || w.boxes.drums || w.boxes.high || !w.boxes.vocals || w.boxes.merge) { failed++; console.log("!! start should untick Drums and High Quality, then press Separate only: " + JSON.stringify(w)); }
    if (go.files_land_in !== stemDir || go.tempo_before !== tempo) { failed++; console.log("!! start should say where the files land and the tempo before: " + JSON.stringify(go)); }
    await expect("refused", "live_separate_stems", { ...src }, "isn't finished yet");
    const c1 = js(await expect("ok", "live_separate_stems", { action: "check" }, "\"running\": true"));
    if (c1.files !== "none yet" || (c1.waiting_for ?? []).join() !== "Vocals,Bass,Others") { failed++; console.log("!! the first check should have no files yet: " + JSON.stringify(c1)); }
    await expect("ok", "live_status", {}, "\"stem_separation\"");
    // Live's part: the stem files, the group track, and its tempo guess.
    fs.mkdirSync(stemDir, { recursive: true });
    const parts = synthStems(92, 4), made: Record<string, string> = {};
    for (const [k, label] of [["vocals", "Vocals"], ["bass", "Bass"], ["others", "Others"]]) {
      made[k] = path.join(stemDir, `vocal loop [2026-11-18 101500] (${label}).wav`);
      writeWav16(made[k], (parts as any)[k]);
    }
    const c2 = js(await expect("ok", "live_separate_stems", { action: "check" }, "\"running\": true"));
    if (c2.files?.length !== 3 || c2.waiting_for) { failed++; console.log("!! the second check should see three files: " + JSON.stringify(c2)); }
    const g = (await fakeAsk("fake_stem_group", { files: made, song: "vocal loop" })).group;
    await fakeAsk("fake_user_tempo", { bpm: 139.53 });
    const done = js(await expect("ok", "live_separate_stems", { action: "check" }, "\"done\": true"));
    if (done.group?.track !== g || done.group?.stems?.length !== 3 || !done.tempo?.changed || done.tempo?.before !== tempo || !/song_analyze \{stems: \d+\}/.test(done.next)) { failed++; console.log("!! the done check should give the group, the tempo change and the song_analyze hint: " + JSON.stringify(done)); }
    if (!/Don't set it back without asking/.test(done.tempo?.note ?? "")) { failed++; console.log("!! a tempo change should say: offer, don't set it back without asking"); }
    const sa = js(await expect("ok", "song_analyze", { stems: done.group.track }, "\"stem_group\""));
    if (Object.keys(sa.stem_group?.stems ?? {}).length !== 3) { failed++; console.log("!! song_analyze should read the three stems from the group check gave: " + JSON.stringify(sa.stem_group)); }
    await expect("ok", "live_separate_stems", { action: "check" }, "\"checked_again\": true");
    await fakeAsk("fake_user_tempo", { bpm: tempo });
    fs.rmSync(path.join(project, "Samples", "Processed"), { recursive: true, force: true });
  }
}
// File pickers (live_file_dialog and live_save with path, 0.14.0): a stand-in menu and picker. Real Live and its
// pickers are never touched here (the Windows part has its own check: test/filedialog_uia.ps1).
{
  const MENU = process.env.SECOND_CHAIR_LIVE_MENU!, PICK = process.env.SECOND_CHAIR_FILE_DIALOG!;
  const dir = path.join(MENU_DIR, "Song Project"); fs.mkdirSync(dir, { recursive: true });
  const at = (f: string) => path.join(dir, f);
  fs.writeFileSync(MENU, JSON.stringify({ title: "my-song* - Ableton Live 12 Suite", version: "12.4.16", windows: [],
    menus: [{ name: "File", items: [item("Save Live Set", 2081), item("Save Live Set As...", 2082), item("Save a Copy...", 2083)] }],
    opens: { "File > Save Live Set As...": "Save Live Set As:", "File > Save a Copy...": "Save a Copy:" } }));
  const pick = (extra: Record<string, unknown> = {}) => fs.writeFileSync(PICK, JSON.stringify({ kind: "save", title: "Save a Copy:", folder: dir, file_type: "Live Set (*.als)", pressed: [], ...extra }));
  const pressed = () => JSON.parse(fs.readFileSync(PICK, "utf8")).pressed as string[];
  pick();
  await expect("ok", "live_file_dialog", {}, "\"open\": false");
  await expect("refused", "live_file_dialog", { action: "fill", path: at("a.als") }, "nothing to fill");
  await expect("ok", "live_menu", { path: "File > Save a Copy" }, 'opened: \\"Save a Copy:');
  await expect("ok", "live_file_dialog", {}, "\"kind\": \"save\"");
  await expect("refused", "live_file_dialog", { path: "Song.als" }, "isn't a full path");
  await expect("refused", "live_file_dialog", { path: at("a?.als") }, "characters Windows doesn't allow");
  await expect("refused", "live_file_dialog", { path: path.join(process.env.SystemRoot || "C:\\Windows", "x.als") }, "system folder");
  await expect("refused", "live_file_dialog", { path: path.join(dir, "nope", "a.als") }, "doesn't exist");
  await expect("refused", "live_file_dialog", { path: at("a.wav") }, "saves Live Set (*.als)");
  fs.writeFileSync(at("exists.als"), "old");
  await expect("refused", "live_file_dialog", { path: at("exists.als") }, "already exists");
  if (pressed().length) { failed++; console.log("!! refusals must press nothing: " + pressed()); }
  const saved = js(await expect("ok", "live_file_dialog", { path: at("copy.als") }, "\"done\": true"));
  if (saved.file !== at("copy.als") || !fs.existsSync(at("copy.als")) || pressed().join() !== "Save " + at("copy.als")) { failed++; console.log("!! fill should press Save once and find the file: " + JSON.stringify(saved) + " " + pressed()); }
  await expect("ok", "live_file_dialog", {}, "\"open\": false");
  await expect("ok", "live_file_dialog", { action: "check", path: at("copy.als") }, "\"exists\": true");
  await expect("ok", "live_file_dialog", { action: "check", path: at("later.wav") }, "\"exists\": false");
  // Replace only when asked.
  await expect("ok", "live_menu", { path: "File > Save a Copy" }, "Save a Copy:");
  await expect("ok", "live_file_dialog", { path: at("exists.als"), replace: true }, "\"replaced\": true");
  // Cancel.
  await expect("ok", "live_menu", { path: "File > Save a Copy" }, "Save a Copy:");
  await expect("ok", "live_file_dialog", { action: "cancel" }, "\"pressed\": \"Cancel\"");
  await expect("ok", "live_file_dialog", { action: "cancel" }, "Nothing to cancel");
  // An Open picker (Import): the file must exist.
  pick({ kind: "open", title: "Import Audio/MIDI File", file_type: "Audio files (*.wav;*.aif)", open: true });
  await expect("ok", "live_file_dialog", {}, "\"kind\": \"open\"");
  await expect("refused", "live_file_dialog", { path: at("kick.wav") }, "no file at");
  fs.writeFileSync(at("kick.wav"), "RIFF");
  await expect("ok", "live_file_dialog", { path: at("kick.wav") }, "Live is opening the file");
  // live_save with path: Save As for a new, Untitled set.
  pick({ title: "Save Live Set As:" });
  await fakeAsk("fake_set_path", { path: "" });
  await expect("refused", "live_save", { path: at("New.wav") }, "saved as .als");
  await expect("refused", "live_save", { path: at("exists.als") }, "already exists");
  const sa = js(await expect("ok", "live_save", { path: at("New Song.als") }, "\"fired\": \"File > Save Live Set As\""));
  if (sa.file !== at("New Song.als") || !sa.done) { failed++; console.log("!! live_save with path should save through the picker: " + JSON.stringify(sa)); }
  await fakeAsk("fake_set_path", {});
}
// Export without the screen (live_export, 0.15.0): a stand-in menu, Export window and save picker. Real Live is never
// touched here (the Windows part has its own check: test/livewindow_uia.ps1).
{
  const MENU = process.env.SECOND_CHAIR_LIVE_MENU!, WIN = process.env.SECOND_CHAIR_LIVE_WINDOW!, PICK = process.env.SECOND_CHAIR_FILE_DIALOG!;
  const dir = path.join(MENU_DIR, "Bounces"); fs.mkdirSync(dir, { recursive: true });
  const at = (f: string) => path.join(dir, f);
  fs.writeFileSync(MENU, JSON.stringify({ title: "my-song - Ableton Live 12 Suite", version: "12.4.16", windows: [],
    menus: [{ name: "File", items: [item("Export Audio/Video...", 2088)] }], opens: { "File > Export Audio/Video...": "Export Audio/Video" } }));
  const ctl = (type: string, name: string, value?: string, enabled = true) => ({ type, name, enabled, ...(value !== undefined ? { value } : {}) });
  const exportWindow = (len = ["8", "0", "0"], extra: Record<string, unknown> = {}) => fs.writeFileSync(WIN, JSON.stringify({ pressed: [], picker_title: "Save Export:", controls: [
    ctl("ComboBox", "Rendered Track Chooser", "Main"),
    ctl("Slider", "Start of Rendered Audio File (Bar)", "1"), ctl("Slider", "Start of Rendered Audio File (Beat)", "1"), ctl("Slider", "Start of Rendered Audio File (Sixteenths)", "1"),
    ctl("Slider", "Length of Rendered Audio File (Bar)", len[0]), ctl("Slider", "Length of Rendered Audio File (Beat)", len[1]), ctl("Slider", "Length of Rendered Audio File (Sixteenths)", len[2]),
    ctl("ComboBox", "Sample Rate", "48000"), ctl("ComboBox", "File Type", "WAV"), ctl("ComboBox", "Recording Bit Depth", "24"),
    ctl("Button", "Normalize", "Off"), ctl("Button", "Encode PCM", "On"), ctl("Button", "Encode MP3", "Off"),
    ctl("Button", "Export"), ctl("Button", "Cancel")], ...extra }));
  const pressedWin = () => JSON.parse(fs.readFileSync(WIN, "utf8")).pressed as string[];
  fs.writeFileSync(PICK, JSON.stringify({ kind: "save", title: "Save Export:", folder: dir, file_type: "WAV (*.wav)", pressed: [] }));
  exportWindow();
  const r = js(await expect("ok", "live_export", {}, "\"length\": \"8.0.0\""));
  if (r.closed_again !== true || pressedWin().join() !== "Cancel" || r.settings?.file_type !== "WAV" || r.settings?.options?.Normalize !== false) { failed++; console.log("!! read should report the settings and close the window it opened: " + JSON.stringify(r) + " " + pressedWin()); }
  exportWindow();
  await expect("refused", "live_export", { path: at("mix.mp3") }, "writes .wav");
  if (pressedWin().join() !== "Cancel") { failed++; console.log("!! a wrong file type should press only Cancel: " + pressedWin()); }
  fs.writeFileSync(at("old.wav"), "old");
  exportWindow();
  await expect("refused", "live_export", { path: at("old.wav") }, "already exists");
  if (pressedWin().length) { failed++; console.log("!! an existing file should be refused before anything is pressed: " + pressedWin()); }
  exportWindow(["0", "0", "0"]);
  await expect("refused", "live_export", { path: at("mix.wav") }, "render length is 0");
  exportWindow([], { unreadable: true });
  fs.writeFileSync(MENU, JSON.stringify({ ...JSON.parse(fs.readFileSync(MENU, "utf8")), windows: ["Export Audio/Video"] }));
  await expect("refused", "live_export", { path: at("mix.wav") }, "doesn't show what's inside it");
  fs.writeFileSync(MENU, JSON.stringify({ ...JSON.parse(fs.readFileSync(MENU, "utf8")), windows: [] }));
  exportWindow();
  const ex = js(await expect("ok", "live_export", { path: at("mix.wav") }, "\"pressed\": \"Export\""));
  if (pressedWin().join() !== "Export" || !fs.existsSync(at("mix.wav")) || ex.save?.file !== at("mix.wav") || !/audio_analyze/.test(ex.next ?? "")) { failed++; console.log("!! export should press Export, fill the picker and find the file: " + JSON.stringify(ex) + " " + pressedWin()); }
  exportWindow();
  await expect("ok", "live_export", { keep_open: true }, "The window is open in Live");
  await expect("ok", "live_export", { action: "cancel" }, "\"pressed\": \"Cancel\"");
  await expect("ok", "live_export", { action: "cancel" }, "Nothing to cancel");
}
fs.rmSync(MENU_DIR, { recursive: true, force: true });

// a client without the token must be refused by the bridge itself
await new Promise<void>((res) => {
  const s = net.createConnection({ host: "127.0.0.1", port: Number(process.env.SECOND_CHAIR_PORT || 9885) }, () => s.write(JSON.stringify({ id: 1, token: "wrong", action: "get_session" }) + "\n"));
  s.on("data", (d) => { console.log("\n# wrong token ->", d.toString().trim()); s.destroy(); res(); });
});
server.stdin.end();
console.log(failed ? `\n${failed} browser check(s) FAILED` : "\nAll browser checks passed.");
process.exitCode = failed ? 1 : 0;
