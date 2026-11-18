// Checks song_analyze's maths without Live: the made-up G minor loop at 92 BPM must come back as G minor at 92.
// Then its stem reading (stems.ts) on made-up stems: a chord pad, a bass line, a voice-like melody that leans the
// relative major, and drums that are near silent, a backbeat, or half time.
//   node live-bridge/test/song_analyze.ts            (the loop and the stems)
//   node live-bridge/test/song_analyze.ts <file.wav>  (prints the full report for any WAV; checks nothing)
//   node live-bridge/test/song_analyze.ts --stems <folder or vocals.wav drums.wav bass.wav others.wav>
//        (prints the stem report; a folder is searched for "(Vocals)", "(Drums)", "(Bass)" and "(Others)" WAVs)
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { analyzeSong, resample, SR } from "../mcp/songanalysis.ts";
import { analyzeStems, drumFeel, STEM_NAMES, type StemFiles } from "../mcp/stems.ts";
import { synthLoop, synthStems, writeWav16 } from "./song_loop.ts";

if (process.argv[2] === "--stems") {
  const args = process.argv.slice(3), files: StemFiles = {};
  const list = args.length === 1 && fs.statSync(args[0]).isDirectory() ? fs.readdirSync(args[0]).filter((f) => f.toLowerCase().endsWith(".wav")).map((f) => path.join(args[0], f)) : args;
  for (const f of list) { const k = STEM_NAMES.find((n) => path.basename(f).toLowerCase().includes(`(${n})`)) ?? STEM_NAMES[list.indexOf(f)]; if (k && !files[k]) files[k] = f; }
  console.log(JSON.stringify(analyzeStems(files), (k, v) => (k === "full_mix" ? { key: v.key?.best, tempo: v.tempo?.bpm, summary: undefined } : v), 2));
} else if (process.argv[2]) {
  console.log(JSON.stringify(analyzeSong(process.argv[2]), null, 2));
} else {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const file = path.join(os.tmpdir(), `second-chair-song-loop-${process.pid}.wav`);
  writeWav16(file, synthLoop());
  const r = analyzeSong(file) as any;
  fs.rmSync(file, { force: true });
  let failed = 0;
  const check = (what: string, ok: boolean, got: unknown) => { if (!ok) { failed++; console.log(`!! ${what}: got ${JSON.stringify(got)}`); } else console.log(`ok ${what}: ${JSON.stringify(got)}`); };
  check("key is G minor", r.key.best === "G minor", r.key.best);
  check("relative key is B♭ major", r.key.relative.key === "B♭ major", r.key.relative.key);
  check("scale notes", r.key.notes.join(" ") === "G A B♭ C D E♭ F", r.key.notes);
  check("tempo is 92 BPM", Math.abs(r.tempo.bpm - 92) < 0.25, r.tempo.bpm);
  check("half is about 46", Math.abs(r.tempo.half.bpm - 46) < 0.5, r.tempo.half.bpm);
  check("double is about 184", Math.abs(r.tempo.double.bpm - 184) < 1, r.tempo.double.bpm);
  check("tuning within 3 cents of A440", Math.abs(r.tuning.cents_from_a440) <= 3, r.tuning.cents_from_a440);
  check("kick on 1 and 3", /^X . . . \| \S . . . \| X/.test(r.drum_map.kick) || /^\S . . . \| X . . . \| \S . . . \| X/.test(r.drum_map.kick), r.drum_map.kick);
  const common = r.bass_per_bar.most_common.slice(0, 4).map((s: string) => s.split(" ")[0]).sort().join(" ");
  check("bass notes are G, E♭, C and D", common === "C D E♭ G", r.bass_per_bar.most_common);
  check("short pattern is whole beats", r.repeat.short_pattern?.candidates.some((c: any) => c.whole_beats), r.repeat.short_pattern?.beats_at_tempo);
  check("chord cycle is 16 beats (Gm Eb Cm D, a bar each)", r.repeat.chord_cycle?.beats === 16, r.repeat.chord_cycle);
  check("bass cycle is 16 beats", r.repeat.bass_cycle?.beats === 16, r.repeat.bass_cycle?.beats);
  check("drum map is drawn (the loop has a kick)", !r.drum_map.no_clear_drums && typeof r.drum_map.kick === "string", r.drum_map.kick_hits_db);
  check("loudness included", typeof r.loudness_and_tone.integrated_lufs === "number", r.loudness_and_tone.integrated_lufs);
  console.log(`took ${r.took_seconds} s for ${r.seconds} s of audio`);
  // the same chords and bass with no drums: no drum map, and still G minor
  writeWav16(file, synthLoop(92, 24, 44100, 1, false));
  const nd = analyzeSong(file) as any;
  fs.rmSync(file, { force: true });
  check("no drums: says no clear drums", nd.drum_map.no_clear_drums === true, nd.drum_map.kick_hits_db);
  check("no drums: still G minor", nd.key.best === "G minor", nd.key.best);

  // ---- stems: G minor chords, a melody leaning B♭ major (F3 to F4, most time on B♭3), bass G1 E♭2 C2 D2, no drums
  const parts = synthStems(92, 16);
  const files = Object.fromEntries(Object.entries(parts).map(([k, x]) => { const f = path.join(os.tmpdir(), `second-chair-stem-${process.pid}-${k}.wav`); writeWav16(f, x); return [k, f]; }));
  const st = analyzeStems(files) as any;
  for (const f of Object.values(files)) fs.rmSync(f, { force: true });
  check("stems: drums near silent", st.levels.drums.near_silent === true && st.levels.drums.rms_dbfs < -70, st.levels.drums);
  check("stems: the other three play", ["vocals", "bass", "others"].every((n) => !st.levels[n].near_silent && st.levels[n].plays_share > 0.9), Object.fromEntries(["vocals", "bass", "others"].map((n) => [n, st.levels[n].rms_dbfs])));
  check("stems: says no drums", st.summary.some((l: string) => l.startsWith("No drums")) && st.tempo.feel.no_drums === true, st.summary[2]);
  check("stems: tempo 92 from the other stems", Math.abs(st.tempo.bpm - 92) < 0.25, st.tempo.bpm);
  check("stems: the chords lean G minor", st.key.harmony.best === "G minor", st.key.harmony.best);
  check("stems: the melody leans B♭ major", st.key.melody.best === "B♭ major", st.key.melody.best);
  check("stems: both leanings reported, as relative keys", /G minor/.test(st.key.reading) && /B♭ major/.test(st.key.reading) && /relative keys/.test(st.key.reading), st.key.reading);
  check("stems: vocal held notes F3 to F4", st.vocals.held_range === "F3 (Live F2) to F4 (Live F3)", st.vocals.held_range);
  check("stems: most vocal time on B♭3", st.vocals.most_time[0].startsWith("B♭3 (Live B♭2)"), st.vocals.most_time[0]);
  check("stems: usual zone A3 to F4", st.vocals.usual_zone_10_to_90 === "A3 (Live A2) to F4 (Live F3)", st.vocals.usual_zone_10_to_90);
  check("stems: bass pattern G1 E♭2 C2 D2, 4 times", st.bass.pattern === "G1 → E♭2 → C2 → D2, 4 times", st.bass.pattern);
  check("stems: bass plays the whole loop", st.bass.plays.length === 1 && st.bass.plays[0].startsWith("0:00"), st.bass.plays);
  const loopChords = String(st.chords?.loop?.chords ?? "").split(" → ").map((c: string) => c.split(" ")[0]);
  check("stems: chord loop Gm E♭ Cm D, 16 beats", st.chords?.loop?.beats === 16 && loopChords.length === 4 && ["Gm", "E♭", "Cm", "D"].every((c) => loopChords.includes(c)), st.chords?.loop?.chords);
  const opts = st.keys_for_singer?.options ?? [], opt = (s: number) => opts.find((o: any) => o.move_semitones === s);
  check("stems: keys for the singer include now, one down and one up", [0, -1, 1].every((s) => opt(s)) && opts.length <= 5, opts.map((o: any) => o.move_semitones));
  check("stems: the key now is G minor, melody mostly on B♭3", /^G minor/.test(opt(0)?.key) && /mostly on B♭3/.test(opt(0)?.melody_would_sit), opt(0));
  check("stems: one up is G♯ minor, melody mostly on B3", /^G♯ minor/.test(opt(1)?.key) && /mostly on B3/.test(opt(1)?.melody_would_sit), opt(1));
  check("stems: says stems leak", /leak/i.test(st.vocals.leaks) && /leak/i.test(st.leaks), st.leaks);
  console.log(`stems took ${st.took_seconds} s for 4 x ${r1(parts.vocals.length / 44100)} s`);

  // ---- drums: the felt tempo from where the snare lands
  const feelOf = (bpm: number, kind: "backbeat" | "halftime") => drumFeel(resample(synthStems(bpm, 12, 44100, kind).drums, SR, 44100));
  const bb = feelOf(92, "backbeat"), ht = feelOf(140, "halftime"), b140 = feelOf(140, "backbeat");
  check("drums: backbeat at 92 feels like 92", bb.clear && Math.abs((bb.felt_bpm ?? 0) - 92) < 0.5, { felt: bb.felt_bpm, pulse: bb.pulse_bpm });
  check("drums: backbeat at 92 maps kick on 1 and 9, snare on 5 and 13", bb.steps.kick.join() === "1,9" && bb.steps.snare.join() === "5,13", bb.steps);
  check("drums: half time at 140 feels like 70", ht.clear && Math.abs((ht.felt_bpm ?? 0) - 70) < 0.5, { felt: ht.felt_bpm, pulse: ht.pulse_bpm });
  check("drums: backbeat at 140 feels like 140", b140.clear && Math.abs((b140.felt_bpm ?? 0) - 140) < 0.5, { felt: b140.felt_bpm, pulse: b140.pulse_bpm });

  console.log(failed ? `\n${failed} song_analyze check(s) FAILED` : "\nAll song_analyze checks passed.");
  process.exitCode = failed ? 1 : 0;
}
