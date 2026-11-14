// From Spur (celloopa/spotter, branch claude/spur, Mac working tree), sent by the Spur lead 2026-11-07 with the author's OK.
// The Key card's music theory: computed, never asked of a model. A key and scale in; the notes, how to spell them,
// the chords that fit, and where they sit on his MPK mini (25 keys), a guitar and a bass (standard tuning).

export const SCALES = {
  major: { label: "Major", steps: [0, 2, 4, 5, 7, 9, 11], parent: 0 },
  minor: { label: "Natural minor", steps: [0, 2, 3, 5, 7, 8, 10], parent: 3 },
  dorian: { label: "Dorian", steps: [0, 2, 3, 5, 7, 9, 10], parent: 10 },
  phrygian: { label: "Phrygian", steps: [0, 1, 3, 5, 7, 8, 10], parent: 8 },
  lydian: { label: "Lydian", steps: [0, 2, 4, 6, 7, 9, 11], parent: 7 },
  mixolydian: { label: "Mixolydian", steps: [0, 2, 4, 5, 7, 9, 10], parent: 5 },
  locrian: { label: "Locrian", steps: [0, 1, 3, 5, 6, 8, 10], parent: 1 },
  harmonicMinor: { label: "Harmonic minor", steps: [0, 2, 3, 5, 7, 8, 11], parent: 3 },
  majorPentatonic: { label: "Major pentatonic", steps: [0, 2, 4, 7, 9], parent: 0 },
  minorPentatonic: { label: "Minor pentatonic", steps: [0, 3, 5, 7, 10], parent: 3 },
  blues: { label: "Blues", steps: [0, 3, 5, 6, 7, 10], parent: 3 },
} as const satisfies Record<string, { label: string; steps: readonly number[]; parent: number }>;
// `parent`: semitones up from the root to the major key whose signature spells this scale (A minor → C major).

export type ScaleId = keyof typeof SCALES;

export const SHARPS = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const FLATS = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "C♭"];
/** Major keys written with flats (pitch classes of F, B♭, E♭, A♭, D♭, G♭). */
const FLAT_MAJORS = new Set([5, 10, 3, 8, 1, 6]);
export const ROOTS = SHARPS.map((sharp, pc) => ({ pc, label: sharp === FLATS[pc] ? sharp : `${sharp} / ${FLATS[pc]}` }));

