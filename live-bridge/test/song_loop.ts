// A made-up loop for testing song_analyze without Live: G minor at 92 BPM, Gm - Eb - Cm - D, one chord per bar,
// kick on 1 and 3, a clap on 2 and 4, hats on the eighths. The same loop the key_tempo.py self-test used.
// Written as a 16-bit, 44.1 kHz mono WAV, so the test also runs the resampler.
import fs from "node:fs";

/** Seeded random numbers, so the loop is the same on every run (mulberry32, Box-Muller for the normal ones). */
function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

export function synthLoop(bpm = 92, bars = 24, rate = 44100, seed = 1, drums = true): Float32Array {
  const normal = rng(seed), beat = 60 / bpm;
  const x = new Float64Array(Math.floor(rate * beat * 4 * bars) + rate);
  const tone = (midi: number, start: number, dur: number, gain: number, harm = 6) => {
    const s = Math.floor(start * rate), L = Math.floor(dur * rate), f = 440 * Math.pow(2, (midi - 69) / 12);
    for (let i = 0; i < L && s + i < x.length; i++) {
      const t = i / rate, env = Math.min(1, t / 0.01) * Math.exp(-t * 1.5);
      let y = 0;
      for (let h = 1; h <= harm && f * h < 11025; h++) y += Math.sin(2 * Math.PI * f * h * t) / h;
      x[s + i] += gain * env * y;
    }
  };
  const prog: [number, boolean][] = [[7, true], [3, false], [0, true], [2, false]]; // G minor, E flat, C minor, D
  for (let bar = 0; bar < bars; bar++) {
    const [r, minor] = prog[bar % 4], start = bar * 4 * beat;
    for (const iv of [0, minor ? 3 : 4, 7]) tone(55 + ((r + iv - 7) % 12 + 12) % 12, start, 4 * beat, 0.15);
    const bass = 31 + ((r - 7) % 12 + 12) % 12;
    tone(bass, start, 2 * beat, 0.5, 3);
    tone(bass, start + 2 * beat, 2 * beat, 0.4, 3);
    for (let b = 0; b < 4 && drums; b++) {
      const s = Math.floor((start + b * beat) * rate), L = Math.floor(0.3 * rate);
      let prev = 0;
      for (let i = 0; i < L && s + i < x.length; i++) {
        const t = i / rate;
        if (b % 2 === 0) x[s + i] += 0.9 * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 12); // kick
        else { const n = normal(); x[s + i] += 0.25 * (n - prev) * Math.exp(-t * 20); prev = n; } // clap
      }
      for (const e of [0, 0.5]) { // hats
        const s2 = Math.floor((start + (b + e) * beat) * rate), L2 = Math.floor(0.05 * rate);
        let p1 = 0, p2 = 0;
        for (let i = 0; i < L2 && s2 + i < x.length; i++) {
          const n = normal(), d1 = n - p1, d2 = d1 - p2; p1 = n; p2 = d1;
          x[s2 + i] += 0.05 * d2 * Math.exp(-i / rate * 80);
        }
      }
    }
  }
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  return Float32Array.from(x, (v) => v / peak);
}

export function writeWav16(file: string, x: Float32Array, rate = 44100) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + x.length * 2, 4); b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii"); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii"); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, b);
}
