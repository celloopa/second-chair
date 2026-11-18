// Reads the stems Live's Stem Separation writes (Vocals, Drums, Bass, Others) for song_analyze. Each stem settles
// something a full mix can't: the drums say whether the beat is the half or the double, the bass gives its notes
// without the kick in the way, the vocals give the singer's range, and the others give a cleaner key and chord loop.
// The YIN pitch tracker is ported from vocal_range.py; the chords from key_tempo.py (Cello Brain,
// inbox/music-studio/song-analysis-scripts). No dependencies. WAV only. Stems leak, so every reading is a
// measurement to check by ear, never a verdict.
import { readWav, type Audio } from "./onsets.ts";
import { fft } from "./loudness.ts";
import * as S from "./songanalysis.ts";

export type StemName = "vocals" | "drums" | "bass" | "others";
export const STEM_NAMES: StemName[] = ["vocals", "drums", "bass", "others"];
export type StemFiles = Partial<Record<StemName, string>>;
type Level = S.Level;
type Mode = S.Mode;
const { SR, FPS, r1, r2, mean, percentile } = S;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const pcOf = (m: number) => ((Math.round(m) % 12) + 12) % 12;

// ---------------------------------------------------------------- levels

export type StemLevel = { rms_dbfs: number; peak_dbfs: number; plays_share: number; plays_from_s: number | null; plays_to_s: number | null; near_silent: boolean };

/** RMS and peak over the whole stem, and where it plays: half-second blocks within 30 dB of its loudest block. */
export function stemLevel(a: Audio): StemLevel {
  let sq = 0, peak = 0;
  for (const ch of a.channels) for (let i = 0; i < ch.length; i++) { const v = ch[i]; sq += v * v; if (v > peak) peak = v; else if (-v > peak) peak = -v; }
  const n = Math.max(1, a.channels.length * a.mono.length);
  const rmsDb = 10 * Math.log10(sq / n + 1e-20), peakDb = 20 * Math.log10(peak + 1e-12);
  const blk = Math.max(1, Math.round(a.rate / 2)), nb = Math.floor(a.mono.length / blk), br: number[] = [];
  for (let b = 0; b < nb; b++) { let s = 0; for (let i = b * blk; i < (b + 1) * blk; i++) s += a.mono[i] * a.mono[i]; br.push(10 * Math.log10(s / blk + 1e-20)); }
  let top = -200; for (const v of br) if (v > top) top = v;
  const gate = Math.max(-60, top - 30), on = br.map((v, i) => (v > gate ? i : -1)).filter((i) => i >= 0);
  // A stem Live made from a song without that part still holds a little leakage, well under these lines.
  const nearSilent = peakDb < -40 || rmsDb < -60;
  return { rms_dbfs: r1(rmsDb), peak_dbfs: r1(peakDb), plays_share: nearSilent || !nb ? 0 : r2(on.length / nb),
    plays_from_s: nearSilent || !on.length ? null : r1(on[0] * blk / a.rate), plays_to_s: nearSilent || !on.length ? null : r1((on[on.length - 1] + 1) * blk / a.rate), near_silent: nearSilent };
}

// ---------------------------------------------------------------- pitch (YIN)

/**
 * YIN (de Cheveigné and Kawahara 2002), as vocal_range.py does it: the MIDI pitch per hop where the sound is clearly
 * pitched (aperiodicity under 0.2) and within 25 dB of the stem's loud parts, else NaN. A pitch that jumps a semitone
 * or more from both neighbours is dropped. Quiet frames are skipped before the FFT, which gives the same answer faster.
 */
export function pitchTrack(x: Float32Array, rate: number, hop: number, fmin: number, fmax: number, thresh = 0.15, apMax = 0.2, relDb = 25): Float64Array {
  const tauMin = Math.max(2, Math.floor(rate / fmax)), tauMax = Math.ceil(rate / fmin);
  const W = Math.max(tauMax + 1, Math.floor(0.03 * rate)), L = W + tauMax + 2;
  const nfr = x.length >= L ? Math.floor((x.length - L) / hop) + 1 : 0;
  const raw = new Float64Array(nfr).fill(NaN);
  if (!nfr) return raw;
  const c = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) c[i + 1] = c[i] + x[i] * x[i];
  const rms = new Float64Array(nfr), loud: number[] = [];
  for (let f = 0; f < nfr; f++) { const s = f * hop; rms[f] = Math.sqrt(Math.max(0, c[s + W] - c[s]) / W); if (rms[f] > 0) loud.push(rms[f]); }
  if (!loud.length) return raw;
  const gate = percentile(loud, 95) * Math.pow(10, -relDb / 20);
  let N = 1; while (N < L + W) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N), pr = new Float64Array(N), pi = new Float64Array(N);
  const dn = new Float64Array(tauMax + 2);
  for (let f = 0; f < nfr; f++) {
    if (!(rms[f] > gate)) continue;
    const s = f * hop;
    // the window (first W samples) and the whole frame, as one complex FFT; then their cross-correlation
    re.fill(0); im.fill(0);
    for (let j = 0; j < W; j++) re[j] = x[s + j];
    for (let j = 0; j < L; j++) im[j] = x[s + j];
    fft(re, im);
    for (let k = 0; k < N; k++) {
      const nk = (N - k) & (N - 1);
      const ar = 0.5 * (re[k] + re[nk]), ai = 0.5 * (im[k] - im[nk]), br = 0.5 * (im[k] + im[nk]), bi = 0.5 * (re[nk] - re[k]);
      pr[k] = ar * br + ai * bi; pi[k] = -(ar * bi - ai * br); // conj(conj(A) B), so a forward FFT inverts it
    }
    fft(pr, pi);
    const E0 = c[s + W] - c[s];
    dn[0] = 1;
    let cum = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      const d = E0 + (c[s + tau + W] - c[s + tau]) - 2 * pr[tau] / N;
      cum += d;
      dn[tau] = d * tau / Math.max(cum, 1e-12);
    }
    let t = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) if (dn[tau] < thresh) { t = tau; break; }
    if (t >= 0) { while (t + 1 <= tauMax && dn[t + 1] < dn[t]) t++; }
    else { t = tauMin; for (let tau = tauMin; tau <= tauMax; tau++) if (dn[tau] < dn[t]) t = tau; }
    const a = dn[t - 1], b = dn[t], g = dn[t + 1], den = a - 2 * b + g;
    const p = den > 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - g) / den)) : 0;
    const f0 = rate / (t + p);
    if (b < apMax && f0 >= fmin && f0 <= fmax) raw[f] = 69 + 12 * Math.log2(f0 / 440);
  }
  const m = Float64Array.from(raw);
  for (let f = 0; f < nfr; f++) {
    if (Number.isNaN(raw[f])) continue;
    const near = (f > 0 && Math.abs(raw[f] - raw[f - 1]) < 1) || (f + 1 < nfr && Math.abs(raw[f] - raw[f + 1]) < 1);
    if (!near) m[f] = NaN;
  }
  return m;
}

