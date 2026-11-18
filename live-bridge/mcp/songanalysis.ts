// Measures what the music in a full mix is doing, so Claude has numbers where it has no ears: the key (three key
// profiles, with the runner-up and the relative key), tuning, tempo (with the half and the double), the repeat length,
// a one-bar kick, snare and hat map, and a rough bass note per bar. Loudness and tone come from loudness.ts.
// Ported from the one-off scripts key_tempo.py and fold.py (Cello Brain, inbox/music-studio/song-analysis-scripts).
// No dependencies. WAV only (see onsets.ts). Every reading is a measurement to check by ear, never a verdict.
import { readWav, type Audio } from "./onsets.ts";
import { analyze, reading, fft } from "./loudness.ts";
import { keyCard, SCALES } from "../vendor/spur/theory.ts";

const SR = 22050;        // everything is measured at this rate, as the scripts did
const HOP = 256;         // onset frames, about 11.6 ms
const FPS = SR / HOP;
const KEY_HOP = 1024;    // chroma frames, about 46 ms

/** Key profiles: how much each note of the scale counts, for a major and a minor key on C. */
const PROFILES: Record<string, [number[], number[]]> = {
  "Krumhansl-Kessler": [
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]],
  "Temperley": [
    [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400],
    [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330]],
  "Albrecht-Shanahan": [
    [0.238, 0.006, 0.111, 0.006, 0.137, 0.094, 0.016, 0.214, 0.009, 0.080, 0.008, 0.081],
    [0.220, 0.006, 0.104, 0.123, 0.019, 0.103, 0.012, 0.214, 0.062, 0.022, 0.061, 0.052]],
};

type Level = "high" | "medium" | "low";
type Mode = "major" | "minor";
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const mean = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; };

// ---------------------------------------------------------------- audio in

/** Windowed-sinc resampler by up/down (polyphase), with a low-pass under the new Nyquist. */
export function resample(x: Float32Array, up: number, down: number): Float32Array {
  const g = gcd(up, down); up /= g; down /= g;
  if (up === down) return x;
  const cut = 0.5 * Math.min(1, up / down) * 0.94; // cycles per input sample
  const W = Math.ceil(16 / (2 * cut));               // half width, in input samples
  const P = Math.min(up, 4096);                      // phases in the table
  const taps = 2 * W, table = new Float32Array(P * taps);
  for (let p = 0; p < P; p++) {
    const frac = p / P;
    for (let j = 0; j < taps; j++) {
      const t = j - W + 1 - frac, u = 2 * cut * t;
      const s = Math.abs(u) < 1e-12 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
      table[p * taps + j] = Math.abs(t) >= W ? 0 : 2 * cut * s * (0.5 + 0.5 * Math.cos(Math.PI * t / W));
    }
  }
  const out = new Float32Array(Math.floor(x.length * up / down));
  for (let n = 0; n < out.length; n++) {
    const pos = n * down, i0 = Math.floor(pos / up);
    const p = up === P ? pos - i0 * up : Math.floor(((pos - i0 * up) / up) * P);
    const base = p * taps, from = i0 - W + 1;
    let v = 0;
    if (from >= 0 && from + taps <= x.length) for (let j = 0; j < taps; j++) v += x[from + j] * table[base + j];
    else for (let j = 0; j < taps; j++) { const k = from + j; if (k >= 0 && k < x.length) v += x[k] * table[base + j]; }
    out[n] = v;
  }
  return out;
}

