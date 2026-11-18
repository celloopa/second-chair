// Checks song_analyze's maths without Live: the made-up G minor loop at 92 BPM must come back as G minor at 92.
//   node live-bridge/test/song_analyze.ts            (the loop)
//   node live-bridge/test/song_analyze.ts <file.wav>  (prints the full report for any WAV; checks nothing)
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { analyzeSong } from "../mcp/songanalysis.ts";
import { synthLoop, writeWav16 } from "./song_loop.ts";

if (process.argv[2]) {
  console.log(JSON.stringify(analyzeSong(process.argv[2]), null, 2));
} else {
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
  console.log(failed ? `\n${failed} song_analyze check(s) FAILED` : "\nAll song_analyze checks passed.");
  process.exitCode = failed ? 1 : 0;
}