type Held = { note: number; start: number; dur: number };
/** Runs of one rounded note lasting minS seconds or more. */
function heldNotes(m: Float64Array, fps: number, minS = 0.15): Held[] {
  const out: Held[] = [];
  for (let k = 0; k < m.length;) {
    if (Number.isNaN(m[k])) { k++; continue; }
    const r = Math.round(m[k]);
    let j = k;
    while (j + 1 < m.length && !Number.isNaN(m[j + 1]) && Math.round(m[j + 1]) === r) j++;
    const dur = (j - k + 1) / fps;
    if (dur >= minS) out.push({ note: r, start: k / fps, dur });
    k = j + 1;
  }
  return out;
}

type Speller = (pc: number) => string;
// Notes in the key's own spelling (E♯ in C♯ major), with the octave of the key you press. Live's names (middle C =
// C3) use the plain key for E♯, B♯, C♭ and F♭, so a beginner finds the note: "E♯3 (Live F2)".
const PLAIN: Record<string, string> = { "E♯": "F", "B♯": "C", "C♭": "B", "F♭": "E" };
const sci = (m: number, spell: Speller) => `${spell(pcOf(m))}${Math.floor(Math.round(m) / 12) - 1}`;
const liveName = (m: number, spell: Speller) => `${PLAIN[spell(pcOf(m))] ?? spell(pcOf(m))}${Math.floor(Math.round(m) / 12) - 2}`;
const both = (m: number, spell: Speller) => `${sci(m, spell)} (Live ${liveName(m, spell)})`;

function keyName(k: { pc: number; mode: Mode }) {
  const K = S.keyInfo(k.pc, k.mode);
  return K.also ? `${K.name} (also written ${K.also})` : K.name;
}

/** What a pitched stem did: how long it was clearly pitched, its range, the notes with the most time, the key its notes fit. */
function pitchReport(m: Float64Array, fps: number, spell: Speller) {
  const vm: number[] = [];
  for (const v of m) if (!Number.isNaN(v)) vm.push(v);
  const seconds = vm.length / fps;
  if (vm.length < 20) return null;
  const held = heldNotes(m, fps);
  const tot = new Map<number, number>();
  for (const h of held) tot.set(h.note, (tot.get(h.note) ?? 0) + h.dur);
  const byTime = [...tot.entries()].sort((p, q) => q[1] - p[1]);
  const pcw = new Array(12).fill(0);
  for (const v of vm) pcw[pcOf(v)]++;
  const pmax = Math.max(...pcw) || 1;
  const ranked = S.rankKeys(pcw.map((v) => v / pmax));
  const pct = (q: number) => percentile(vm, q);
  const lo = held.length ? Math.min(...held.map((h) => h.note)) : null, hi = held.length ? Math.max(...held.map((h) => h.note)) : null;
  return {
    seconds, held, byTime, ranked, lo, hi,
    p: { 5: pct(5), 10: pct(10), 50: pct(50), 90: pct(90), 95: pct(95) },
    pcw: pcw.map((v) => v / pmax),
  };
}

// ---------------------------------------------------------------- drums: the half or the double