/** Magnitude spectra of Hann-windowed frames, centred with zero padding (as the scripts' numpy code), two real frames per FFT. */
function stft(x: Float32Array, n: number, hop: number, each: (frame: number, mag: Float64Array) => void): number {
  const pad = n / 2, frames = Math.floor(x.length / hop) + 1, half = n / 2;
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  const re = new Float64Array(n), im = new Float64Array(n);
  const ma = new Float64Array(half + 1), mb = new Float64Array(half + 1);
  const fill = (buf: Float64Array, f: number) => {
    const start = f * hop - pad;
    if (start >= 0 && start + n <= x.length) for (let i = 0; i < n; i++) buf[i] = x[start + i] * win[i];
    else for (let i = 0; i < n; i++) { const j = start + i; buf[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0; }
  };
  for (let f = 0; f < frames; f += 2) {
    fill(re, f);
    if (f + 1 < frames) fill(im, f + 1); else im.fill(0);
    fft(re, im);
    for (let k = 0; k <= half; k++) {
      const nk = (n - k) & (n - 1);
      const ar = re[k] + re[nk], ai = im[k] - im[nk], br = im[k] + im[nk], bi = re[nk] - re[k];
      ma[k] = 0.5 * Math.sqrt(ar * ar + ai * ai); mb[k] = 0.5 * Math.sqrt(br * br + bi * bi);
    }
    each(f, ma);
    if (f + 1 < frames) each(f + 1, mb);
  }
  return frames;
}

// ---------------------------------------------------------------- onsets and tempo

type Band = { lo: number; hi: number; nb: number };

/** Spectral flux in log-spaced bands between lo and hi Hz, one value per HOP; several band sets share one STFT. */
type Filters = { k0: number; w: Float64Array }[];

/** Triangular filters, log-spaced between lo and hi Hz (empty ones dropped), over the bins of an n-point FFT. */
function makeBanks(sets: Band[], n: number): Filters[] {
  const half = n / 2, binHz = SR / n;
  return sets.map(({ lo, hi, nb }) => {
    const edges = Array.from({ length: nb + 2 }, (_, i) => lo * Math.pow(hi / lo, i / (nb + 1)));
    const filters: { k0: number; w: Float64Array }[] = [];
    for (let i = 0; i < nb; i++) {
      const [a, c, b] = [edges[i], edges[i + 1], edges[i + 2]];
      const ks: number[] = [], ws: number[] = [];
      for (let k = 0; k <= half; k++) {
        const f = k * binHz, w = Math.min((f - a) / (c - a), (b - f) / (b - c));
        if (w > 0) { ks.push(k); ws.push(w); }
      }
      if (ks.length) filters.push({ k0: ks[0], w: Float64Array.from(ws) });
    }
    return filters;
  });
}

function bandDb(mag: ArrayLike<number>, fl: Filters, D: Float64Array, row: number) {
  for (let i = 0; i < fl.length; i++) {
    const { k0, w } = fl[i];
    let e = 0;
    for (let j = 0; j < w.length; j++) { const m = mag[k0 + j]; e += m * m * w[j]; }
    D[row + i] = 10 * Math.log10(e + 1e-12);
  }
}

/** Spectral flux in log-spaced bands between lo and hi Hz, one value per HOP; several band sets share one STFT. */
function bandOnsets(x: Float32Array, n: number, sets: Band[]): Float64Array[] {
  const banks = makeBanks(sets, n);
  const frames = Math.floor(x.length / HOP) + 1;
  const D = banks.map((fl) => new Float64Array(frames * fl.length));
  stft(x, n, HOP, (f, mag) => { for (let b = 0; b < banks.length; b++) bandDb(mag, banks[b], D[b], f * banks[b].length); });
  return banks.map((fl, b) => onsetCurve(D[b], frames, fl.length));
}

/** Running median of w (odd) values along a series, the ends padded with the nearest value. */
function slidingMedian(get: (i: number) => number, n: number, w: number, put: (i: number, v: number) => void) {
  const h = w >> 1, win = new Float64Array(w), at = (i: number) => get(Math.max(0, Math.min(n - 1, i)));
  for (let j = 0; j < w; j++) win[j] = at(j - h);
  win.sort();
  for (let i = 0; ; i++) {
    put(i, win[h]);
    if (i + 1 >= n) break;
    const out = at(i - h), inn = at(i + 1 + h);
    let k = 0; while (k < w - 1 && win[k] !== out) k++;
    for (; k < w - 1; k++) win[k] = win[k + 1];        // drop the value leaving the window
    k = w - 1; while (k > 0 && win[k - 1] > inn) { win[k] = win[k - 1]; k--; }
    win[k] = inn;                                       // and insert the new one in order
  }
}

/**
 * The drum part of a mix: harmonic-percussive separation by median filtering (Fitzgerald 2010). Held notes are smooth
 * along time, hits are smooth along frequency; each bin goes to whichever its two medians favour. Returns onset curves
 * from the hits only, per band, and each band's hit energy against the whole mix, in dB.
 */
function percussiveLanes(x: Float32Array, sets: Band[]) {
  const n = 2048, binHz = SR / n, nb = Math.min(n / 2, Math.ceil(Math.max(...sets.map((b) => b.hi)) * 1.05 / binHz)) + 1;
  const rows: Float32Array[] = [];
  const frames = stft(x, n, HOP, (_f, mag) => rows.push(Float32Array.from(mag.subarray(0, nb))));
  const H = new Float32Array(frames * nb), P = new Float32Array(frames * nb);
  for (let k = 0; k < nb; k++) slidingMedian((f) => rows[f][k], frames, 17, (f, v) => { H[f * nb + k] = v; });
  for (let f = 0; f < frames; f++) slidingMedian((k) => rows[f][k], nb, 17, (k, v) => { P[f * nb + k] = v; });
  const banks = makeBanks(sets, n);
  const D = banks.map((fl) => new Float64Array(frames * fl.length));
  const hitE = sets.map(() => 0);
  const m = new Float64Array(nb);
  for (let f = 0; f < frames; f++) {
    const S = rows[f];
    for (let k = 0; k < nb; k++) {
      const p = P[f * nb + k] ** 2, h = H[f * nb + k] ** 2;
      m[k] = S[k] * (p + h > 0 ? p / (p + h) : 0);
      for (let b = 0; b < sets.length; b++) {
        const hz = k * binHz;
        if (hz >= sets[b].lo && hz < sets[b].hi) hitE[b] += m[k] * m[k];
      }
    }
    for (let b = 0; b < banks.length; b++) bandDb(m, banks[b], D[b], f * banks[b].length);
  }
  let total = 0;
  for (let f = 0; f < frames; f++) for (let k = 0; k < nb; k++) total += rows[f][k] ** 2;
  return { lanes: banks.map((fl, b) => onsetCurve(D[b], frames, fl.length)),
    hitDb: sets.map((_, b) => 10 * Math.log10((hitE[b] + 1e-20) / (total + 1e-20))) };
}

function onsetCurve(D: Float64Array, frames: number, nb: number): Float64Array {
  let top = -Infinity;
  for (let i = 0; i < D.length; i++) if (D[i] > top) top = D[i];
  for (let i = 0; i < D.length; i++) if (D[i] < top - 80) D[i] = top - 80;
  const flux = new Float64Array(frames);
  for (let t = 1; t < frames; t++) {
    let s = 0;
    for (let i = 0; i < nb; i++) { const d = D[t * nb + i] - D[(t - 1) * nb + i]; if (d > 0) s += d; }
    flux[t] = s / nb;
  }
  // minus a 1-second moving average (numpy's convolve 'same'), so only rises above the local level count
  const k = Math.round(FPS), h = (k - 1) >> 1, cum = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) cum[i + 1] = cum[i] + flux[i];
  const o = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i + h - k + 1), b = Math.min(frames - 1, i + h);
    o[i] = Math.max(0, flux[i] - (cum[b + 1] - cum[a]) / k);
  }
  const m = mean(o);
  let v = 0;
  for (let i = 0; i < frames; i++) v += (o[i] - m) ** 2;
  const sd = Math.sqrt(v / frames) + 1e-9;
  for (let i = 0; i < frames; i++) o[i] /= sd;
  return o;
}

const centred = (o: Float64Array) => { const m = mean(o); return o.map((v) => v - m); };

/** How strongly the onsets repeat at this tempo (one bin of a Fourier tempogram over the whole song). */
function strength(o0: Float64Array, bpm: number): number {
  const w = 2 * Math.PI * bpm / 60 / FPS, cw = Math.cos(w), sw = Math.sin(w);
  let re = 0, im = 0, c = 1, s = 0;
  for (let t = 0; t < o0.length; t++) {
    if ((t & 511) === 0) { c = Math.cos(w * t); s = Math.sin(w * t); }
    re += o0[t] * c; im -= o0[t] * s;
    const nc = c * cw - s * sw; s = s * cw + c * sw; c = nc;
  }
  return Math.hypot(re, im) / o0.length;
}