export function parseRoot(s: string): number | null {
  if (/^\d{1,2}$/.test(s.trim())) return Number(s) < 12 ? Number(s) : null;
  const t = s.trim().replace(/#/g, "♯").replace(/b$/, "♭").replace(/^([a-g])/, (m) => m.toUpperCase());
  const i = SHARPS.indexOf(t);
  if (i >= 0) return i;
  const j = FLATS.indexOf(t);
  return j >= 0 ? j : t === "B♯" ? 0 : t === "E♯" ? 5 : t === "F♭" ? 4 : null;
}

/** Spells the scale's notes from the parent major key's signature (B♭ in F major, not A♯). */
export function speller(root: number, scale: ScaleId): (pc: number) => string {
  const parent = (root + SCALES[scale].parent) % 12;
  const names = FLAT_MAJORS.has(parent) ? FLATS : SHARPS;
  return (pc) => (pc === 11 && names === FLATS && parent !== 6 ? "B" : names[((pc % 12) + 12) % 12]!);
}

export type Chord = { degree: number; roman: string; name: string; notes: string[]; quality: "maj" | "min" | "dim" | "aug" };
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

/** Triads on each degree of a seven-note scale, by stacking thirds inside it. */
export function triads(root: number, steps: readonly number[], name: (pc: number) => string): Chord[] {
  if (steps.length !== 7) return [];
  return steps.map((_, d) => {
    const at = (k: number) => (root + steps[(d + k) % 7]! + (d + k >= 7 ? 12 : 0)) % 12;
    const [r, t, f] = [at(0), at(2), at(4)];
    const third = (t - r + 12) % 12, fifth = (f - r + 12) % 12;
    const quality = third === 4 && fifth === 7 ? "maj" : third === 3 && fifth === 7 ? "min" : third === 3 && fifth === 6 ? "dim" : "aug";
    const numeral = quality === "maj" || quality === "aug" ? ROMAN[d]! : ROMAN[d]!.toLowerCase();
    const suffix = quality === "min" ? "m" : quality === "dim" ? "dim" : quality === "aug" ? "aug" : "";
    return {
      degree: d + 1,
      roman: numeral + (quality === "dim" ? "°" : quality === "aug" ? "+" : ""),
      name: name(r) + suffix,
      notes: [r, t, f].map(name),
      quality,
    };
  });
}

export type Cell = { name: string; inScale: boolean; root: boolean };

export function keyCard(root: number, scale: ScaleId) {
  const s = SCALES[scale];
  const spell = speller(root, scale);
  // the blues "blue note" is a flatted fifth: E♭ in A blues, not D♯
  const flat = (n: string) => (n.endsWith("♯") ? n.slice(0, -1) : n.endsWith("♭") ? `${n.slice(0, -1)}𝄫` : `${n}♭`);
  const blueNote = scale === "blues" ? (root + 6) % 12 : -1;
  const name = (pc: number) => (((pc % 12) + 12) % 12 === blueNote ? flat(spell(root + 7)) : spell(pc));
  const pcs = new Set(s.steps.map((x) => (root + x) % 12));
  const cell = (pc: number): Cell => ({ name: name(pc), inScale: pcs.has(pc % 12), root: pc % 12 === root });
  // pentatonic and blues borrow their chords from the parent key (minor ones from natural minor, major from major)
  const chordScale: ScaleId = s.steps.length === 7 ? scale : scale === "majorPentatonic" ? "major" : "minor";
  const chordSpell = speller(root, chordScale);
  return {
    root,
    scale,
    title: `${name(root)} ${s.label.toLowerCase()}`,
    notes: s.steps.map((x) => name((root + x) % 12)),
    chords: triads(root, SCALES[chordScale].steps, chordSpell),
    progressions: progressions(root, scale),
    chordsFrom: chordScale === scale ? null : `${chordSpell(root)} ${SCALES[chordScale].label.toLowerCase()}`,
    // MPK mini: 25 keys, C to C two octaves up
    keyboard: Array.from({ length: 25 }, (_, i) => ({ ...cell(i), black: [1, 3, 6, 8, 10].includes(i % 12) })),
    // strings from highest to lowest, as tab reads; frets 0-12
    guitar: [4, 11, 7, 2, 9, 4].map((open) => Array.from({ length: 13 }, (_, f) => cell(open + f))),
    bass: [7, 2, 9, 4].map((open) => Array.from({ length: 13 }, (_, f) => cell(open + f))),
  };
}

// --- play-along: what he's playing, against the key (runs in the panel too; no Node imports in this file) ---------

const CHORD_SHAPES: { quality: string; suffix: string; tones: number[]; minorish: boolean }[] = [
  { quality: "maj", suffix: "", tones: [0, 4, 7], minorish: false },
  { quality: "min", suffix: "m", tones: [0, 3, 7], minorish: true },
  { quality: "dim", suffix: "dim", tones: [0, 3, 6], minorish: true },
  { quality: "aug", suffix: "aug", tones: [0, 4, 8], minorish: false },
  { quality: "sus2", suffix: "sus2", tones: [0, 2, 7], minorish: false },
  { quality: "sus4", suffix: "sus4", tones: [0, 5, 7], minorish: false },
  { quality: "7", suffix: "7", tones: [0, 4, 7, 10], minorish: false },
  { quality: "maj7", suffix: "maj7", tones: [0, 4, 7, 11], minorish: false },
  { quality: "m7", suffix: "m7", tones: [0, 3, 7, 10], minorish: true },
  { quality: "m7b5", suffix: "m7♭5", tones: [0, 3, 6, 10], minorish: true },
  { quality: "dim7", suffix: "dim7", tones: [0, 3, 6, 9], minorish: true },
  { quality: "5", suffix: "5", tones: [0, 7], minorish: false },
];

export type Heard = { root: number; quality: string; suffix: string; minorish: boolean; bass: number };

/** Names the chord in a set of held notes (MIDI numbers), preferring the bass note as the root. */
export function identifyChord(midi: number[]): Heard | null {
  if (midi.length < 2) return null;
  const pcs = [...new Set(midi.map((n) => ((n % 12) + 12) % 12))];
  const bass = ((Math.min(...midi) % 12) + 12) % 12;
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));
  const matches: Heard[] = [];
  for (const root of pcs) {
    const rel = pcs.map((p) => (p - root + 12) % 12);
    for (const s of CHORD_SHAPES) if (same(rel, s.tones)) matches.push({ root, quality: s.quality, suffix: s.suffix, minorish: s.minorish, bass });
  }
  return matches.find((m) => m.root === bass) ?? matches[0] ?? null;
}