/** The onset curve's autocorrelation, normalised to 1 at lag 0. */
function acfOf(env: Float64Array): Float64Array {
  const n = env.length, m = mean(env);
  let size = 1; while (size < 2 * n) size <<= 1;
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = env[i] - m;
  fft(re, im);
  for (let i = 0; i < size; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft(re, im);
  const out = new Float64Array(n), a0 = re[0] || 1;
  for (let i = 0; i < n; i++) out[i] = re[i] / a0;
  return out;
}

const lagValue = (ac: Float64Array, lag: number) => { let v = -1; for (let i = Math.round(lag) - 2; i <= Math.round(lag) + 2; i++) if (i > 0 && i < ac.length && ac[i] > v) v = ac[i]; return v; };

/** After how many beats (1, 2, 4 or 8, at bpm) a lane's hits come round again: the shortest lag that repeats nearly as well as the best. */
function period(env: Float64Array, bpm: number) {
  const ac = acfOf(env), beat = 60 * FPS / bpm;
  const lags = [1, 2, 4, 8], v = lags.map((b) => lagValue(ac, b * beat)), top = Math.max(...v);
  const i = top >= 0.1 ? v.findIndex((x) => x >= 0.6 * top) : -1;
  return { beats: i >= 0 ? lags[i] : null, at: Object.fromEntries(lags.map((b, k) => [`${b}_beat${b === 1 ? "" : "s"}`, r2(v[k])])), value: i >= 0 ? v[i] : 0, below: i > 0 ? v[i - 1] : null };
}

/**
 * Onsets in linear amplitude, per band: how much the band's level rises from one frame to the next. song_analyze's
 * full-mix lanes rise in dB, which suits a mix, but in a drum stem it makes a quiet hat in the snare band count as
 * much as the snare itself. Normalised so the song's typical hit is about 1.
 */
function linearLanes(x: Float32Array, sets: S.Band[]): Float64Array[] {
  const n = 2048, banks = S.makeBanks(sets, n), frames = Math.floor(x.length / S.HOP) + 1;
  const A = banks.map(() => new Float64Array(frames));
  S.stft(x, n, S.HOP, (f, mag) => {
    for (let b = 0; b < banks.length; b++) {
      let e = 0;
      for (const { k0, w } of banks[b]) for (let j = 0; j < w.length; j++) { const m = mag[k0 + j]; e += m * m * w[j]; }
      A[b][f] = Math.sqrt(e);
    }
  });
  return A.map((a) => {
    const o = new Float64Array(frames);
    for (let t = 1; t < frames; t++) o[t] = Math.max(0, a[t] - a[t - 1]);
    const peaks: number[] = [];
    for (let t = 1; t + 1 < frames; t++) if (o[t] > 0 && o[t] >= o[t - 1] && o[t] >= o[t + 1]) peaks.push(o[t]);
    const ref = peaks.length ? percentile(peaks, 90) : 1;
    for (let t = 0; t < frames; t++) o[t] /= ref || 1;
    return o;
  });
}

export type DrumFeel = ReturnType<typeof drumFeel>;

/**
 * The tempo the drums make you feel. In most grooves the snare (or clap) lands on 2 and 4, so it comes round every
 * two felt beats: if it repeats every 2 beats of the measured pulse, the feel is that pulse; every 4, the half
 * (half time); every beat, the double. A guess at a convention, not a law: it says so.
 */
export function drumFeel(x: Float32Array) {
  const [all] = S.bandOnsets(x, 2048, [{ lo: 30, hi: 10000, nb: 64 }]);
  const [kick, snare, hats] = linearLanes(x, [{ lo: 30, hi: 150, nb: 8 }, { lo: 900, hi: 4000, nb: 16 }, { lo: 6000, hi: 10500, nb: 8 }]);
  const pl = S.pulse(all), t0 = pl.t0;
  const sn = period(snare, t0), kk = period(kick, t0);
  let felt: number | null = sn.beats ? t0 * 2 / sn.beats : null;
  if (felt !== null) {
    const opts = [t0 / 4, t0 / 2, t0, t0 * 2].filter((h) => h >= 50 && h <= 200);
    felt = opts.sort((p, q) => Math.abs(Math.log2(p / felt!)) - Math.abs(Math.log2(q / felt!)))[0] ?? null;
  }
  const clear = !!sn.beats && sn.value >= 0.25 && (sn.below === null || sn.below < 0.6 * sn.value);
  const bpm = felt ?? pl.lead;
  const beats = S.beatTrack(all, bpm), fit = S.fitBpm(beats);
  // the downbeat guess: kick on 1, snare on 2 and 4
  const kOn = S.at(kick, beats), sOn = S.at(snare, beats);
  const by4 = (v: number[]) => [0, 1, 2, 3].map((d) => mean(v.filter((_, i) => i % 4 === d)));
  const K4 = by4(kOn), S4 = by4(sOn), km = Math.max(...K4) || 1, sm = Math.max(...S4) || 1;
  const score = [0, 1, 2, 3].map((d) => K4[d] / km + 0.5 * (S4[(d + 1) % 4] + S4[(d + 3) % 4]) / sm - 0.5 * (S4[d] + S4[(d + 2) % 4]) / sm);
  const down = score.indexOf(Math.max(...score));
  const map: Record<string, string> = {}, steps: Record<string, number[]> = {};
  for (const [name, env] of [["kick", kick], ["snare", snare], ["hats", hats]] as [string, Float64Array][]) {
    const s16 = new Float64Array(16), c16 = new Float64Array(16);
    for (let j = 0; j + 1 < beats.length; j++) {
      const pos = (((j - down) % 4) + 4) % 4, a0 = beats[j], len = beats[j + 1] - a0;
      for (let f = Math.ceil(a0); f < beats[j + 1] && f < env.length; f++) {
        let st = Math.round((f - a0) / len * 4), bp = pos;
        if (st === 4) { st = 0; bp = (pos + 1) % 4; }
        s16[bp * 4 + st] += env[f]; c16[bp * 4 + st]++;
      }
    }
    const p = s16.map((v, i) => v / Math.max(c16[i], 1)), top = Math.max(...p) || 1;
    const chars = Array.from(p, (v) => (v / top >= 0.6 ? "X" : v / top >= 0.35 ? "x" : "."));
    map[name] = [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join(" ")).join(" | ");
    steps[name] = chars.map((c, i) => (c === "X" ? i + 1 : 0)).filter(Boolean);
  }
  return { all, pulse_bpm: t0, felt_bpm: felt, clear, snare: sn, kick: kk, beats, bpm, fit, map, steps, downbeat_s: (beats[down] ?? 0) / FPS };
}

// ---------------------------------------------------------------- chords

const QUALITIES: [string, number[], number][] = [["", [0, 4, 7], 1], ["m", [0, 3, 7], 1], ["7", [0, 4, 7, 10], 0.97], ["maj7", [0, 4, 7, 11], 0.97], ["m7", [0, 3, 7, 10], 0.97]];
/** The chord a 12-note chroma fits best. Sevenths must beat the triad by 3%; a root on the bass note gets a small lift. */
function chordOf(v: number[], bassPc: number | null, spell: Speller): { name: string; root: number; score: number } {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  let best = { name: "-", root: -1, score: -1 };
  for (let r = 0; r < 12; r++) for (const [q, iv, w] of QUALITIES) {
    let dot = 0;
    for (const i of iv) dot += v[(r + i) % 12];
    const sc = dot / (norm * Math.sqrt(iv.length)) * w + (bassPc === r ? 0.04 : 0);
    if (sc > best.score) best = { name: spell(r) + q, root: r, score: sc };
  }
  return best;
}

const cosine = (p: number[], q: number[]) => { let pq = 0, pp = 0, qq = 0; for (let i = 0; i < 12; i++) { pq += p[i] * q[i]; pp += p[i] * p[i]; qq += q[i] * q[i]; } return pp && qq ? pq / Math.sqrt(pp * qq) : 1; };
const mode = <T,>(xs: T[]): T | null => { const c = new Map<T, number>(); let best: T | null = null, n = 0; for (const x of xs) { const k = (c.get(x) ?? 0) + 1; c.set(x, k); if (k > n) { n = k; best = x; } } return best; };

/** Runs of equal labels: [label, count, first index]. */
function runs<T>(xs: T[]): [T, number, number][] {
  const out: [T, number, number][] = [];
  xs.forEach((x, i) => { if (out.length && out[out.length - 1][0] === x) out[out.length - 1][1]++; else out.push([x, 1, i]); });
  return out;
}

// ---------------------------------------------------------------- the report

export type StemOptions = { mixFile?: string; liveTempo?: number; labels?: Partial<Record<StemName, string>> };

export function analyzeStems(files: StemFiles, opts: StemOptions = {}): Record<string, unknown> {
  const started = Date.now();
  const given = STEM_NAMES.filter((n) => files[n]);
  if (!given.length) throw new Error("Give at least one stem: vocals, drums, bass or others (WAV files).");
  const audio: Partial<Record<StemName, Audio>> = {};
  for (const n of given) audio[n] = readWav(files[n]!);
  const levels = Object.fromEntries(given.map((n) => [n, stemLevel(audio[n]!)])) as Partial<Record<StemName, StemLevel>>;
  const active = (n: StemName) => !!audio[n] && !levels[n]!.near_silent;
  const xs: Partial<Record<StemName, Float32Array>> = {};
  for (const n of given) xs[n] = S.resample(audio[n]!.mono, SR, audio[n]!.rate);

  // ---- the whole song: the mix file, or the stems added together (Live's four stems add up to about the mix)
  let mix: any;
  if (opts.mixFile) mix = S.analyzeSong(opts.mixFile);
  else {
    const rate = audio[given[0]]!.rate, len = Math.max(...given.map((n) => Math.round(audio[n]!.mono.length * rate / audio[n]!.rate)));
    const nch = Math.max(...given.map((n) => audio[n]!.channels.length));
    const channels = Array.from({ length: nch }, () => new Float32Array(len));
    for (const n of given) {
      const a = audio[n]!;
      for (let c = 0; c < nch; c++) {
        const src = a.rate === rate ? a.channels[Math.min(c, a.channels.length - 1)] : S.resample(a.channels[Math.min(c, a.channels.length - 1)], rate, a.rate);
        const ch = channels[c];
        for (let i = 0; i < Math.min(len, src.length); i++) ch[i] += src[i];
      }
    }
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) { let s = 0; for (let c = 0; c < nch; c++) s += channels[c][i]; mono[i] = s / nch; }
    mix = S.analyzeSong("(the stems added together)", { rate, mono, channels, seconds: len / rate });
  }

  // ---- harmony: the Others stem's key (no voice, no drums, no bass in the way)
  let harmony: { best: S.KeyScore; second: S.KeyScore; relative: S.KeyScore; ranked: ReturnType<typeof S.rankKeys> } | null = null;
  let others: { C: Float64Array; frameSeconds: number; frames: number; minE: number; low: Int16Array; tOn: number; tOff: number } | null = null;
  if (active("others")) {
    const xo = xs.others!;
    const kp = S.peakChroma(S.resample(xo, 1, 2), SR / 2, 4096, S.KEY_HOP / 2, 55, 2500);
    const tun = S.tuningOf(kp.midi, kp.amp);
    const C = S.chromaFrames(kp, tun.semitones);
    const energies: number[] = [];
    for (let f = 0; f < kp.frames; f++) { let e = 0; for (let i = 0; i < 12; i++) e += C[f * 12 + i]; energies.push(e); }
    const minE = percentile(energies, 20);
    const ranked = S.rankKeys(S.chromaBetween(C, kp.frameSeconds, 0, xo.length / SR + 1, minE));
    const [rpc, rmode] = S.relativeOf(ranked.avg[0].pc, ranked.avg[0].mode);
    harmony = { best: ranked.avg[0], second: ranked.avg[1], relative: ranked.avg.find((k) => k.pc === rpc && k.mode === rmode)!, ranked };
    // the lowest clear note in each frame (a peak at least a third as loud as the frame's loudest)
    const low = new Int16Array(kp.frames).fill(-1), fmaxA = new Float64Array(kp.frames);
    for (let i = 0; i < kp.midi.length; i++) if (kp.amp[i] > fmaxA[kp.fi[i]]) fmaxA[kp.fi[i]] = kp.amp[i];
    for (let i = 0; i < kp.midi.length; i++) {
      const f = kp.fi[i];
      if (kp.amp[i] >= fmaxA[f] / 3 && energies[f] > minE && (low[f] < 0 || kp.midi[i] - tun.semitones < low[f])) low[f] = Math.round(kp.midi[i] - tun.semitones);
    }
    const lv = levels.others!;
    others = { C, frameSeconds: kp.frameSeconds, frames: kp.frames, minE, low, tOn: lv.plays_from_s ?? 0, tOff: lv.plays_to_s ?? xo.length / SR };
  }
  const homeKey = harmony ? harmony.best : { pc: keyPcOf(mix.key.best), mode: (String(mix.key?.best ?? "").endsWith("minor") ? "minor" : "major") as Mode, r: 0 };
  const spell = S.keyInfo(homeKey.pc, homeKey.mode).spell;

  // ---- melody: the Vocals stem, 70-1100 Hz
  let vocal: ReturnType<typeof pitchReport> = null;
  if (active("vocals")) vocal = pitchReport(pitchTrack(xs.vocals!, SR, 256, 70, 1100), FPS, spell);

  // ---- bass: the Bass stem, 30-300 Hz, at half the rate (the same 11.6 ms hop)
  let bassM: Float64Array | null = null, bass: ReturnType<typeof pitchReport> = null;
  const bassFps = (SR / 2) / 128;
  if (active("bass")) { bassM = pitchTrack(S.resample(xs.bass!, 1, 2), SR / 2, 128, 30, 300); bass = pitchReport(bassM, bassFps, spell); }

  // ---- drums
  const drums = active("drums") ? drumFeel(xs.drums!) : null;

  // ---- the beat grid for the chords: the drums' felt tempo if they're clear, else the full-mix tempo
  const mixBpm: number = mix.tempo.bpm;
  const gridBpm = drums?.clear && drums.felt_bpm ? drums.felt_bpm : mixBpm;
  let beatsS: number[];
  if (drums?.clear) beatsS = S.beatTrack(drums.all, gridBpm).map((b) => b / FPS);
  else {
    const len = Math.max(...given.map((n) => xs[n]!.length)), sum = new Float32Array(len);
    for (const n of given) { const x = xs[n]!; for (let i = 0; i < x.length; i++) sum[i] += x[i]; }
    const [all] = S.bandOnsets(sum, 2048, [{ lo: 30, hi: 10000, nb: 64 }]);
    beatsS = S.beatTrack(all, gridBpm).map((b) => b / FPS);
  }

  // ---- chords from the Others stem, one per beat, and the loop they make
  let chords: Record<string, unknown> | null = null, chordSeconds: number | null = null;
  if (others && beatsS.length > 8) {
    const o = others;
    const inSound = (t: number) => t >= o.tOn - 0.25 && t < o.tOff;
    const beatChroma = beatsS.slice(0, -1).map((b, i) => S.chromaBetween(o.C, o.frameSeconds, b, beatsS[i + 1], o.minE));
    const bassPc = beatsS.slice(0, -1).map((b, i) => {
      if (bassM) {
        const ps: number[] = [];
        for (let f = Math.ceil(b * bassFps); f < Math.min(bassM.length, beatsS[i + 1] * bassFps); f++) if (!Number.isNaN(bassM[f])) ps.push(pcOf(bassM[f]));
        if (ps.length >= 4) return mode(ps);
      }
      return null;
    });
    const lowPc = beatsS.slice(0, -1).map((b, i) => {
      const ps: number[] = [];
      for (let f = Math.ceil(b / o.frameSeconds); f < Math.min(o.frames, beatsS[i + 1] / o.frameSeconds); f++) if (o.low[f] >= 0) ps.push(o.low[f] % 12);
      return ps.length ? mode(ps) : null;
    });
    const idx = beatChroma.map((_, i) => i).filter((i) => inSound(beatsS[i]) && beatChroma[i].some((v) => v > 0));
    const label = beatChroma.map((v, i) => chordOf(v, bassPc[i] ?? lowPc[i], spell).name);
    // the downbeat guess: where the chords change most, in steps of 4 beats
    const change = [0, 1, 2, 3].map((d) => { const v: number[] = []; for (let j = d || 4; j < beatChroma.length; j += 4) if (inSound(beatsS[j])) v.push(1 - cosine(beatChroma[j - 1], beatChroma[j])); return mean(v); });
    const down = change.indexOf(Math.max(...change));
    // the loop: after how many bars the Others come round again (as song_analyze's chord cycle)
    let first = down; while (first < beatsS.length && !inSound(beatsS[first])) first += 4;
    const bars: number[][] = [];
    for (let i = first; i + 4 < beatChroma.length && inSound(beatsS[i]); i += 4) {
      const v = new Array(12).fill(0);
      for (let k = i; k < i + 4; k++) for (let p = 0; p < 12; p++) v[p] += beatChroma[k][p];
      bars.push(v);
    }
    let loop: Record<string, unknown> | null = null, loopChordBeats: number | null = null;
    const maxL = Math.min(16, Math.floor(bars.length / 2));
    if (maxL >= 1) {
      const scores = Array.from({ length: maxL }, (_, l) => { const v: number[] = []; for (let i = 0; i + l + 1 < bars.length; i++) v.push(cosine(bars[i], bars[i + l + 1])); return mean(v); });
      const top = Math.max(...scores), typical = percentile(scores, 50);
      const Lb = scores.findIndex((v) => v >= top - 0.25 * (top - typical)) + 1, P = 4 * Lb;
      const pos = Array.from({ length: P }, () => new Array(12).fill(0)), posBass: (number | null)[][] = Array.from({ length: P }, () => []);
      let reps = 0;
      for (let i = first; i + 1 < beatsS.length && inSound(beatsS[i]); i++) {
        const k = (i - first) % P;
        for (let p = 0; p < 12; p++) pos[k][p] += beatChroma[i][p];
        posBass[k].push(bassPc[i] ?? lowPc[i]);
        if (k === P - 1) reps++;
      }
      const posLabel = pos.map((v, k) => chordOf(v, mode(posBass[k].filter((x): x is number => x !== null)), spell).name);
      // a loop is a circle: start it at a chord change
      let rot = 0;
      if (posLabel[0] === posLabel[P - 1]) { rot = posLabel.findIndex((l, k) => k > 0 && l !== posLabel[k - 1]); if (rot < 0) rot = 0; }
      // Smooth the loop into chords: runs on one root join (D♯m then D♯m7), and a one-beat blip (a beat that
      // straddles a change, or the last chord still ringing) joins the neighbour whose notes it's closer to.
      type Seg = { len: number; v: number[]; bass: number[]; label: { name: string; root: number } };
      const relabel = (s: Seg) => { s.label = chordOf(s.v, mode(s.bass), spell); return s; };
      let segs: Seg[] = [];
      for (let j = 0; j < P; j++) {
        const k = (j + rot) % P, b = posBass[k].filter((x): x is number => x !== null);
        const last = segs[segs.length - 1];
        if (last && last.label.name === posLabel[k]) { last.len++; for (let p = 0; p < 12; p++) last.v[p] += pos[k][p]; last.bass.push(...b); }
        else segs.push(relabel({ len: 1, v: [...pos[k]], bass: b, label: { name: "", root: -1 } }));
      }
      const join = (a: Seg, b: Seg): Seg => relabel({ len: a.len + b.len, v: a.v.map((x, p) => x + b.v[p]), bass: [...a.bass, ...b.bass], label: a.label });
      for (let changed = true, guard = 0; changed && guard < 4 * P; guard++) {
        changed = false;
        for (let i = 0; i + 1 < segs.length; i++) if (segs[i].label.root === segs[i + 1].label.root) { segs.splice(i, 2, join(segs[i], segs[i + 1])); changed = true; break; }
        if (changed || segs.length < 3) continue;
        const typicalLen = percentile(segs.map((s) => s.len), 50);
        const shortest = segs.reduce((b, s, k) => (s.len < segs[b].len ? k : b), 0);
        const i = segs[shortest].len === 1 || segs[shortest].len < typicalLen / 2 ? shortest : -1;
        if (i < 0) break;
        const prev = segs[i - 1], next = segs[i + 1];
        const toPrev = prev && (!next || cosine(segs[i].v, prev.v) >= cosine(segs[i].v, next.v));
        if (toPrev) segs.splice(i - 1, 2, join(prev, segs[i])); else segs.splice(i, 2, join(segs[i], next));
        changed = true;
      }
      loop = { beats: P, bars: Lb, seconds: r2(P * 60 / gridBpm), times_through: reps, match: r2(scores[Lb - 1]), above_typical: r2(top - typical),
        confidence: (top - typical >= 0.05 && scores[Lb - 1] >= 0.85 ? "medium" : "low") as Level,
        chords: segs.map((s) => `${s.label.name} (${s.len} beat${s.len === 1 ? "" : "s"})`).join(" → "),
        starts_at_s: r1(beatsS[first + rot] ?? 0),
        where_it_starts: "A guess: a loop is a circle, so it may start on another chord in the song." };
      loopChordBeats = P / segs.length;
    }
    // how long a chord lasts: from the loop if there is one, else the typical run of one root through the song
    const songRuns = runs(idx.map((i) => label[i].match(/^[A-G][♯♭]?/)?.[0] ?? label[i]));
    const lens = songRuns.map(([, n]) => n).filter((n) => n >= 2);
    const typicalBeats = loopChordBeats ?? (lens.length ? percentile(lens, 50) : null);
    chordSeconds = typicalBeats ? typicalBeats * 60 / gridBpm : null;
    const counts = new Map<string, number>();
    for (const i of idx) counts.set(label[i], (counts.get(label[i]) ?? 0) + 1);
    const lowCounts = new Map<string, number>();
    for (const i of idx) if (lowPc[i] !== null) { const k = spell(lowPc[i]!); lowCounts.set(k, (lowCounts.get(k) ?? 0) + 1); }
    chords = {
      rough: true, at_bpm: r1(gridBpm), beats_read: idx.length,
      loop, most_common: [...counts.entries()].sort((p, q) => q[1] - p[1]).slice(0, 6).map(([k, n]) => `${k} ${n} beats`),
      lowest_note_per_beat: [...lowCounts.entries()].sort((p, q) => q[1] - p[1]).slice(0, 6).map(([k, n]) => `${k} ${n} beats`),
      typical_chord_length: typicalBeats ? { beats: Math.round(typicalBeats), seconds: r1(chordSeconds!) } : null,
      how: "From the Others stem: the notes in each beat matched to triads and 7th chords, with a small lift for a chord whose root is the bass note (from the Bass stem, or the lowest note in the Others). A 7th chord holds a triad (Am7 holds C major), so the labels can swap between the two.",
      check_by_ear: loop ? `Play the loop's roots (${(loop.chords as string).split(" → ").map((c) => c.split(" ")[0]).join(", ")}) under the song, one per chord. Where a root sounds wrong, try the chord's other notes.` : "Play along with the most common chords and keep the ones that sound right.",
    };
  }

  // ---- key leanings
  const melody = vocal ? { best: vocal.ranked.avg[0], second: vocal.ranked.avg[1] } : null;
  const same = (a: { pc: number; mode: Mode }, b: { pc: number; mode: Mode }) => a.pc === b.pc && a.mode === b.mode;
  const isRelative = (a: { pc: number; mode: Mode }, b: { pc: number; mode: Mode }) => { const [p, m] = S.relativeOf(a.pc, a.mode); return p === b.pc && m === b.mode; };
  let keyReading: string;
  if (harmony && melody) {
    const h = keyName(harmony.best), m = keyName(melody.best);
    keyReading = same(harmony.best, melody.best) ? `The chords and the melody agree: ${h}.`
      : isRelative(harmony.best, melody.best) ? `The chords lean ${h}; the melody leans ${m}. They are relative keys: the same notes with a different home. Your ear decides which note feels like home.`
      : `The chords lean ${h}; the melody leans ${m}. They aren't the same notes, so the melody may borrow notes, or the song may change key. Check by ear.`;
  } else if (harmony) keyReading = `The chords (Others stem) lean ${keyName(harmony.best)}. No vocal to compare.`;
  else if (melody) keyReading = `The melody leans ${keyName(melody.best)}. No Others stem to compare.`;
  else keyReading = `From the full mix: ${mix.key.best}.`;

  // ---- keys that suit this singer: the same melody moved up or down
  let singer: Record<string, unknown> | null = null;
  if (vocal && vocal.lo !== null && vocal.hi !== null) {
    const base = harmony ? harmony.best : melody!.best;
    const [rp, rm] = S.relativeOf(base.pc, base.mode);
    const core = [Math.round(vocal.p[10]), Math.round(vocal.p[90])], most = vocal.byTime[0][0];
    const fits = (s: number) => core[0] + s >= vocal.lo! && core[1] + s <= vocal.hi!;
    // where the song is now, one step down and up, then the nearest moves that keep the usual zone inside held notes
    const shifts = [0, -1, 1];
    for (const s of [-2, 2, -3, 3, -4, 4, -5, 5]) if (shifts.length < 5 && fits(s)) shifts.push(s);
    shifts.sort((a, b) => a - b);
    const options = shifts.map((s) => {
      const k = S.keyInfo((base.pc + s + 12) % 12, base.mode), rk = S.keyInfo((rp + s + 12) % 12, rm), sp = k.spell;
      return {
        key: `${k.name}${k.also ? ` (${k.also})` : ""} or its relative ${rk.name}`, move_semitones: s,
        melody_would_sit: `${sci(core[0] + s, sp)} to ${sci(core[1] + s, sp)} most of the time, mostly on ${sci(most + s, sp)}; held notes from ${sci(vocal.lo! + s, sp)} to ${sci(vocal.hi! + s, sp)}`,
        in_live_names: `${liveName(core[0] + s, sp)} to ${liveName(core[1] + s, sp)}, held ${liveName(vocal.lo! + s, sp)} to ${liveName(vocal.hi! + s, sp)}`,
        note: s === 0 ? "Where the song is now: the singer already sings it here." : fits(s) ? `The usual zone stays inside notes the singer already held in this song (${s > 0 ? "brighter, more push" : "darker, more relaxed"}: a guess, check by ear).`
          : `The usual zone goes ${s > 0 ? "above" : "below"} what the singer held in this song. Untested: try it with the singer.`,
      };
    });
    singer = {
      options, measured_from: "this song's Vocals stem only: it shows what was sung here, not the singer's whole range",
      usual_zone: `${both(core[0], spell)} to ${both(core[1], spell)} (10th to 90th percentile)`,
      how: "Each option moves the whole melody by the same number of semitones and names where it would land. A note on each says whether the usual zone stays inside notes the singer already held.",
      decide: "Options, not answers. Play the beat in two or three of these keys and let the singer try each one. The singer and you choose by ear.",
    };
  }

  // ---- bass
  let bassOut: Record<string, unknown>;
  if (bass && bass.held.length) {
    const sorted = bass.held;
    // join repeats of one note with short gaps, then split into stretches where the bass plays
    const joined: { note: number; start: number; end: number }[] = [];
    for (const h of sorted) {
      const last = joined[joined.length - 1];
      if (last && last.note === h.note && h.start - last.end < 0.5) last.end = h.start + h.dur;
      else joined.push({ note: h.note, start: h.start, end: h.start + h.dur });
    }
    const stretches: { from: number; to: number; notes: typeof joined }[] = [];
    for (const j of joined) {
      const st = stretches[stretches.length - 1];
      if (st && j.start - st.to < 4) { st.to = j.end; st.notes.push(j); } else stretches.push({ from: j.start, to: j.end, notes: [j] });
    }
    const main = stretches.filter((s) => s.to - s.from >= 2);
    const seq = (main.length ? main : stretches).flatMap((s) => s.notes).filter((j) => j.end - j.start >= 0.3);
    // a repeating pattern in the note order
    const names = seq.map((j) => j.note);
    let pattern: number[] = names, times = 1;
    for (let p = 1; p <= Math.min(8, names.length / 2); p++) {
      if (names.every((n, i) => i < p || n === names[i - p])) { pattern = names.slice(0, p); times = r1(names.length / p); break; }
    }
    const pcTime = new Map<number, number>();
    for (const [n, t] of bass.byTime) pcTime.set(n % 12, (pcTime.get(n % 12) ?? 0) + t);
    const pcs = [...pcTime.entries()].sort((p, q) => q[1] - p[1]);
    const tie = pcs.length > 1 && pcs[1][1] >= 0.85 * pcs[0][1];
    const home = tie ? null : spell(pcs[0][0]);
    bassOut = {
      from: "Bass stem (pitch tracking, 30-300 Hz)",
      plays: (main.length ? main : stretches).slice(0, 8).map((s) => `${mmss(s.from)} to ${mmss(s.to)}`),
      notes_in_order: seq.slice(0, 24).map((j) => `${sci(j.note, spell)} at ${mmss(j.start)} (${r1(j.end - j.start)} s)`),
      pattern: times >= 2 ? `${pattern.map((n) => sci(n, spell)).join(" → ")}, ${times} times` : null,
      seconds_per_note: bass.byTime.slice(0, 8).map(([n, t]) => `${both(n, spell)} ${r1(t)} s`),
      home_note: home ?? `no single home note: ${pcs.slice(0, 4).map(([p]) => spell(p)).join(", ")} have about the same time`,
      lowest: bass.lo !== null ? both(bass.lo, spell) : null, highest: bass.hi !== null ? both(bass.hi, spell) : null,
      pitched_seconds: r1(bass.seconds),
      check_by_ear: "Play these notes along with the bass. A note that sounds wrong may be a slide, a harmonic or leakage.",
    };
  } else {
    // no Bass stem (or a silent one): the low notes of the Others stem, under 120 Hz, as the full-mix tool does
    let fallback: string[] = [];
    if (others && xs.others) {
      const bp = S.peakChroma(S.resample(xs.others, 1, 4), SR / 4, 4096, S.KEY_HOP / 4, 32, 120);
      const B = S.chromaFrames(bp, 0);
      for (let i = 0; i + 4 < beatsS.length; i += 4) {
        const v = new Array(12).fill(0);
        for (let f = Math.ceil(beatsS[i] / bp.frameSeconds); f < Math.min(bp.frames, beatsS[i + 4] / bp.frameSeconds); f++) for (let k = 0; k < 12; k++) v[k] += B[f * 12 + k];
        if (v.some((q) => q > 0)) fallback.push(spell(v.indexOf(Math.max(...v))));
      }
    }
    const c = new Map<string, number>(); for (const n of fallback) c.set(n, (c.get(n) ?? 0) + 1);
    bassOut = {
      from: audio.bass ? "the Bass stem is near silent, so the low notes (under 120 Hz) of the Others stem" : "no Bass stem, so the low notes (under 120 Hz) of the Others stem",
      most_common_per_bar: [...c.entries()].sort((p, q) => q[1] - p[1]).slice(0, 6).map(([k, n]) => `${k} ${n} bars`),
      full_mix_bass: (mix.bass_per_bar as any)?.most_common ?? null,
      confidence: "low" as Level,
      check_by_ear: fallback.length ? "Rough: the strongest low note in each bar. Play along and keep what sounds right." : "Nothing steady under 120 Hz. The song may have no bass part; listen.",
    };
  }

  // ---- vocals
  let vocalsOut: Record<string, unknown> | null = null;
  if (vocal) {
    vocalsOut = {
      pitched_seconds: r1(vocal.seconds),
      held_range: vocal.lo !== null ? `${both(vocal.lo, spell)} to ${both(vocal.hi!, spell)}` : null,
      usual_zone_10_to_90: `${both(vocal.p[10], spell)} to ${both(vocal.p[90], spell)}`,
      band_5_to_95: `${both(vocal.p[5], spell)} to ${both(vocal.p[95], spell)}`,
      middle: both(vocal.p[50], spell),
      most_time: vocal.byTime.slice(0, 5).map(([n, t]) => `${both(n, spell)} ${r1(t)} s`),
      melody_key: { best: keyName(vocal.ranked.avg[0]), score: r2(vocal.ranked.avg[0].r), runner_up: keyName(vocal.ranked.avg[1]), runner_up_score: r2(vocal.ranked.avg[1].r) },
      leaks: "Stems leak: a stray low or high held note may be another part bleeding in, or a breath or slide. The 10th-to-90th band is the safer number.",
      check_by_ear: "Hum or play the usual zone's two notes with the song: the voice should sit between them most of the time.",
    };
  }

  // ---- tempo and feel
  const near = (a: number, b: number) => Math.abs(a / b - 1) < 0.03;
  let feel: Record<string, unknown>;
  if (drums) {
    feel = {
      from: "Drums stem",
      drum_pulse_bpm: r2(drums.pulse_bpm), felt_bpm: drums.felt_bpm ? r2(drums.felt_bpm) : null,
      tracked_bpm: drums.fit ? r2(drums.fit.bpm) : null,
      snare_comes_round_every: drums.snare.beats ? `${drums.snare.beats} beat${drums.snare.beats === 1 ? "" : "s"} of ${r1(drums.pulse_bpm)}` : "no clear repeat",
      kick_comes_round_every: drums.kick.beats ? `${drums.kick.beats} beat${drums.kick.beats === 1 ? "" : "s"} of ${r1(drums.pulse_bpm)}` : "no clear repeat",
      snare_repeat_strength: drums.snare.at,
      confidence: (drums.clear ? "medium" : "low") as Level,
      why: "In most grooves the snare or clap lands on 2 and 4, so the felt tempo is the one where the snare comes round every two beats. A convention, not a law: a song can put it elsewhere.",
      drum_map: { bpm: r1(drums.bpm), downbeat_guess_s: r2(drums.downbeat_s), grid: "1 . . . | 2 . . . | 3 . . . | 4 . . .", kick: drums.map.kick, snare: drums.map.snare, hats: drums.map.hats, key_to_marks: "X strong, x medium, . little or nothing" },
      agrees_with_full_mix: drums.felt_bpm ? (near(drums.felt_bpm, mixBpm) ? "same" : near(drums.felt_bpm, mixBpm / 2) ? "the half of the full-mix reading" : near(drums.felt_bpm, mixBpm * 2) ? "the double of the full-mix reading" : "different") : null,
      check_by_ear: "Clap on the snare. If your claps fall on 2 and 4 while you count the felt tempo, it's right.",
    };
  } else {
    feel = {
      from: audio.drums ? "no drums: the Drums stem is near silent" : "no Drums stem",
      no_drums: !!audio.drums,
      chord_rhythm: chordSeconds ? `a chord change about every ${r1(chordSeconds)} s (${Math.round(chordSeconds * mixBpm / 60)} beats at ${r1(mixBpm)})` : null,
      why: "Without drums, nothing in the audio picks the half or the double. The chord rhythm and the vocal phrasing set the feel; tap along and decide.",
    };
  }
  const liveTempo = opts.liveTempo;
  const liveNote = liveTempo && !near(liveTempo, mixBpm) && !near(liveTempo, mixBpm / 2) && !near(liveTempo, mixBpm * 2)
    ? `Live's set tempo is ${r2(liveTempo)} BPM, which doesn't match the measured ${r2(mixBpm)}. Separate Stems can change the set's tempo to Live's own guess; check it before you build on it.` : null;

  // ---- summary
  const lv = (n: StemName) => { const l = levels[n]; return l ? `${n} ${l.rms_dbfs} dBFS RMS (peak ${l.peak_dbfs})${l.near_silent ? ", near silent" : l.plays_share < 0.5 ? `, plays ${Math.round(100 * l.plays_share)}% of the time` : ""}` : null; };
  const summary: string[] = [
    `Stem levels: ${given.map(lv).filter(Boolean).join("; ")}.`,
    `Key: ${keyReading}`,
  ];
  if (drums) summary.push(drums.felt_bpm ? `Tempo feel (drums): ${r1(drums.felt_bpm)} BPM, ${drums.clear ? "medium" : "low"} confidence: the snare comes round every ${drums.snare.beats} beat${drums.snare.beats === 1 ? "" : "s"} of the ${r1(drums.pulse_bpm)} pulse. Kick on ${drums.steps.kick.join(", ") || "no clear step"}; snare on ${drums.steps.snare.join(", ") || "no clear step"} (16 steps).` : `Drums: present, but no clear repeating snare, so the half or double isn't settled.`);
  else summary.push(audio.drums ? `No drums: the Drums stem is near silent (${levels.drums!.rms_dbfs} dBFS RMS), so its tempo would be noise. Tempo ${r2(mixBpm)} BPM from the other stems; ${chordSeconds ? `a chord change about every ${r1(chordSeconds)} s sets the feel.` : "the feel is your call."}` : `No Drums stem: tempo ${r2(mixBpm)} BPM from the other stems.`);
  if (liveNote) summary.push(liveNote);
  if (bass && bassOut.pattern) summary.push(`Bass: ${bassOut.pattern}; plays ${(bassOut.plays as string[]).join(", ")}. Home note: ${bassOut.home_note}.`);
  else if (bass) summary.push(`Bass: plays ${(bassOut.plays as string[]).join(", ")}; most time on ${(bassOut.seconds_per_note as string[]).slice(0, 4).map((s) => s.split(" ")[0]).join(", ")}. Home note: ${bassOut.home_note}.`);
  else summary.push(`Bass: ${bassOut.from}: ${(bassOut.most_common_per_bar as string[]).slice(0, 4).join(", ") || "nothing steady"}.`);
  if (vocalsOut) summary.push(`Vocals: held notes ${vocalsOut.held_range}; usual zone ${vocalsOut.usual_zone_10_to_90}; most time on ${(vocalsOut.most_time as string[]).slice(0, 3).map((s) => s.replace(/ \(Live [^)]*\)/, "")).join(", ")}. Stems leak, so trust the usual zone over the extremes.`);
  if (chords?.loop) { const lp = chords.loop as any; summary.push(`Chord loop (Others stem, rough): ${lp.chords}, ${lp.beats} beats, ${lp.confidence} confidence.`); }
  if (singer) summary.push(`Keys that suit this singer (options): ${(singer.options as any[]).map((o) => `${o.key.split(" or ")[0]} (${o.move_semitones > 0 ? "+" : ""}${o.move_semitones})`).join(", ")}. Try two or three with the singer and choose by ear.`);
  summary.push(...(mix.summary as string[]).filter((l) => /^(Tuning|Short pattern|No clear short)/.test(l)), ...(mix.summary as string[]).slice(6));

  const { summary: _ms, ...fullMix } = mix;
  return {
    stems: Object.fromEntries(given.map((n) => [n, opts.labels?.[n] ?? files[n]])),
    mix: opts.mixFile ?? "the stems added together",
    summary,
    levels,
    key: {
      reading: keyReading,
      harmony: harmony ? { from: "Others stem", best: keyName(harmony.best), score: r2(harmony.best.r), relative: keyName(harmony.relative), relative_score: r2(harmony.relative.r), runner_up: keyName(harmony.second), notes: S.keyInfo(harmony.best.pc, harmony.best.mode).notes, top_five: harmony.ranked.avg.slice(0, 5).map((k) => `${keyName(k)} ${r2(k.r)}`) } : null,
      melody: melody ? { from: "Vocals stem", best: keyName(melody.best), score: r2(melody.best.r), runner_up: keyName(melody.second), runner_up_score: r2(melody.second.r) } : null,
      full_mix: mix.key.best,
      check_by_ear: "Play the scale over the song: it should fit. Then hum the note the song comes home to. When the chords and the melody lean to relative keys, only your ear can say which home it is.",
    },
    tempo: { bpm: r2(gridBpm), full_mix_bpm: r2(mixBpm), live_set_bpm: liveTempo ?? null, live_note: liveNote, feel },
    bass: bassOut,
    vocals: vocalsOut,
    keys_for_singer: singer,
    chords,
    full_mix: fullMix,
    leaks: "Stems aren't clean: each one holds a little of the others. A stray note in a range, or a 'hit' in a quiet drum stem, may be leakage. Levels say which stems really play.",
    took_seconds: r1((Date.now() - started) / 1000),
    note: "Measurements and options, not answers. Claude can't hear: report these, offer the options, and let the user decide by ear (which key feels like home, the half or the double, which key suits the singer).",
  };
}

/** The pitch class of a key name like "G major" or "B♭ minor". */
function keyPcOf(name: string): number {
  const n = String(name).split(" ")[0];
  const i = S.SHARP_NAMES.indexOf(n);
  if (i >= 0) return i;
  const flats = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
  return Math.max(0, flats.indexOf(n));
}