const localPeaks = (v: ArrayLike<number>) => { const out: number[] = []; for (let i = 1; i < v.length - 1; i++) if (v[i] > v[i - 1] && v[i] >= v[i + 1]) out.push(i); return out; };

function tempoFourier(o: Float64Array, top = 8): [number, number][] {
  const o0 = centred(o);
  const grid = Array.from({ length: 620 }, (_, i) => 45 + 0.25 * i);
  const m = grid.map((b) => strength(o0, b));
  return localPeaks(m).sort((a, b) => m[b] - m[a]).slice(0, top).map((i) => {
    let best: [number, number] = [grid[i], m[i]];
    for (let j = 0; j < 60; j++) { const b = grid[i] - 0.3 + 0.01 * j, s = strength(o0, b); if (s > best[1]) best = [b, s]; }
    return best;
  }).sort((a, b) => b[1] - a[1]);
}

function tempoAcf(o: Float64Array, top = 8): [number, number][] {
  const o0 = centred(o), n = o0.length;
  let size = 1; while (size < 2 * n) size <<= 1;
  const re = new Float64Array(size), im = new Float64Array(size);
  re.set(o0); fft(re, im);
  for (let i = 0; i < size; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft(re, im); // the power spectrum is real and even, so a forward FFT gives the autocorrelation (times size)
  const ac0 = re[0] || 1;
  const l0 = Math.floor(60 * FPS / 200), l1 = Math.floor(60 * FPS / 45) + 2;
  const seg = Array.from({ length: l1 - l0 }, (_, i) => re[l0 + i] / ac0);
  return localPeaks(seg).map((i): [number, number] => {
    const a = seg[i - 1], b = seg[i], c = seg[i + 1], den = a - 2 * b + c;
    const p = den !== 0 ? 0.5 * (a - c) / den : 0;
    return [60 * FPS / (l0 + i + p), b];
  }).sort((a, b) => b[1] - a[1]).slice(0, top);
}

/** Dynamic-programming beat tracker (Ellis 2007). Beat positions, in frames. */
function beatTrack(o: Float64Array, bpm: number, tight = 100): number[] {
  const period = 60 * FPS / bpm, half = Math.ceil(period), n = o.length;
  const g: number[] = [];
  for (let i = -half; i <= half; i++) g.push(Math.exp(-0.5 * (i * 32 / period) ** 2));
  const gs = g.reduce((s, v) => s + v, 0);
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let j = 0; j < g.length; j++) { const k = i + half - j; if (k >= 0 && k < n) v += o[k] * g[j]; }
    local[i] = v / gs;
  }
  const o1 = Math.round(period / 2), o2 = Math.round(2 * period);
  const pen = new Float64Array(o2 - o1 + 1);
  for (let d = o1; d <= o2; d++) pen[d - o1] = -tight * Math.log(d / period) ** 2;
  const score = Float64Array.from(local), back = new Int32Array(n).fill(-1);
  for (let t = o1; t < n; t++) {
    let best = -Infinity, at = -1;
    for (let d = o1; d <= o2 && t - d >= 0; d++) { const v = score[t - d] + pen[d - o1]; if (v > best) { best = v; at = t - d; } }
    if (best > 0) { score[t] = local[t] + best; back[t] = at; }
  }
  let t = Math.max(0, n - o2);
  for (let i = t; i < n; i++) if (score[i] > score[t]) t = i;
  const beats: number[] = [];
  while (t >= 0) { beats.push(t); t = back[t]; }
  return beats.reverse();
}

function lineFit(xs: number[], ys: number[]): [number, number] {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const slope = sxx ? sxy / sxx : 0;
  return [slope, my - slope * mx];
}

/** A straight line through the beats: the tempo, how much the beats wobble off it, and each half's tempo. */
function fitBpm(beats: number[]) {
  const bt = beats.map((b) => b / FPS), n = bt.length;
  if (n < 12) return null;
  const k0 = Math.floor(0.1 * n), k1 = Math.floor(0.9 * n), h = n >> 1;
  const idx = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
  const mid = idx(k0, k1), [slope, icpt] = lineFit(mid, mid.map((i) => bt[i]));
  const resid = mid.map((i) => bt[i] - (slope * i + icpt)), rm = mean(resid);
  const wobble = Math.sqrt(mean(resid.map((r) => (r - rm) ** 2)));
  const s1 = lineFit(idx(k0, h), idx(k0, h).map((i) => bt[i]))[0], s2 = lineFit(idx(h, k1), idx(h, k1).map((i) => bt[i]))[0];
  return { bpm: 60 / slope, wobble_ms: 1000 * wobble, first_half: 60 / s1, second_half: 60 / s2 };
}

/** The strongest onset within w frames of each position. */
function at(env: Float64Array, pos: number[], w = 4): number[] {
  return pos.map((p) => {
    let m = 0;
    for (let i = Math.max(0, Math.round(p - w)); i <= Math.min(env.length - 1, Math.round(p + w)); i++) if (env[i] > m) m = env[i];
    return m;
  });
}

// ---------------------------------------------------------------- key

/** Spectral peaks per frame, with interpolated frequency (as a MIDI number) and amplitude. */
function peakChroma(x: Float32Array, rate: number, n: number, hop: number, fmin: number, fmax: number, relDb = 40, absDb = 70) {
  const binHz = rate / n, k0 = Math.max(1, Math.ceil(fmin / binHz)), k1 = Math.min(Math.floor(fmax / binHz), n / 2 - 1);
  const width = k1 - k0 + 3; // bins k0-1 .. k1+1
  const rows: Float32Array[] = [];
  let top = 0;
  const frames = stft(x, n, hop, (_f, mag) => {
    for (let k = 0; k < mag.length; k++) if (mag[k] > top) top = mag[k];
    rows.push(Float32Array.from(mag.subarray(k0 - 1, k1 + 2)));
  });
  const floor = top * Math.pow(10, -absDb / 20), rel = Math.pow(10, -relDb / 20);
  const fi: number[] = [], midi: number[] = [], amp: number[] = [];
  for (let f = 0; f < frames; f++) {
    const S = rows[f];
    let fmax2 = 0;
    for (let j = 1; j < width - 1; j++) if (S[j] > fmax2) fmax2 = S[j];
    const gate = Math.max(floor, fmax2 * rel);
    for (let j = 1; j < width - 1; j++) {
      const c = S[j];
      if (!(c > S[j - 1] && c >= S[j + 1] && c > gate)) continue;
      const a = Math.log(S[j - 1] + 1e-12), b = Math.log(c + 1e-12), g = Math.log(S[j + 1] + 1e-12), den = a - 2 * b + g;
      const p = den !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - g) / den)) : 0;
      const freq = (k0 - 1 + j + p) * binHz;
      fi.push(f); midi.push(69 + 12 * Math.log2(freq / 440)); amp.push(Math.exp(b - 0.25 * (a - g) * p));
    }
  }
  return { fi, midi, amp, frames, frameSeconds: hop / rate };
}

