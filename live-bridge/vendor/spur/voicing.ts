// From Spur (celloopa/spotter, branch claude/spur, Mac working tree), sent by the Spur lead 2026-11-07 with the author's OK.
// How a chord sits on the MPK mini (25 keys, C to C): the root in the lower octave, the other tones stacked above
// it. Used by the island to sound a chord and by the keys strip to light it. No Node imports: served to the pages.

/** Semitones above the MPK's low C (0-24) for a chord's pitch classes, root first. */
export function voicing(pcs: number[]): number[] {
  if (!pcs.length) return [];
  const out = [((pcs[0]! % 12) + 12) % 12];
  for (const pc of pcs.slice(1)) {
    let s = ((pc % 12) + 12) % 12;
    while (s <= out[out.length - 1]!) s += 12;
    out.push(s);
  }
  // keep it on the keyboard: a voicing that runs past the top C drops an octave
  return out.at(-1)! > 24 ? out.map((s) => s - 12).filter((s) => s >= 0) : out;
}

/** MIDI numbers to sound: the voicing from C3, with the root doubled an octave down for weight. */
export function chordMidi(pcs: number[]): number[] {
  const v = voicing(pcs);
  return v.length ? [36 + v[0]!, ...v.map((s) => 48 + s)] : [];
}

/** Seconds per bar at Logic's tempo, in 4/4 unless told otherwise ("3/4"). */
export function barSeconds(tempo: number | null | undefined, timeSignature?: string | null): number {
  const beats = Number(/^(\d+)\//.exec(timeSignature ?? "")?.[1]) || 4;
  const bpm = tempo && tempo > 20 && tempo < 400 ? tempo : 90;
  return (60 / bpm) * beats;
}
