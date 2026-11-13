// Finds where notes start in an audio file (WAV), for lining one take up with another (live_align_audio).
// No dependencies: a small WAV reader and an energy-rise detector. Good for clear starts (consonants, plucks,
// drums); soft, slurred starts are missed, which is the safe way to fail (a missed start is left where it is).
import fs from "node:fs";

export type Audio = { rate: number; mono: Float32Array; channels: Float32Array[]; seconds: number };

export function readWav(file: string): Audio {
  const b = fs.readFileSync(file);
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${file} isn't a WAV file. Only WAV takes can be lined up (Live records WAV unless set to AIFF).`);
  }
  let pos = 12, fmt: { tag: number; channels: number; rate: number; bits: number } | null = null;
  while (pos + 8 <= b.length) {
    const id = b.toString("ascii", pos, pos + 4), size = b.readUInt32LE(pos + 4), at = pos + 8;
    if (id === "fmt ") {
      let tag = b.readUInt16LE(at);
      if (tag === 0xfffe && size >= 26) tag = b.readUInt16LE(at + 24); // WAVE_FORMAT_EXTENSIBLE: the real format
      fmt = { tag, channels: b.readUInt16LE(at + 2), rate: b.readUInt32LE(at + 4), bits: b.readUInt16LE(at + 14) };
    } else if (id === "data") {
      if (!fmt) break;
      const { tag, channels, rate, bits } = fmt;
      const bytes = bits / 8, frames = Math.floor(Math.min(size, b.length - at) / (bytes * channels));
      if (!(tag === 1 && [16, 24, 32].includes(bits)) && !(tag === 3 && bits === 32)) throw new Error(`${file}: this WAV format (${bits}-bit, type ${tag}) isn't supported.`);
      const mono = new Float32Array(frames);
      const chans = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const o = at + (i * channels + c) * bytes;
          const v = tag === 3 ? b.readFloatLE(o) : bits === 16 ? b.readInt16LE(o) / 32768 : bits === 24 ? b.readIntLE(o, 3) / 8388608 : b.readInt32LE(o) / 2147483648;
          chans[c][i] = v; sum += v;
        }
        mono[i] = sum / channels;
      }
      return { rate, mono, channels: chans, seconds: frames / rate };
    }
    pos = at + size + (size % 2);
  }
  throw new Error(`${file}: couldn't find the audio data in this WAV file.`);
}

/** Note starts, in seconds from the start of the file. sensitivity 0-100: higher finds softer starts. */
export function findOnsets(a: Audio, sensitivity = 50): number[] {
  const { rate, mono } = a;
  const hop = Math.max(1, Math.round(rate * 0.005)), win = hop * 2;
  const n = Math.floor((mono.length - win) / hop);
  if (n < 8) return [];
  const db = new Float32Array(n);
  let top = -200;
  for (let k = 0; k < n; k++) {
    let e = 0;
    for (let i = k * hop, end = i + win; i < end; i++) e += mono[i] * mono[i];
    db[k] = 10 * Math.log10(e / win + 1e-12);
    if (db[k] > top) top = db[k];
  }
  const s = Math.max(0, Math.min(100, sensitivity));
  const rise = 18 - 0.14 * s;   // dB the level must jump within 15 ms: 18 (only hard hits) down to 4
  const gate = top - (30 + 0.3 * s); // ignore starts quieter than this
  const minGap = Math.round(0.09 * rate);
  const out: number[] = [];
  let last = -minGap;
  for (let k = 3; k < n; k++) {
    if (db[k] < gate || db[k] - Math.min(db[k - 1], db[k - 2], db[k - 3]) < rise) continue;
    // the exact start: the first sample, a little before this frame, that reaches a quarter of the local peak
    const from = Math.max(0, (k - 4) * hop), to = Math.min(mono.length, (k + 6) * hop);
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(mono[i]));
    let at = k * hop;
    for (let i = from; i < to; i++) if (Math.abs(mono[i]) >= peak * 0.25) { at = i; break; }
    if (at - last < minGap) continue;
    out.push(at / rate);
    last = at;
  }
  return out;
}