const NUMERALS = ["I", "♭II", "II", "♭III", "III", "IV", "♭V", "V", "♭VI", "VI", "♭VII", "VII"];
const MODES: ScaleId[] = ["major", "minor", "dorian", "mixolydian", "lydian", "phrygian", "harmonicMinor"];

export type ChordReading = {
  name: string;
  roman: string;
  diatonic: boolean;
  /** For a chord outside the key: the mode on the same root that has it, or "V of …" for a secondary dominant. */
  borrowed: string | null;
};

export function readChord(h: Heard, keyRoot: number, scale: ScaleId): ChordReading {
  const s = SCALES[scale];
  const home: ScaleId = s.steps.length === 7 ? scale : scale === "majorPentatonic" ? "major" : "minor";
  const spell = speller(keyRoot, home);
  const tones = (CHORD_SHAPES.find((c) => c.quality === h.quality)?.tones ?? []).map((t) => (h.root + t) % 12);
  const inScale = (id: ScaleId) => tones.every((t) => SCALES[id].steps.some((x) => (keyRoot + x) % 12 === t));
  const diatonic = inScale(home);
  const sevenths = ["7", "maj7", "m7", "m7b5", "dim7"];
  const seventh = sevenths.includes(h.quality) ? (h.quality === "maj7" ? "maj7" : "7") : "";
  const keyTriads = triads(keyRoot, SCALES[home].steps, spell);
  // in the key: the scale's own numeral (VI in a minor key, as the chord chips say); outside: chromatic (♭VII)
  const own = diatonic ? keyTriads.find((c) => (keyRoot + SCALES[home].steps[c.degree - 1]!) % 12 === h.root) : undefined;
  const base = NUMERALS[(h.root - keyRoot + 12) % 12]!;
  const roman = own && !["sus2", "sus4", "5"].includes(h.quality)
    ? own.roman.replace(/[°+]$/, "") + (h.quality === "dim" || h.quality === "dim7" ? "°" : h.quality === "m7b5" ? "ø" : h.quality === "aug" ? "+" : "") + seventh
    : (h.minorish ? base.toLowerCase() : base) + (h.quality === "dim" || h.quality === "dim7" ? "°" : h.quality === "m7b5" ? "ø" : h.quality === "aug" ? "+" : "") + seventh;
  let borrowed: string | null = null;
  if (!diatonic) {
    // a major or dominant chord a fifth above a chord in the key: a secondary dominant ("V of vi")
    if (h.quality === "maj" || h.quality === "7") {
      const target = (h.root + 5) % 12;
      const t = keyTriads.find((c) => (keyRoot + SCALES[home].steps[c.degree - 1]!) % 12 === target);
      if (t && t.degree !== 1) borrowed = `V of ${t.roman}: it pulls toward ${t.name}`;
    }
    // the closest mode that has the chord: the fewest notes changed from the home scale
    // (harmonic minor only as a last resort: musicians call iv in a major key "borrowed from the parallel minor")
    const changed = (m: ScaleId) => SCALES[m].steps.filter((x) => !(SCALES[home].steps as readonly number[]).includes(x)).length + (m === "harmonicMinor" ? 1.5 : 0);
    const mode = borrowed ? undefined : MODES.filter((m) => m !== home && inScale(m)).sort((a, b) => changed(a) - changed(b))[0];
    if (mode) borrowed = `borrowed from ${spell(keyRoot)} ${SCALES[mode].label.toLowerCase()}`;
  }
  return { name: spell(h.root) + h.suffix + (h.bass !== h.root ? `/${spell(h.bass)}` : ""), roman, diatonic, borrowed };
}

export type NoteFit = { name: string; inScale: boolean; advice: string | null };

