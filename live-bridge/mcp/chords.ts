// Chord logic shared by the cello-live MCP server and Chord Coach's build step.
// Built on Spur's theory.ts (naming, key readings) and voicing.ts (laying a chord on the MPK's 25 keys).
// No Node imports, so it can be bundled or tested anywhere.

import { identifyChord, readChord, keyCard, nextChords, parseRoot, SHARPS, type Heard, type ScaleId } from "../vendor/spur/theory.ts";
import { voicing } from "../vendor/spur/voicing.ts";

const pcOf = (n: number) => ((n % 12) + 12) % 12;

// ---------- naming what's played ----------

/** Chords beyond Spur's triads and 7ths: tones above the bass, the Spur quality they read as, and their suffix. */
export const EXTENDED: { tones: number[]; base: string; minorish: boolean; suffix: string; roman: string }[] = [
  { tones: [0, 4, 7, 10, 2], base: "7", minorish: false, suffix: "9", roman: "9" },
  { tones: [0, 3, 7, 10, 2], base: "m7", minorish: true, suffix: "m9", roman: "9" },
  { tones: [0, 4, 7, 11, 2], base: "maj7", minorish: false, suffix: "maj9", roman: "maj9" },
  { tones: [0, 4, 10, 1], base: "7", minorish: false, suffix: "7(♭9)", roman: "7♭9" },
  { tones: [0, 4, 7, 10, 1], base: "7", minorish: false, suffix: "7(♭9)", roman: "7♭9" },
  { tones: [0, 4, 10, 9], base: "7", minorish: false, suffix: "13", roman: "13" },
  { tones: [0, 4, 7, 10, 9], base: "7", minorish: false, suffix: "13", roman: "13" },
  { tones: [0, 4, 10], base: "7", minorish: false, suffix: "7", roman: "7" },
  { tones: [0, 3, 10], base: "m7", minorish: true, suffix: "m7", roman: "7" },
  { tones: [0, 4, 11], base: "maj7", minorish: false, suffix: "maj7", roman: "maj7" },
  { tones: [0, 4, 7, 9], base: "maj", minorish: false, suffix: "6", roman: "6" },
  { tones: [0, 3, 7, 9], base: "min", minorish: true, suffix: "m6", roman: "6" },
  { tones: [0, 4, 7, 2], base: "maj", minorish: false, suffix: "add9", roman: "add9" },
  { tones: [0, 3, 7, 2], base: "min", minorish: true, suffix: "m(add9)", roman: "add9" },
];

/** A chord found in some notes, independent of key: Spur's reading, an extended shape, or a chord inside plus extras. */
export type Shape = { heard: Heard; ext: (typeof EXTENDED)[number] | null; extensions: number[] };

export function chordShape(notes: number[]): Shape | null {
  const h = identifyChord(notes);
  if (h && h.root === h.bass) return { heard: h, ext: null, extensions: [] };
  // extended and shell voicings Spur's shapes don't cover, read with the bass as the root
  // (also preferred over an inversion: C-E-G-A with C in the bass reads as C6, not Am7/C)
  if (notes.length >= 3) {
    const bass = pcOf(Math.min(...notes));
    const rel = [...new Set(notes.map((n) => (pcOf(n) - bass + 12) % 12))].sort((x, y) => x - y).join(",");
    const ext = EXTENDED.find((e) => [...e.tones].sort((x, y) => x - y).join(",") === rel);
    if (ext) return { heard: { root: bass, quality: ext.base, suffix: "", minorish: ext.minorish, bass }, ext, extensions: [] };
  }
  if (h) return { heard: h, ext: null, extensions: [] };
  // Spur's shapes stop at 7ths: for other extensions, name the biggest chord inside, keeping the bass
  if (notes.length > 3) {
    const bass = Math.min(...notes);
    const combos = (arr: number[], k: number): number[][] => k === 0 ? [[]] : arr.flatMap((x, i) => combos(arr.slice(i + 1), k - 1).map((c) => [x, ...c]));
    for (let drop = 1; drop <= 2; drop++) {
      for (const out of combos(notes.filter((n) => n !== bass), drop)) {
        const found = identifyChord(notes.filter((n) => !out.includes(n)));
        if (found) return { heard: found, ext: null, extensions: out };
      }
    }
  }
  return null;
}