/** How far the song sits from A440, in semitones (-0.5 to 0.5), and how much the peaks agree on it (0 to 1). */
function tuningOf(midi: number[], amp: number[]) {
  let re = 0, im = 0, total = 0;
  for (let i = 0; i < midi.length; i++) {
    const dev = midi[i] - Math.round(midi[i]);
    re += amp[i] * Math.cos(2 * Math.PI * dev); im += amp[i] * Math.sin(2 * Math.PI * dev); total += amp[i];
  }
  return { semitones: Math.atan2(im, re) / (2 * Math.PI), agreement: total ? Math.hypot(re, im) / total : 0 };
}

/** A 12-note chroma per frame, folded with the measured tuning. */
function chromaFrames(p: ReturnType<typeof peakChroma>, tuning: number): Float64Array {
  const C = new Float64Array(p.frames * 12);
  for (let i = 0; i < p.midi.length; i++) {
    const m = p.midi[i] - tuning, r = Math.round(m);
    C[p.fi[i] * 12 + (((r % 12) + 12) % 12)] += Math.sqrt(p.amp[i]) * Math.cos(Math.PI * (m - r)) ** 2;
  }
  return C;
}

function pearson(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

type KeyScore = { pc: number; mode: Mode; r: number };
/** Every key's correlation with each profile, and the average of the three. */
function rankKeys(ch: number[]) {
  const per: Record<string, KeyScore[]> = {};
  const avg = new Map<string, KeyScore>();
  for (const [name, [maj, min]] of Object.entries(PROFILES)) {
    const res: KeyScore[] = [];
    for (let pc = 0; pc < 12; pc++) for (const [mode, prof] of [["major", maj], ["minor", min]] as [Mode, number[]][]) {
      const rolled = Array.from({ length: 12 }, (_, i) => prof[(i - pc + 12) % 12]);
      const r = pearson(ch, rolled);
      res.push({ pc, mode, r });
      const k = `${pc} ${mode}`, e = avg.get(k) ?? { pc, mode, r: 0 };
      e.r += r / Object.keys(PROFILES).length; avg.set(k, e);
    }
    per[name] = res.sort((a, b) => b.r - a.r);
  }
  return { per, avg: [...avg.values()].sort((a, b) => b.r - a.r) };
}

/** The chroma of the frames between two times, each loud-enough frame counting once (per-frame normalised). */
function chromaBetween(C: Float64Array, frameSeconds: number, from: number, to: number, minEnergy: number): number[] {
  const v = new Array(12).fill(0);
  const f0 = Math.max(0, Math.ceil(from / frameSeconds)), f1 = Math.min(C.length / 12, Math.ceil(to / frameSeconds));
  for (let f = f0; f < f1; f++) {
    let e = 0;
    for (let i = 0; i < 12; i++) e += C[f * 12 + i];
    if (e > minEnergy && e > 0) for (let i = 0; i < 12; i++) v[i] += C[f * 12 + i] / e;
  }
  return v;
}

function percentile(a: number[], q: number): number {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return 0;
  const pos = (s.length - 1) * q / 100, lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}

// ---------------------------------------------------------------- naming

const SHARP_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const FLAT_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];

/** The key's name, its scale notes, and a speller for any note, in the key's own spelling (B♭ in G minor, not A♯). */
function keyInfo(pc: number, mode: Mode) {
  const steps = SCALES[mode].steps;
  // F♯ major and D♯ minor (six sharps) are also G♭ major and E♭ minor (six flats). Lead with the sharps, as the
  // song analysis notes do; give the flat name beside it.
  const six = (mode === "major" && pc === 6) || (mode === "minor" && pc === 3);
  const notes = six ? steps.map((x) => ((pc + x) % 12 === 5 ? "E♯" : SHARP_NAMES[(pc + x) % 12])) : keyCard(pc, mode).notes;
  const flats = !six && notes.some((n) => n.includes("♭"));
  const inKey = new Map(notes.map((name, i) => [(pc + steps[i]) % 12, name]));
  const spell = (p: number) => inKey.get(p) ?? (flats ? FLAT_NAMES : SHARP_NAMES)[p];
  return { name: `${notes[0]} ${mode}`, notes, spell, also: six ? `${FLAT_NAMES[pc]} ${mode}` : null };
}
const relativeOf = (pc: number, mode: Mode): [number, Mode] => (mode === "major" ? [(pc + 9) % 12, "minor"] : [(pc + 3) % 12, "major"]);

// ---------------------------------------------------------------- the report

export type SongAnalysis = Record<string, unknown>;

