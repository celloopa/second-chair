// Drives the second-chair MCP server over stdio like Claude or HeyClicky would, and prints each result.
import { spawn } from "node:child_process";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";

// Live's tags come from a small stand-in tag file, so results don't depend on which packs are installed.
const STUDIO_FILE = path.join(os.tmpdir(), `second-chair-studio-test-${process.pid}.md`);
const server = spawn(process.execPath, [path.join(import.meta.dirname, "..", "mcp", "server.ts")], { stdio: ["pipe", "pipe", "inherit"],
  // Saved pad swaps go to a fresh temp folder, never the user's real ~/SecondChair/pad-swaps.jsonl.
  env: { ...process.env, SECOND_CHAIR_STUDIO_FILE: STUDIO_FILE, SECOND_CHAIR_PLUGINS_FILE: STUDIO_FILE.replace(/\.md$/, "-plugins.md"), SECOND_CHAIR_SAMPLE_DIRS: os.tmpdir(), SECOND_CHAIR_LIVE_TITLE: "being-dumb* - Ableton Live 12 Suite", SECOND_CHAIR_ABLETON_LIBRARIES: path.join(import.meta.dirname, "fixtures"),
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
for (const [title, want, warn] of [["being-dumb* - Ableton Live 12 Suite", "being-dumb", false], ["Untitled - Ableton Live 12 Suite", "Untitled", true]] as const) {
  const { parseTitle } = await import("../mcp/liveset.ts");
  const r = parseTitle(title) as any;
  if (r.name !== want || !!r.warning !== warn || (want === "being-dumb" && !r.unsaved)) { failed++; console.log(`!! set title "${title}" read as ${JSON.stringify(r)}`); }
}
if (!/"set": \{\s*"name": "being-dumb",\s*"unsaved": true/.test(status.result?.content?.[0]?.text ?? "")) { failed++; console.log("!! live_status should report the open set"); }
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

// a client without the token must be refused by the bridge itself
await new Promise<void>((res) => {
  const s = net.createConnection({ host: "127.0.0.1", port: Number(process.env.SECOND_CHAIR_PORT || 9885) }, () => s.write(JSON.stringify({ id: 1, token: "wrong", action: "get_session" }) + "\n"));
  s.on("data", (d) => { console.log("\n# wrong token ->", d.toString().trim()); s.destroy(); res(); });
});
server.stdin.end();
console.log(failed ? `\n${failed} browser check(s) FAILED` : "\nAll browser checks passed.");
process.exitCode = failed ? 1 : 0;
