// From Spur (celloopa/spotter, Mac working tree, not in git yet), sent by the Spur lead 2026-11-07 with the author's OK.
/** Short-lived, local evidence of played MIDI notes. No model, audio inference, or persistence. */
export type PlayedMidiEvent = {
  type: "on" | "off";
  note: number;
  velocity: number;
  /** Raw MIDI channel: 0–15. Human-readable summaries use 1–16. */
  channel: number;
  /** Epoch milliseconds from the sender's Date.now(), not performance.now(). */
  timestamp: number;
};

const WINDOW_MS = 30_000;
const MAX_EVENTS = 256;
const MAX_BATCH = 256;
const MAX_SUMMARY = 1_000;
const PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const name = (note: number): string => `${PITCHES[note % 12]}${Math.floor(note / 12) - 1}`;
const seconds = (ms: number): string => `${(ms / 1_000).toFixed(2)}s`;
const key = (event: PlayedMidiEvent): string => `${event.channel}:${event.note}`;
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

function validated(raw: unknown, now: number): PlayedMidiEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if ((e.type !== "on" && e.type !== "off") || !integer(e.note, 0, 127) ||
      !integer(e.velocity, 0, 127) || !integer(e.channel, 0, 15) ||
      !integer(e.timestamp, 0, now) || e.timestamp < now - WINDOW_MS) return null;
  return { type: e.type === "on" && e.velocity === 0 ? "off" : e.type,
    note: e.note, velocity: e.velocity, channel: e.channel, timestamp: e.timestamp };
}

/** Exact consecutive pitch/onset-group repetitions, not a claim of rhythm, key, chord, or emotion. */
function repeatedPattern(onsets: PlayedMidiEvent[]): string | null {
  const groups: { at: number; notes: string[] }[] = [];
  for (const e of onsets) {
    const last = groups.at(-1);
    const label = `${name(e.note)}[ch${e.channel + 1}]`;
    if (last?.at === e.timestamp) last.notes.push(label);
    else groups.push({ at: e.timestamp, notes: [label] });
  }
  const sequence = groups.slice(-24).map((g) => g.notes.sort().join("+"));
  for (let length = Math.min(4, Math.floor(sequence.length / 2)); length >= 1; length--) {
    for (let start = sequence.length - length * 2; start >= 0; start--) {
      const pattern = sequence.slice(start, start + length);
      let repeats = 1;
      while (start + (repeats + 1) * length <= sequence.length &&
             pattern.every((n, i) => n === sequence[start + repeats * length + i])) repeats++;
      if (repeats > 1) return `Repeated onset pattern: ${pattern.join(" → ")} (${repeats}× consecutive; pitch order only).`;
    }
  }
  return null;
}

export function createRecentPlaying(initialContextId: string | null = null) {
  let contextId = initialContextId;
  let events: PlayedMidiEvent[] = [];
  let lastTimestamp = -1;
  let lastNoteOnAt: number | null = null;
  let droppedThroughAt: number | null = null;

  function prune(now: number) {
    events = events.filter((e) => e.timestamp >= now - WINDOW_MS);
  }

  return {
    /** Resets even for the same identity. Caller invokes on song/session changes or reconnects. */
    reset(nextContextId: string | null) {
      contextId = nextContextId;
      events = [];
      lastTimestamp = -1;
      lastNoteOnAt = null;
      droppedThroughAt = null;
    },

    /** Reject malformed, future, stale and out-of-order samples; equal timestamps retain sender order. */
    ingest(batch: readonly unknown[], now = Date.now()): { accepted: number; rejected: number } {
      if (!Number.isSafeInteger(now) || now < 0 || !Array.isArray(batch)) return { accepted: 0, rejected: Array.isArray(batch) ? batch.length : 1 };
      // Reject oversize batches atomically: do not retain a misleading half-phrase.
      if (batch.length > MAX_BATCH) return { accepted: 0, rejected: batch.length };
      prune(now);
      let accepted = 0;
      for (const raw of batch) {
        const e = validated(raw, now);
        if (!e || e.timestamp < lastTimestamp) continue;
        events.push(e);
        lastTimestamp = e.timestamp;
        if (e.type === "on") lastNoteOnAt = e.timestamp;
        accepted++;
      }
      if (events.length > MAX_EVENTS) {
        const removed = events.splice(0, events.length - MAX_EVENTS);
        droppedThroughAt = removed.at(-1)!.timestamp;
      }
      return { accepted, rejected: batch.length - accepted };
    },

    summary(now = Date.now()): string {
      if (!Number.isSafeInteger(now) || now < 0 || now < lastTimestamp) return "Recent MIDI unavailable: invalid or backward clock; no timing claim.";
      prune(now);
      const scope = contextId === null ? "current session" : `context ${JSON.stringify(contextId.slice(0, 80))}`;
      if (lastNoteOnAt === null) return `Recent MIDI absent (${scope}): no note-ons observed.`;
      const onsets = events.filter((e) => e.type === "on");
      if (!onsets.length) return `Recent MIDI stale (${scope}): no retained note-ons in the last 30s; last observed ${seconds(now - lastNoteOnAt)} ago. Held state unknown.`;

      type Span = { event: PlayedMidiEvent; end?: number; retriggered?: boolean };
      const spans: Span[] = [];
      const active = new Map<string, Span>();
      for (const e of events) {
        const id = key(e);
        if (e.type === "on") {
          const previous = active.get(id);
          if (previous) previous.retriggered = true;
          const span: Span = { event: e };
          spans.push(span);
          active.set(id, span);
        } else {
          const span = active.get(id);
          if (span) { span.end = e.timestamp; active.delete(id); }
          // Off without a retained on gives no known start or duration.
        }
      }
      const first = onsets[0]!.timestamp;
      const last = onsets.at(-1)!.timestamp;
      const notes = spans.slice(-10).map(({ event: e, end, retriggered }) => {
        const duration = end !== undefined ? `${seconds(end - e.timestamp)} released`
          : retriggered ? "release unknown (retriggered)"
          : `unreleased; ${seconds(now - e.timestamp)} since on`;
        return `${name(e.note)}[ch${e.channel + 1}] +${seconds(e.timestamp - first)} ${duration}`;
      });
      const lines = [
        `Recent MIDI (${scope}; last 30s, note events only): ${onsets.length} buffered note-ons; onset span ${seconds(last - first)}; latest ${seconds(now - last)} ago.`,
        "Unreleased means no note-off observed, not confirmed sustain or sound. No key or mood inferred.",
        ...(droppedThroughAt !== null && droppedThroughAt >= now - WINDOW_MS ? ["Buffer capped; older events omitted, so some releases may be unknown."] : []),
        `Notes oldest→newest: ${notes.join("; ")}.`,
        ...(spans.length > 10 ? ["Earlier notes omitted from this excerpt."] : []),
      ];
      const motif = repeatedPattern(onsets);
      if (motif) lines.push(motif);
      const text = lines.join("\n");
      return text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY - 11)} [excerpt]`;
    },
  };
}