/** Plain-sharps label for a shape, as Chord Coach shows it (no key needed): "Em9", "Am7/C", "C add F#". */
export function shapeLabel(s: Shape, spell: (pc: number) => string = (pc) => SHARPS[pcOf(pc)]!): string {
  const { heard: h } = s;
  if (s.ext) return spell(h.bass) + s.ext.suffix;
  const extra = s.extensions.length ? " add " + [...new Set(s.extensions.map((n) => spell(pcOf(n))))].join(" ") : "";
  return spell(h.root) + h.suffix + (h.bass !== h.root ? `/${spell(h.bass)}` : "") + extra;
}

/** theory_name_chord's answer: the chord's name and roman numeral in the key, in-key or borrowed, and what comes next. */
export function nameChord(notes: number[], keyPc: number, sc: ScaleId) {
  const s = chordShape(notes);
  if (!s) return { chord: null, note: "Not a chord I recognise (need 2+ notes forming a triad, 7th, sus or power chord)." };
  const next = nextChords(s.heard, keyPc, sc).map((n) => ({ chord: n.chord.name, roman: n.chord.roman, why: n.why }));
  const r = readChord(s.heard, keyPc, sc);
  const card = keyCard(keyPc, sc);
  if (s.ext) {
    return { ...r, name: card.keyboard[s.heard.bass]!.name + s.ext.suffix, roman: r.roman.replace(/(maj7|7)$/, "") + s.ext.roman, next };
  }
  return {
    ...r,
    ...(s.extensions.length ? { extensions: s.extensions.map((n) => card.keyboard[pcOf(n)]!.name), note: "Named from the chord inside; the extensions are extra colour on top (e.g. a 9th)." } : {}),
    next,
  };
}

// ---------- chord symbols ("Dm7", "B7b9", "F sharp minor") ----------

