// Measures an audio file the way a mastering meter does, so Claude has numbers where it has no ears:
// loudness (LUFS, ITU-R BS.1770-4 / EBU R 128), true peak, loudness range, crest factor, tone balance by band,
// and stereo width. No dependencies. WAV only (see onsets.ts).
import { readWav } from "./onsets.ts";

export type Analysis = {
  file: string; seconds: number; sample_rate: number; channels: number;
  integrated_lufs: number | null; loudness_range_lu: number | null; loudest_3s_lufs: number | null;
  true_peak_db: number; sample_peak_db: number; rms_db: number; crest_db: number; clipped_samples: number;
  bands_db: Record<string, number>; stereo: { correlation: number; side_vs_mid_db: number } | null;
};

const db = (x: number) => (x > 0 ? 10 * Math.log10(x) : -200);
const r1 = (x: number) => Math.round(x * 10) / 10;

/** The two K-weighting filters of BS.1770, made for this sample rate. */
function kWeight(x: Float32Array, rate: number): Float32Array {
  const stage = (inp: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number) => {
    const out = new Float32Array(inp.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < inp.length; i++) {
      const x0 = inp[i], y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0; out[i] = y0;
    }
    return out;
  };
  // high shelf (+4 dB above about 1.7 kHz: the head's effect)
  let K = Math.tan(Math.PI * 1681.974450955533 / rate), Q = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const y = stage(x, (Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
  // high pass (about 38 Hz)
  K = Math.tan(Math.PI * 38.13547087602444 / rate); Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  return stage(y, 1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
}

/** Mean-square per block (summed over channels), for blocks of `len` seconds stepping by `step`. */
function blocks(weighted: Float32Array[], rate: number, len: number, step: number): number[] {
  const n = Math.round(len * rate), hop = Math.round(step * rate), total = weighted[0].length;
  const out: number[] = [];
  for (let at = 0; at + n <= total; at += hop) {
    let sum = 0;
    for (const ch of weighted) { let e = 0; for (let i = at; i < at + n; i++) e += ch[i] * ch[i]; sum += e / n; }
    out.push(sum);
  }
  return out;
}
const lufs = (ms: number) => -0.691 + db(ms);
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;

/** Highest level between the samples too (4x), checked near the loudest samples. */
function truePeak(channels: Float32Array[], samplePeak: number): number {
  const taps = 12, phases = [0.25, 0.5, 0.75];
  const kernels = phases.map((f) => {
    const k = new Float32Array(taps * 2);
    for (let j = 0; j < taps * 2; j++) {
      const t = j - taps + 1 - f; // distance in samples from the point between x[i] and x[i+1]
      const w = 0.5 + 0.5 * Math.cos(Math.PI * t / taps); // Hann window over the sinc
      k[j] = (Math.abs(t) < 1e-9 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * w;
    }
    return k;
  });
  let peak = samplePeak;
  const near = samplePeak * 0.7;
  for (const x of channels) {
    for (let i = taps; i < x.length - taps - 1; i++) {
      if (Math.abs(x[i]) < near && Math.abs(x[i + 1]) < near) continue;
      for (const k of kernels) {
        let v = 0;
        for (let j = 0; j < taps * 2; j++) v += x[i - taps + 1 + j] * k[j];
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
    }
  }
  return peak;
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

export const BANDS: [string, number, number][] = [
  ["sub (under 60 Hz)", 0, 60], ["bass (60-250 Hz)", 60, 250], ["low mids (250-500 Hz)", 250, 500],
  ["mids (500 Hz-2 kHz)", 500, 2000], ["high mids (2-6 kHz)", 2000, 6000], ["highs (over 6 kHz)", 6000, 1e9],
];

/** Each band's share of the energy, in dB below the whole (0 dB would be all of it). */
function bands(chans: Float32Array[], rate: number): Record<string, number> {
  const n = 8192, frames = Math.floor(chans[0].length / n);
  const energy = BANDS.map(() => 0);
  const stride = Math.max(1, Math.floor(frames / 400)); // enough frames for an average, quick on long files
  const re = new Float64Array(n), im = new Float64Array(n);
  for (const ch of chans) for (let f = 0; f < frames; f += stride) {
    for (let i = 0; i < n; i++) { re[i] = ch[f * n + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n)); im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < n / 2; k++) {
      const hz = k * rate / n, p = re[k] * re[k] + im[k] * im[k];
      for (let b = 0; b < BANDS.length; b++) if (hz >= BANDS[b][1] && hz < BANDS[b][2]) { energy[b] += p; break; }
    }
  }
  const total = energy.reduce((s, v) => s + v, 0);
  return Object.fromEntries(BANDS.map((b, i) => [b[0], total > 0 ? r1(db(energy[i] / total)) : -200]));
}

export function analyze(file: string): Analysis {
  const a = readWav(file);
  const chans = a.channels.slice(0, 2); // loudness of the front pair; mono counts once
  const weighted = chans.map((c) => kWeight(c, a.rate));

  // integrated loudness: 400 ms blocks, 75 % overlap, gated at -70 LUFS and at 10 LU under the rest
  let integrated: number | null = null;
  const b400 = blocks(weighted, a.rate, 0.4, 0.1).filter((ms) => lufs(ms) > -70);
  if (b400.length) {
    const rel = lufs(mean(b400)) - 10;
    const kept = b400.filter((ms) => lufs(ms) > rel);
    if (kept.length) integrated = r1(lufs(mean(kept)));
  }
  // loudness range (EBU Tech 3342): 3 s blocks, gated at -70 and at 20 LU under, from the 10th to the 95th percentile
  let range: number | null = null, loudest3: number | null = null;
  const b3 = blocks(weighted, a.rate, 3, 1).filter((ms) => lufs(ms) > -70);
  if (b3.length) {
    loudest3 = r1(lufs(Math.max(...b3)));
    const rel = lufs(mean(b3)) - 20;
    const kept = b3.filter((ms) => lufs(ms) > rel).map(lufs).sort((x, y) => x - y);
    if (kept.length >= 2) range = r1(kept[Math.min(kept.length - 1, Math.round(0.95 * (kept.length - 1)))] - kept[Math.round(0.10 * (kept.length - 1))]);
  }

  let peak = 0, sq = 0, count = 0, clipped = 0;
  for (const c of a.channels) for (let i = 0; i < c.length; i++) {
    const v = Math.abs(c[i]);
    if (v > peak) peak = v;
    if (v >= 0.9999) clipped++;
    sq += v * v; count++;
  }
  const rms = count ? sq / count : 0;
  const tp = truePeak(a.channels, peak);

  let stereo: Analysis["stereo"] = null;
  if (a.channels.length >= 2) {
    const [L, R] = a.channels;
    let ll = 0, rr = 0, lr = 0, mid = 0, side = 0;
    for (let i = 0; i < L.length; i++) {
      ll += L[i] * L[i]; rr += R[i] * R[i]; lr += L[i] * R[i];
      const m = (L[i] + R[i]) / 2, s = (L[i] - R[i]) / 2; mid += m * m; side += s * s;
    }
    stereo = { correlation: ll > 0 && rr > 0 ? Math.round(lr / Math.sqrt(ll * rr) * 100) / 100 : 1, side_vs_mid_db: mid > 0 ? r1(db(side / mid)) : 0 };
  }
  return {
    file, seconds: r1(a.seconds), sample_rate: a.rate, channels: a.channels.length,
    integrated_lufs: integrated, loudness_range_lu: range, loudest_3s_lufs: loudest3,
    true_peak_db: r1(20 * Math.log10(tp || 1e-10)),
    sample_peak_db: r1(20 * Math.log10(peak || 1e-10)), rms_db: r1(db(rms)), crest_db: r1(20 * Math.log10(peak || 1e-10) - db(rms)),
    clipped_samples: clipped, bands_db: bands(chans, a.rate), stereo,
  };
}

/** Plain-words reading of the numbers. Starting points, not rules; the producer's ears decide. */
export function reading(x: Analysis): string[] {
  const out: string[] = [];
  if (x.integrated_lufs === null) return ["The file is silent or too short to measure."];
  const l = x.integrated_lufs;
  out.push(l > -9 ? `Very loud (${l} LUFS). Streaming services will turn it down; check it hasn't lost punch.`
    : l > -12 ? `Loud (${l} LUFS), in the range of a lot of released pop, hip-hop and electronic music.`
    : l > -16 ? `Around streaming level (${l} LUFS; services normalise to about -14).`
    : `Quiet for a master (${l} LUFS). Fine for a mix before mastering; a master is usually -14 or louder.`);
  if (x.true_peak_db > -0.1) out.push(`True peak is ${x.true_peak_db} dB: it can clip after conversion to MP3 or AAC. A limiter ceiling of about -1 dB is the usual fix.`);
  else if (x.true_peak_db > -1) out.push(`True peak is ${x.true_peak_db} dB: close to the top. -1 dB leaves room for streaming conversion.`);
  else out.push(`True peak is ${x.true_peak_db} dB: safe.`);
  if (x.clipped_samples > 0) out.push(`${x.clipped_samples} samples sit at full scale: likely clipping, unless a limiter put them there.`);
  if (x.crest_db < 8) out.push(`Peaks are only ${x.crest_db} dB above the average level: heavily squashed. Listen for lost drum punch.`);
  else if (x.crest_db > 18) out.push(`Peaks are ${x.crest_db} dB above the average level: very dynamic, or a few stray peaks eat the headroom.`);
  if (x.stereo) {
    if (x.stereo.correlation < 0.1) out.push(`Left and right barely agree (correlation ${x.stereo.correlation}): check it in mono, parts may vanish.`);
    else if (x.stereo.correlation > 0.97) out.push(`Almost mono (correlation ${x.stereo.correlation}).`);
  }
  return out;
}