/** One played note against the key: fits, or how far it is from the nearest notes that do. */
export function noteFit(midi: number, keyRoot: number, scale: ScaleId): NoteFit {
  const pc = ((midi % 12) + 12) % 12;
  const card = keyCard(keyRoot, scale);
  const name = card.keyboard[pc]!.name;
  const inKey = (p: number) => card.keyboard[((p % 12) + 12) % 12]!.inScale;
  if (inKey(pc)) return { name, inScale: true, advice: null };
  const below = inKey(pc - 1) ? card.keyboard[(pc + 11) % 12]!.name : null;
  const above = inKey(pc + 1) ? card.keyboard[(pc + 1) % 12]!.name : null;
  const near = [below, above].filter(Boolean) as string[];
  const advice = near.length
    ? `${name} is outside ${card.title}. A half step ${below && above ? "either way" : below ? "down" : "up"} fits: ${near.join(" or ")}. As a passing note it can work.`
    : `${name} is outside ${card.title}.`;
  return { name, inScale: false, advice };
}

/** A short read on the last few chords (roman numerals, oldest first). */
export function progressionHint(romans: string[]): string | null {
  const last = romans.at(-1);
  if (!last) return null;
  if (/^V7?$|^vii[°ø]/.test(last)) return "That wants to resolve home: try I (or i) next.";
  if (romans.some((r) => r.startsWith("♭VII"))) return "♭VII gives a Mixolydian or rock colour; ♭VII to I is a strong, open landing.";
  if (romans.includes("IV") && romans.includes("iv")) return "IV then iv: the borrowed minor iv makes a soft, bittersweet turn back home.";
  if (romans.join(" ").includes("i ♭VI ♭III ♭VII") || romans.join(" ").includes("i VI III VII")) return "i, VI, III, VII: the classic minor loop. It never lands, which is why it loops so well.";
  return null;
}

// --- progressions: common ones per mode, and what usually comes next (computed, never asked of a model) -----------

/** Degrees (1-7 of the home scale) for well-known progressions, by scale. Pentatonic and blues use their parent key's. */
const PROGRESSIONS: Record<"major" | "minor" | "dorian" | "phrygian" | "lydian" | "mixolydian" | "locrian" | "harmonicMinor", { name: string; degrees: number[]; feel: string }[]> = {
  major: [
    { name: "Pop axis", degrees: [1, 5, 6, 4], feel: "bright, open, loops forever" },
    { name: "Doo-wop", degrees: [1, 6, 4, 5], feel: "warm and nostalgic" },
    { name: "Jazz turnaround", degrees: [2, 5, 1], feel: "tension, then home" },
    { name: "Plagal lift", degrees: [1, 4, 1, 5], feel: "simple, folk and gospel" },
  ],
  minor: [
    { name: "Minor loop", degrees: [1, 6, 3, 7], feel: "epic, never quite lands" },
    { name: "Descending", degrees: [1, 7, 6, 7], feel: "moody, hip-hop and lo-fi" },
    { name: "Minor plagal", degrees: [1, 4, 5, 1], feel: "dark, resolved" },
    { name: "Andalusian walk-down", degrees: [1, 7, 6, 5], feel: "dramatic, Spanish flavour" },
  ],
  dorian: [
    { name: "Dorian vamp", degrees: [1, 4], feel: "the raised 6th: soulful, funky" },
    { name: "Dorian loop", degrees: [1, 2, 4, 1], feel: "groovy, jazzy minor" },
  ],
  phrygian: [{ name: "Phrygian half-step", degrees: [1, 2, 1], feel: "the flat 2nd: dark, metal and flamenco" }],
  lydian: [{ name: "Lydian float", degrees: [1, 2, 1], feel: "the raised 4th: dreamy, film-score" }],
  mixolydian: [
    { name: "Mixolydian rock", degrees: [1, 7, 4, 1], feel: "the flat 7th: open, rock and anthemic" },
    { name: "Mixo vamp", degrees: [1, 7], feel: "laid back, jam band" },
  ],
  locrian: [{ name: "Locrian unease", degrees: [1, 2, 1], feel: "unstable on purpose" }],
  harmonicMinor: [{ name: "Harmonic cadence", degrees: [1, 4, 5, 1], feel: "a major V: classical pull home" }],
};

export type Progression = { name: string; feel: string; chords: Chord[] };

export function progressions(root: number, scale: ScaleId): Progression[] {
  const home = (SCALES[scale].steps.length === 7 ? scale : scale === "majorPentatonic" ? "major" : "minor") as keyof typeof PROGRESSIONS;
  const chords = triads(root, SCALES[home].steps, speller(root, home));
  return (PROGRESSIONS[home] ?? []).map((p) => ({ name: p.name, feel: p.feel, chords: p.degrees.map((d) => chords[d - 1]!) }));
}