const QUALITIES: [RegExp, number[]][] = [
  [/^(maj13|M13|Δ13)$/, [0, 4, 7, 11, 2, 9]],
  [/^(m13|min13|-13)$/, [0, 3, 7, 10, 2, 9]],
  [/^13$/, [0, 4, 7, 10, 9]],
  [/^(m11|min11|-11)$/, [0, 3, 7, 10, 2, 5]],
  [/^11$/, [0, 4, 7, 10, 2, 5]],
  [/^(maj9|M9|Δ9)$/, [0, 4, 7, 11, 2]],
  [/^(m9|min9|-9)$/, [0, 3, 7, 10, 2]],
  [/^9$/, [0, 4, 7, 10, 2]],
  [/^7b9$/, [0, 4, 7, 10, 1]],
  [/^7#9$/, [0, 4, 7, 10, 3]],
  [/^7sus4?$/, [0, 5, 7, 10]],
  [/^(mmaj7|mM7|minmaj7)$/, [0, 3, 7, 11]],
  [/^(maj7|M7|Δ7?)$/, [0, 4, 7, 11]],
  [/^(m7b5|ø7?|min7b5|-7b5)$/, [0, 3, 6, 10]],
  [/^(dim7|°7|o7)$/, [0, 3, 6, 9]],
  [/^(m7|min7|-7)$/, [0, 3, 7, 10]],
  [/^7$/, [0, 4, 7, 10]],
  [/^(m6|min6|-6)$/, [0, 3, 7, 9]],
  [/^6$/, [0, 4, 7, 9]],
  [/^(madd9|minadd9)$/, [0, 3, 7, 2]],
  [/^(add9|add2)$/, [0, 4, 7, 2]],
  [/^sus2$/, [0, 2, 7]],
  [/^sus4?$/, [0, 5, 7]],
  [/^(dim|°|o)$/, [0, 3, 6]],
  [/^(aug|\+)$/, [0, 4, 8]],
  [/^5$/, [0, 7]],
  [/^(m|min|-)$/, [0, 3, 7]],
  [/^(maj|M)?$/, [0, 4, 7]],
];

/** Reads a chord symbol into pitch classes, root first, then the tones in stacked order (9ths and 13ths last). */
export function parseChordSymbol(input: string): { root: number; pcs: number[]; bass: number | null; label: string } {
  let s = input.trim()
    .replace(/♭/g, "b").replace(/♯/g, "#")
    .replace(/\s+(flat)\b/gi, "b").replace(/\s+(sharp)\b/gi, "#")
    .replace(/\s*\b(minor|min)\b\s*/gi, "m").replace(/\s*\b(major)\b\s*/gi, "maj").replace(/\s*\b(dominant|dom)\b\s*/gi, "")
    .replace(/\s*\b(diminished)\b\s*/gi, "dim").replace(/\s*\b(augmented)\b\s*/gi, "aug").replace(/\s*\b(seven(th)?)\b/gi, "7")
    .replace(/\s*\b(nine|ninth)\b/gi, "9").replace(/\s*\b(thirteen(th)?)\b/gi, "13").replace(/\s*\b(six(th)?)\b/gi, "6")
    .replace(/\s+/g, "");
  let bass: number | null = null;
  const slash = /\/([A-Ga-g][#b]?)$/.exec(s);
  if (slash) { bass = parseRoot(slash[1]!); s = s.slice(0, slash.index); }
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(s);
  if (!m) throw new Error(`Couldn't read the chord "${input}". Try a symbol like Dm7, A13, Cmaj9 or B7b9.`);
  const root = parseRoot(m[1]!.toUpperCase() + m[2]!);
  const quality = m[3]!.replace(/[()]/g, ""); // C7(b9) → C7b9, Am(maj7) → Ammaj7, Em(add9) → Emadd9
  const q = QUALITIES.find(([re]) => re.test(quality));
  if (root === null || !q) throw new Error(`Couldn't read the chord "${input}". Try a symbol like Dm7, A13, Cmaj9 or B7b9.`);
  const pcs = q[1].map((t) => (root + t) % 12);
  return { root, pcs, bass, label: input.trim() };
}

// ---------- voicing for the 25 keys (Spur's voicing.ts, with fallbacks so the root stays on the keyboard) ----------

/** MIDI notes on the MPK mini's 25 keys (48-72) for pitch classes, root first. Uses Spur's voicing():
 *  first the tones as given (stacked thirds), then without the 5th, then in close position, so wide chords
 *  with a high root (A13) keep their root and fit, the way a player would leave out the 5th. */
export function keysFor(pcs: number[], bass: number | null = null): number[] {
  if (!pcs.length) return [];
  const root = pcOf(pcs[0]!);
  const fifth = (root + 7) % 12;
  // a slash chord (G/B): the bass note goes first, so voicing() stacks the chord above it
  const low = bass !== null && pcOf(bass) !== root ? pcOf(bass) : root;
  const base = low === root ? pcs : [low, ...pcs.filter((p) => pcOf(p) !== low)];
  const noFifth = base.length >= 5 ? base.filter((p, i) => i === 0 || pcOf(p) !== fifth) : base;
  const close = (arr: number[]) => [arr[0]!, ...arr.slice(1).sort((a, b) => ((pcOf(a) - low + 12) % 12) - ((pcOf(b) - low + 12) % 12))];
  let best = voicing(base);
  for (const t of [base, noFifth, close(noFifth), close(base)]) {
    const v = voicing(t);
    if (v.length === t.length && v[0] === low) { best = v; break; }
  }
  return best.map((s) => 48 + s);
}

// ---------- what's sounding: held notes, ringing notes and the chord trail (Spur's keys strip behaviour) ----------

export const RING_MS = 1200;     // released notes ring this long, so an arpeggio reads as one chord
export const TRAIL_HOLD_MS = 300; // a chord joins the trail after sounding this long
export const BLOCK_MS = 80;       // notes let go within this of each other were a block chord, not an arpeggio

export type NoteEvent = { type: "on" | "off"; note: number; velocity: number; channel: number; timestamp: number };

/** Notes let go together (within BLOCK_MS of another release) were a finished block chord: they stop ringing
 *  when the next note is pressed on empty keys, so the old chord doesn't leak into the next one. An arpeggio's
 *  notes are let go one at a time, so they keep ringing. */
function dropBlockReleases(releasedAt: Map<number, number>) {
  const times = [...releasedAt];
  for (const [n, at] of times) if (times.some(([m, t]) => m !== n && Math.abs(t - at) <= BLOCK_MS)) releasedAt.delete(n);
}

/** Held notes and notes released in the last RING_MS, at time t, from an oldest-first event list. */
export function soundingAt(events: NoteEvent[], t: number): { held: number[]; ringing: number[] } {
  const held = new Set<number>();
  const releasedAt = new Map<number, number>();
  for (const e of events) {
    if (e.timestamp > t) break;
    if (e.type === "on" && e.velocity > 0) { if (!held.size) dropBlockReleases(releasedAt); held.add(e.note); releasedAt.delete(e.note); }
    else if (held.delete(e.note)) releasedAt.set(e.note, e.timestamp);
  }
  const ringing = [...releasedAt].filter(([n, at]) => !held.has(n) && t - at < RING_MS).map(([n]) => n);
  return { held: [...held].sort((a, b) => a - b), ringing: ringing.sort((a, b) => a - b) };
}

/** The chord sounding now. A ringing note only counts when it completes a chord (3+ notes),
 *  so a melody stays one note at a time. */
export function soundingChord(held: number[], ringing: number[]): { notes: number[]; shape: Shape; usedRinging: boolean } | null {
  const heldShape = held.length >= 2 ? chordShape(held) : null;
  if (ringing.length) {
    const all = [...new Set([...held, ...ringing])].sort((a, b) => a - b);
    const s = all.length >= 3 ? chordShape(all) : null;
    // over a chord that's already held, a ringing note counts only if it makes a clean chord, not "A add C"
    if (s && (!heldShape || !s.extensions.length)) return { notes: all, shape: s, usedRinging: true };
  }
  return heldShape ? { notes: held, shape: heldShape, usedRinging: false } : null;
}

/** Chords that sounded for at least TRAIL_HOLD_MS, oldest first, without repeats in a row. */
export function chordTrail(events: NoteEvent[], now: number, label: (notes: number[], s: Shape) => string = (_n, s) => shapeLabel(s)) {
  const points = new Set<number>();
  for (const e of events) { points.add(e.timestamp); if (e.type === "off" || e.velocity === 0) points.add(e.timestamp + RING_MS); }
  const times = [...points].filter((t) => t <= now).sort((a, b) => a - b);
  const trail: { chord: string; at: number; notes: number[] }[] = [];
  for (let i = 0; i < times.length; i++) {
    const end = times[i + 1] ?? now;
    if (end - times[i]! < TRAIL_HOLD_MS) continue;
    const { held, ringing } = soundingAt(events, times[i]!);
    const c = soundingChord(held, ringing);
    if (!c) continue;
    const name = label(c.notes, c.shape);
    if (trail.at(-1)?.chord !== name) trail.push({ chord: name, at: times[i]!, notes: c.notes });
  }
  return trail;
}

// ---------- Live's song scale → Spur scale ids ----------

const LIVE_SCALES: Record<string, ScaleId> = {
  major: "major", minor: "minor", dorian: "dorian", phrygian: "phrygian", lydian: "lydian", mixolydian: "mixolydian",
  locrian: "locrian", harmonicminor: "harmonicMinor", majorpentatonic: "majorPentatonic", minorpentatonic: "minorPentatonic",
  blues: "blues", ionian: "major", aeolian: "minor",
};
export function scaleFromLive(name: unknown): ScaleId | null {
  return LIVE_SCALES[String(name ?? "").toLowerCase().replace(/[^a-z]/g, "")] ?? null;
}