export function analyzeSong(file: string, audio?: Audio): SongAnalysis {
  const started = Date.now();
  const a = audio ?? readWav(file);
  const x = resample(a.mono, SR, a.rate);
  const seconds = x.length / SR;
  if (seconds < 4) throw new Error(`${file} is only ${r1(seconds)} seconds long. song_analyze needs at least a few bars (8 seconds or more is better).`);

  // where there is sound at all
  const blk = 1024, nbk = Math.floor(x.length / blk), rms: number[] = [];
  for (let b = 0; b < nbk; b++) { let s = 0; for (let i = b * blk; i < (b + 1) * blk; i++) s += x[i] * x[i]; rms.push(Math.sqrt(s / blk + 1e-12)); }
  const loudest = Math.max(...rms), active = rms.map((v, i) => (v > loudest * Math.pow(10, -35 / 20) ? i : -1)).filter((i) => i >= 0);
  if (!active.length || loudest < 1e-5) throw new Error(`${file} is silent.`);
  const tOn = active[0] * blk / SR, tOff = (active[active.length - 1] + 1) * blk / SR;

  // ---- tempo
  const [all] = bandOnsets(x, 2048, [{ lo: 30, hi: 10000, nb: 64 }]);
  const drums = percussiveLanes(x, [{ lo: 30, hi: 150, nb: 8 }, { lo: 900, hi: 4000, nb: 16 }, { lo: 6000, hi: 10500, nb: 8 }]);
  const [kick, snare, hats] = drums.lanes;
  const lanes: [string, Float64Array][] = [["kick", kick], ["snare", snare], ["hats", hats]];
  const tf = tempoFourier(all), ta = tempoAcf(all);
  // The pulse both methods back: each periodicity peak scores its own strength plus the autocorrelation peak at the
  // same tempo, its half or its double. (The strongest periodicity alone can be a syncopated hat: 175 in a 140 song.)
  const related = (p: number, q: number) => [1, 2, 0.5].some((m) => Math.abs(p / (q * m) - 1) < 0.02);
  const fmax = tf[0]?.[1] || 1, amax = Math.max(1e-9, ...ta.map(([, c]) => c));
  const support = (b: number) => Math.max(0, ...ta.filter(([a]) => related(a, b)).map(([, c]) => c / amax));
  const scored = tf.filter(([b]) => b >= 50 && b <= 200).map(([b, f]) => ({ b, score: f / fmax + support(b), acf: support(b) > 0 }))
    .sort((p, q) => q.score - p.score);
  const t0 = scored[0]?.b ?? tf[0][0];
  // The strongest pulse is often the hats (the double) or the bar (the half). Lead with the reading nearest 110 BPM,
  // in octaves, as most songs are counted between about 75 and 150; the half and the double sit beside it.
  const lead = [t0 / 2, t0, t0 * 2].filter((h) => h >= 50 && h <= 200).sort((p, q) => Math.abs(Math.log2(p / 110)) - Math.abs(Math.log2(q / 110)))[0] ?? t0;
  const tracked = new Map<string, { asked: number; beats: number[]; fit: ReturnType<typeof fitBpm>; onBeat: number; between: number }>();
  for (const [label, h] of [["half", lead / 2], ["measured", lead], ["double", lead * 2]] as [string, number][]) {
    if (h < 50 || h > 200) continue;
    const beats = beatTrack(all, h);
    const mids = beats.slice(1).map((b, i) => (b + beats[i]) / 2);
    tracked.set(label, { asked: h, beats, fit: fitBpm(beats), onBeat: mean(at(all, beats)), between: mean(at(all, mids)) });
  }
  const main = tracked.get("measured")!;
  const bpm = main.fit?.bpm ?? lead;
  const acfAgrees = !!scored[0]?.acf;
  const steady = !!main.fit && Math.abs(main.fit.first_half - main.fit.second_half) < 0.5 && main.fit.wobble_ms < 40;
  const tempoConf: Level = acfAgrees && steady ? "high" : acfAgrees || steady ? "medium" : "low";
  const reading1 = (label: string) => {
    const t = tracked.get(label);
    const exact = label === "half" ? bpm / 2 : label === "double" ? bpm * 2 : bpm;
    if (!t) return { bpm: r1(exact), tracked: false, why: "not tracked: outside 50-200 BPM" };
    return { bpm: label === "measured" ? r2(exact) : r1(exact), tracked_bpm: t.fit ? r2(t.fit.bpm) : null, tracked: true, beats: t.beats.length,
      wobble_ms: t.fit ? Math.round(t.fit.wobble_ms) : null,
      first_half_bpm: t.fit ? r2(t.fit.first_half) : null, second_half_bpm: t.fit ? r2(t.fit.second_half) : null,
      hits_on_beats_vs_between: r2(t.onBeat / (t.between || 1e-9)) };
  };
  const whole = Math.abs(bpm - Math.round(bpm)) < 0.15;

  // ---- key and tuning (peaks between 55 Hz and 2.5 kHz, at half the rate: the same frequency detail for half the work)
  const xKey = resample(x, 1, 2);
  const kp = peakChroma(xKey, SR / 2, 4096, KEY_HOP / 2, 55, 2500);
  const tun = tuningOf(kp.midi, kp.amp);
  const C = chromaFrames(kp, tun.semitones);
  const energies: number[] = [];
  for (let f = 0; f < kp.frames; f++) { let e = 0; for (let i = 0; i < 12; i++) e += C[f * 12 + i]; energies.push(e); }
  const minE = percentile(energies, 20);
  const g = chromaBetween(C, kp.frameSeconds, 0, seconds + 1, minE);
  const ranked = rankKeys(g);
  const best = ranked.avg[0], second = ranked.avg[1];
  const [rpc, rmode] = relativeOf(best.pc, best.mode);
  const relative = ranked.avg.find((k) => k.pc === rpc && k.mode === rmode)!;
  const K = keyInfo(best.pc, best.mode);
  const nameOf = (k: { pc: number; mode: Mode }) => keyInfo(k.pc, k.mode).name;
  const profileTops = Object.fromEntries(Object.entries(ranked.per).map(([p, res]) => [p, `${nameOf(res[0])} (${r2(res[0].r)})`]));
  const profilesAgree = Object.values(ranked.per).filter((res) => res[0].pc === best.pc && res[0].mode === best.mode).length;
  const span = tOff - tOn, nSec = span >= 40 ? 4 : span >= 16 ? 2 : 1;
  const sections = Array.from({ length: nSec }, (_, i) => {
    const from = tOn + span * i / nSec, to = tOn + span * (i + 1) / nSec;
    const top = rankKeys(chromaBetween(C, kp.frameSeconds, from, to, minE)).avg;
    return { from_s: r1(from), to_s: r1(to), key: nameOf(top[0]), runner_up: nameOf(top[1]), same: top[0].pc === best.pc && top[0].mode === best.mode };
  });
  const sectionsAgree = sections.filter((s) => s.same).length;
  const margin = best.r - second.r;
  // "high" also needs the relative key (same notes, a different home) clearly behind: within 0.10 it's the ear's call
  const relGap = best.r - relative.r, relClose = relGap < 0.1;
  const keyConf: Level = profilesAgree === 3 && sectionsAgree === nSec && margin >= 0.05 && !relClose ? "high"
    : profilesAgree <= 1 || sectionsAgree < nSec / 2 || margin < 0.02 ? "low" : "medium";
  const order = g.map((v, i) => [v, i]).sort((p, q) => q[0] - p[0]);
  const gmax = order[0][0] || 1;

  // ---- the bar grid: a downbeat guess from where the chords change most, with the kick as a tie-break
  const beats = main.beats.map((b) => b / FPS);
  const beatChroma = beats.slice(0, -1).map((b, i) => chromaBetween(C, kp.frameSeconds, b, beats[i + 1], minE));
  const cosine = (p: number[], q: number[]) => { let pq = 0, pp = 0, qq = 0; for (let i = 0; i < 12; i++) { pq += p[i] * q[i]; pp += p[i] * p[i]; qq += q[i] * q[i]; } return pp && qq ? pq / Math.sqrt(pp * qq) : 1; };
  const change = [0, 1, 2, 3].map((d) => { const v: number[] = []; for (let j = d || 4; j < beatChroma.length; j += 4) v.push(1 - cosine(beatChroma[j - 1], beatChroma[j])); return mean(v); });
  const kickOn = at(kick, main.beats), kickBy4 = [0, 1, 2, 3].map((d) => mean(kickOn.filter((_, i) => i % 4 === d)));
  const cmax = Math.max(...change) || 1, kmax = Math.max(...kickBy4) || 1;
  const phaseScore = [0, 1, 2, 3].map((d) => change[d] / cmax + 0.5 * kickBy4[d] / kmax);
  const down = phaseScore.indexOf(Math.max(...phaseScore));
  const sortedPhase = [...phaseScore].sort((p, q) => q - p);
  const downbeatClear = sortedPhase[0] - sortedPhase[1] > 0.25;

  // ---- repeat length (fold.py): which loop length makes the onsets line up best
  const t = Float64Array.from(all, (_, i) => i / FPS);
  const fold = (env: Float64Array, T: number, nb: number, start = 0) => {
    const s = new Float64Array(nb), c = new Float64Array(nb);
    for (let i = 0; i < env.length; i++) {
      let ph = ((t[i] - start) % T) / T; if (ph < 0) ph += 1;
      const b = Math.min(Math.floor(ph * nb), nb - 1); s[b] += env[i]; c[b]++;
    }
    for (let b = 0; b < nb; b++) s[b] /= Math.max(c[b], 1);
    return s;
  };
  const Ts: number[] = [], con: number[] = [];
  for (let T = 1; T < 12; T += 0.002) {
    const p = fold(all, T, 48), m = mean(p);
    Ts.push(T); con.push(Math.sqrt(mean(Array.from(p, (v) => (v - m) ** 2))) / (m + 1e-9));
  }
  const beatSec = 60 / bpm;
  const repeats = localPeaks(con).sort((p, q) => con[q] - con[p]).slice(0, 6).map((i) => {
    const b = Ts[i] / beatSec, nb = Math.round(b);
    return { seconds: r2(Ts[i]), beats: r1(b), whole_beats: Math.abs(b - nb) < 0.08 * Math.max(1, nb / 4) && nb > 0 ? nb : null, contrast: r2(con[i]) };
  });
  const barry = (r: { whole_beats: number | null }) => r.whole_beats !== null && [1, 2, 4, 8, 16, 32].includes(r.whole_beats);
  const repeat = repeats.find(barry) ?? repeats.find((r) => r.whole_beats !== null) ?? repeats[0];
  const repeatConf: Level = repeat && repeat === repeats[0] && barry(repeat) ? "medium" : "low";

  // ---- chord and bass cycles: after how many bars the harmony (and the bass) comes round again
  const barChroma = (frames: Float64Array, frameSeconds: number, nfr: number) => {
    const out: number[][] = [];
    for (let i = down; i + 4 < beats.length; i += 4) {
      const v = new Array(12).fill(0), f0 = Math.ceil(beats[i] / frameSeconds), f1 = Math.min(nfr, Math.ceil(beats[i + 4] / frameSeconds));
      for (let f = f0; f < f1; f++) for (let k = 0; k < 12; k++) v[k] += frames[f * 12 + k];
      out.push(v);
    }
    return out;
  };
  const cycleOf = (bc: number[][]) => {
    const maxL = Math.min(16, Math.floor(bc.length / 2));
    if (maxL < 1) return null;
    const scores = Array.from({ length: maxL }, (_, l) => { const L = l + 1, v: number[] = []; for (let i = 0; i + L < bc.length; i++) v.push(cosine(bc[i], bc[i + L])); return mean(v); });
    // the shortest lag that matches nearly as well as the best, measured against the typical lag (a voice or a pad
    // over everything lifts every lag, so a fixed margin would always pick 1 bar)
    const top = Math.max(...scores), typical = percentile(scores, 50);
    const L = scores.findIndex((v) => v >= top - 0.25 * (top - typical)) + 1;
    return { bars: L, beats: 4 * L, seconds: r2(4 * L * 60 / bpm), match: r2(scores[L - 1]), above_typical: r2(top - typical),
      confidence: (top - typical >= 0.05 && scores[L - 1] >= 0.85 ? "medium" : "low") as Level,
      by_bars: scores.map((v, i) => `${i + 1}: ${r2(v)}`).join(", ") };
  };
  const chordCycle = cycleOf(barChroma(C, kp.frameSeconds, kp.frames));

  // ---- one bar of kick, snare and hats, 16 steps, starting on the downbeat guess
  const barStart = beats[down] ?? 0;
  const drum: Record<string, string> = {}, clear: Record<string, boolean> = {}, strongSteps: Record<string, number[]> = {}, strength: Record<string, number> = {};
  // Is there a kick drum? The energy of the low hits (the part of 30-150 Hz that starts and stops, not held notes),
  // against the whole mix. Three mixes with drums gave -11 to -16 dB; Catalina (no drums) -29, its stems -24 to -43.
  // The made-up loop without drums gave -20 (its bass notes start hard). Seven files: a guess at the line, set at -18. Without a clear kick, no map is drawn, since chords and the voice also make
  // "hits" in the snare and hat ranges.
  const kickDb = drums.hitDb[0], drumsClear = kickDb >= -18;
  // Each frame is placed by the tracked beats around it (4 steps per beat, each step centred on its grid point), so a
  // tempo a little off can't smear a long song's map the way folding over a fixed bar length would.
  const beatSync = (env: Float64Array) => {
    const s16 = new Float64Array(16), c16 = new Float64Array(16), B = main.beats;
    for (let j = 0; j + 1 < B.length; j++) {
      const pos = (((j - down) % 4) + 4) % 4, a0 = B[j], len = B[j + 1] - a0;
      for (let f = Math.ceil(a0); f < B[j + 1] && f < env.length; f++) {
        let st = Math.round((f - a0) / len * 4), bp = pos;
        if (st === 4) { st = 0; bp = (pos + 1) % 4; }
        s16[bp * 4 + st] += env[f]; c16[bp * 4 + st]++;
      }
    }
    return s16.map((v, i) => v / Math.max(c16[i], 1));
  };
  for (const [name, env] of lanes) {
    const p = beatSync(env), top = Math.max(...p) || 1, contrast = top / (mean(p) || 1e-9);
    const chars = Array.from(p, (v) => (v / top >= 0.6 ? "X" : v / top >= 0.35 ? "x" : "."));
    drum[name] = [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join(" ")).join(" | ");
    strength[name] = r1(contrast); // the strongest step against the average step
    clear[name] = drumsClear && contrast >= 1.5;
    strongSteps[name] = chars.map((c, i) => (c === "X" ? i + 1 : 0)).filter(Boolean);
  }

  // ---- bass note per bar (peaks 38-120 Hz; above that the voice and the chords get in)
  const xBass = resample(x, 1, 4);
  const bp = peakChroma(xBass, SR / 4, 4096, KEY_HOP / 4, 32, 120);
  const B = chromaFrames(bp, tun.semitones);
  const bassCycle = cycleOf(barChroma(B, bp.frameSeconds, bp.frames));
  const bars: { bar: number; from_s: number; note: string; pc: number }[] = [];
  const barEnergy: number[] = [];
  for (let i = down, n = 1; i + 4 < beats.length; i += 4, n++) {
    const from = beats[i], to = beats[i + 4], v = new Array(12).fill(0);
    const f0 = Math.ceil(from / bp.frameSeconds), f1 = Math.min(bp.frames, Math.ceil(to / bp.frameSeconds));
    for (let f = f0; f < f1; f++) for (let k = 0; k < 12; k++) v[k] += B[f * 12 + k];
    const e = v.reduce((s, q) => s + q, 0), pc = v.indexOf(Math.max(...v));
    barEnergy.push(e);
    bars.push({ bar: n, from_s: r1(from), note: K.spell(pc), pc });
  }
  const medE = percentile(barEnergy.filter((e) => e > 0), 50);
  bars.forEach((b, i) => { if (!(barEnergy[i] > 0.1 * medE) || b.from_s < tOn - 0.5 || b.from_s > tOff) { b.note = "-"; b.pc = -1; } });
  const counts = new Map<string, number>();
  for (const b of bars) if (b.note !== "-") counts.set(b.note, (counts.get(b.note) ?? 0) + 1);
  const common = [...counts.entries()].sort((p, q) => q[1] - p[1]);
  const inKeySet = new Set(K.notes);
  const outside = common.filter(([n]) => !inKeySet.has(n)).map(([n, c]) => `${n} (${c} bar${c === 1 ? "" : "s"})`);
  const barLines: string[] = [];
  for (let i = 0; i < bars.length; i += 4) barLines.push(`bars ${bars[i].bar}-${bars[Math.min(i + 3, bars.length - 1)].bar} (from ${bars[i].from_s} s): ${bars.slice(i, i + 4).map((b) => b.note).join(" ")}`);
  const bassHeard = bars.filter((b) => b.note !== "-").length;

  // ---- loudness and tone, from audio_analyze's own code
  const meter = analyze(file, a);

  const cents = Math.round(100 * tun.semitones);
  const tunConf: Level = tun.agreement >= 0.35 ? "high" : tun.agreement >= 0.15 ? "medium" : "low";
  const halfR = reading1("half"), dblR = reading1("double");
  const keyLine = K.also ? `${K.name} (also written ${K.also})` : K.name;
  const relName = nameOf(relative), runnerName = nameOf(second);
  const out: SongAnalysis = {
    file, seconds: r1(seconds), sound_from_s: r1(tOn), sound_to_s: r1(tOff),
    summary: [
      `Key: ${keyLine}, ${keyConf} confidence. Runner-up ${runnerName}${keyInfo(second.pc, second.mode).also ? ` (also written ${keyInfo(second.pc, second.mode).also})` : ""}${second.pc === relative.pc && second.mode === relative.mode ? " (its relative key: the same notes, a different home)" : ""}. Relative key: ${relName}${relClose ? ", and it is close: listen for home" : ""}.`,
      `Tuning: ${cents >= 0 ? "+" : ""}${cents} cents from A440 (${tunConf} confidence).`,
      `Tempo: ${r2(bpm)} BPM${whole ? ` (about ${Math.round(bpm)})` : ""}, ${tempoConf} confidence. Half ${halfR.bpm}, double ${dblR.bpm}: the numbers can't say which one it feels like.`,
      `${repeat ? `Short pattern: ${repeat.whole_beats ? `${repeat.whole_beats} beats` : `${repeat.seconds} s`}` : "No clear short pattern"}${chordCycle ? `; chord cycle: ${chordCycle.beats} beats (${chordCycle.bars} bar${chordCycle.bars === 1 ? "" : "s"}, ${chordCycle.confidence} confidence)` : ""}${bassCycle && chordCycle && bassCycle.bars !== chordCycle.bars ? `; bass cycle: ${bassCycle.beats} beats` : ""}.`,
      drumsClear ? `Drums, one bar (16 steps, 1 = the downbeat guess): kick on ${strongSteps.kick.join(", ") || "no clear step"}; snare or clap on ${strongSteps.snare.join(", ") || "no clear step"}.` : `No clear drums: almost no kick-like hits (${r1(kickDb)} dB of the mix), so no drum map.`,
      bassHeard ? `Bass, per bar (rough): mostly ${common.slice(0, 4).map(([n]) => n).join(", ")}.${outside.length ? ` Not in the key: ${outside.join(", ")}; maybe the kick, a passing note, or a different key.` : ""}` : "No steady bass under 120 Hz.",
      ...reading(meter),
    ],
    key: {
      best: K.name, also_written: K.also, notes: K.notes, confidence: keyConf,
      runner_up: { key: runnerName, score: r2(second.r) }, relative: { key: relName, score: r2(relative.r), notes: keyInfo(relative.pc, relative.mode).notes },
      score: r2(best.r), lead_over_runner_up: r2(margin), lead_over_relative: r2(relGap),
      relative_is_close: relClose ? `${relName} scores within ${r2(relGap)}: the relative key is close. Listen for home.` : false,
      top_five: ranked.avg.slice(0, 5).map((k) => `${nameOf(k)} ${r2(k.r)}`),
      by_profile: profileTops, profiles_agreeing: `${profilesAgree} of 3`,
      by_section: sections.map(({ same: _s, ...s }) => s), sections_agreeing: `${sectionsAgree} of ${nSec}`,
      notes_by_weight: order.slice(0, 9).map(([v, i]) => `${K.spell(i)} ${r2(v / gmax)}`),
      check_by_ear: `Play the scale (${K.notes.join(" ")}) over the song: it should fit everywhere. Then hum the note the song feels like it comes home to. ${K.notes[0]} means ${K.name}; ${keyInfo(relative.pc, relative.mode).notes[0]} means ${relName}. Same notes, so only your ear can settle it.`,
    },
    tuning: {
      cents_from_a440: cents, agreement: r2(tun.agreement), confidence: tunConf,
      check_by_ear: Math.abs(cents) >= 15
        ? `Play an A on a keyboard tuned to A440 with the song. ${cents > 0 ? "The song should sound a little sharp" : "The song should sound a little flat"}. To match it, set your instruments' fine tune to ${cents > 0 ? "+" : ""}${cents} cents.`
        : "Play a few notes of the key on a keyboard with the song: they should sit in tune, with no slow beating.",
    },
    tempo: {
      bpm: r2(bpm), whole_number: whole ? Math.round(bpm) : null, confidence: tempoConf,
      half: halfR, measured: reading1("measured"), double: dblR,
      why: `${acfAgrees ? "Two methods agree" : "The two methods disagree"} (periodicity ${r1(t0)}; the autocorrelation backs it at the same pulse, its half or its double: ${acfAgrees ? "yes" : "no"}); ${steady ? "the beat is steady from start to end" : "the beat drifts or wobbles"}. It leads with the reading nearest 110 BPM, a convention, not a measurement.`,
      periodicity_candidates: tf.slice(0, 5).map(([b, s]) => `${r2(b)} (${Math.round(s * 1000) / 1000})`),
      autocorrelation_candidates: ta.slice(0, 5).map(([b, c]) => `${r2(b)} (${r2(c)})`),
      check_by_ear: `Tap along. If your taps land on every other one of ${r1(bpm)}, the feel is half time (${halfR.bpm}). If you tap twice per counted beat, it's the double (${dblR.bpm}). A higher "hits on beats vs between" means that grid lands on more hits.`,
    },
    repeat: {
      short_pattern: repeat ? { seconds: repeat.seconds, beats_at_tempo: repeat.beats, confidence: repeatConf, candidates: repeats } : null,
      chord_cycle: chordCycle, bass_cycle: bassCycle,
      how: "short_pattern: the loop length that makes the hits line up best. chord_cycle and bass_cycle: after how many bars the notes come round again (match 1 = the same notes; by_bars lists each lag).",
      check_by_ear: `${repeat ? `Count ${repeat.whole_beats ?? Math.round(repeat.beats)} beats: the groove should come round again. ` : ""}${chordCycle ? `Count ${chordCycle.bars} bar${chordCycle.bars === 1 ? "" : "s"} from a chord change: the chords should start over there.` : ""}`,
    },
    drum_map: drumsClear ? {
      bpm: r1(bpm), steps: 16, downbeat_guess_s: r2(barStart), downbeat_clear: downbeatClear,
      grid: "1 . . . | 2 . . . | 3 . . . | 4 . . .",
      kick: drum.kick, snare: drum.snare, hats: drum.hats, key_to_marks: "X strong, x medium, . little or nothing",
      lanes: "From the hits only (held notes taken out). kick = 30-150 Hz; snare = 0.9-4 kHz (snare or clap; voice consonants can show here); hats = 6-10.5 kHz (hats, shakers, cymbals)",
      kick_hits_db: r1(kickDb), pattern_strength: strength, clear_lane: clear,
      confidence: (clear.snare && clear.hats && downbeatClear ? "medium" : "low") as Level,
      check_by_ear: "Count 1-2-3-4 with the song. The kick should land where the map says X. If it's off by two beats, the downbeat guess is wrong; the pattern itself still holds.",
    } : {
      no_clear_drums: true, kick_hits_db: r1(kickDb),
      why: `Kick-like hits make ${r1(kickDb)} dB of the mix; the songs with drums it was checked on measured -11 to -16 dB. Without a clear kick, any pattern would be chords, bass or voice starting.`,
      check_by_ear: "Listen for a kick and a snare. If there are drums, they may be soft or filtered; a Drums stem from Stem Separation would settle it.",
    },
    bass_per_bar: {
      rough: true, at_bpm: r1(bpm), bars_heard: `${bassHeard} of ${bars.length}`,
      bars: barLines, most_common: common.slice(0, 6).map(([n, c]) => `${n} ${c}`), not_in_key: outside,
      confidence: "low" as Level,
      check_by_ear: "Rough: the strongest low note in each bar, under 120 Hz. A kick drum can pose as a bass note. Play the notes along with the bass and keep the ones that sound right.",
    },
    loudness_and_tone: { ...meter, file: undefined, reading: reading(meter) },
    took_seconds: r1((Date.now() - started) / 1000),
    note: "Measurements, not answers. Claude can't hear: report these, offer the options, and let the user decide by ear (above all: which key feels like home, and whether the beat is the half or the double).",
  };
  return out;
}