// what tends to follow each degree (functional harmony), major-key and minor-key flavours
const NEXT_MAJOR: Record<number, { to: number; why: string }[]> = {
  1: [{ to: 4, why: "lifts away from home" }, { to: 5, why: "builds tension" }, { to: 6, why: "turns bittersweet" }],
  2: [{ to: 5, why: "the classic ii to V" }, { to: 4, why: "a softer step" }],
  3: [{ to: 6, why: "slides down a fifth" }, { to: 4, why: "opens up" }],
  4: [{ to: 5, why: "pushes toward home" }, { to: 1, why: "the plagal, \"amen\" landing" }, { to: 2, why: "keeps it moving" }],
  5: [{ to: 1, why: "back home: the strongest landing" }, { to: 6, why: "the deceptive move: a surprise" }],
  6: [{ to: 4, why: "the pop-axis turn" }, { to: 2, why: "sets up a ii to V" }, { to: 5, why: "heads for home" }],
  7: [{ to: 1, why: "leading tone straight home" }, { to: 3, why: "a gentle sidestep" }],
};
const NEXT_MINOR: Record<number, { to: number; why: string }[]> = {
  1: [{ to: 6, why: "the warm VI" }, { to: 7, why: "steps down, moody" }, { to: 4, why: "darker, heavier" }],
  2: [{ to: 5, why: "heads for home" }],
  3: [{ to: 6, why: "stays bright" }, { to: 7, why: "keeps climbing" }],
  4: [{ to: 1, why: "back home" }, { to: 5, why: "builds tension" }, { to: 7, why: "lifts" }],
  5: [{ to: 1, why: "home" }, { to: 6, why: "a deceptive turn" }],
  6: [{ to: 7, why: "climbs toward home" }, { to: 3, why: "brightens" }, { to: 4, why: "darkens" }],
  7: [{ to: 1, why: "lands home" }, { to: 3, why: "the relative major" }, { to: 6, why: "walks back down" }],
};

/** Two or three chords that usually follow `h` in this key, with why. Only for chords in the key.
 *  The NEXT_* tables describe major and natural-minor chords ("the warm VI"), so they serve only major, minor and
 *  harmonic minor, and a suggestion whose chord differs in quality from the one the table assumes is dropped
 *  (harmonic minor's major V keeps its "tension"/"home" moves). The other modes follow their own progressions.
 *  (Synced from Spur 2026-11-07 after the Dorian "warm VI" fix.) */
export function nextChords(h: Heard, keyRoot: number, scale: ScaleId): { chord: Chord; why: string }[] {
  const home = (SCALES[scale].steps.length === 7 ? scale : scale === "majorPentatonic" ? "major" : "minor") as ScaleId;
  const steps = SCALES[home].steps as readonly number[];
  const degree = steps.findIndex((x) => (keyRoot + x) % 12 === h.root) + 1;
  if (!degree) return [];
  const chords = triads(keyRoot, steps, speller(keyRoot, home));
  if (home === "major" || home === "minor" || home === "harmonicMinor") {
    const reference: ScaleId = home === "major" ? "major" : "minor";
    const expected = triads(keyRoot, SCALES[reference].steps, speller(keyRoot, reference));
    const fits = (d: number) => chords[d - 1]!.quality === expected[d - 1]!.quality || (home === "harmonicMinor" && d === 5);
    if (!fits(degree)) return [];
    return (home === "major" ? NEXT_MAJOR : NEXT_MINOR)[degree]!
      .filter((n) => fits(n.to))
      .map((n) => ({ chord: chords[n.to - 1]!, why: n.why }));
  }
  // modes: whatever follows this degree in the mode's own progressions (looping), named by the progression
  const out: { chord: Chord; why: string }[] = [];
  for (const p of PROGRESSIONS[home as keyof typeof PROGRESSIONS] ?? []) {
    p.degrees.forEach((d, i) => {
      const to = p.degrees[(i + 1) % p.degrees.length]!;
      if (d === degree && to !== degree && !out.some((o) => o.chord === chords[to - 1])) out.push({ chord: chords[to - 1]!, why: `the ${p.name}` });
    });
  }
  return out.slice(0, 3);
}
