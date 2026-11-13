# Spur keys strip: what to borrow for Chord Coach (step 2)

From the Spur lead, 2026-11-07. `src/strip.ts` and `src/theme.ts` are reference only, not drop-ins. Ask the Spur lead for the verbatim files if needed.

## Layout
One 1220 px card in three columns.
- **Left:** a label, the chord in big display type, and its roman numeral. A chord outside the key gets "borrowed" in terracotta.
- **Middle:** the 25 MPK keys. The key's notes are dotted, held notes are filled in the accent colour, and out-of-key held notes get a hatched outline.
- **Right:** the bass note with a cents needle, and the last four chords.
- **Footer:**
  - Left: a one-line read on how the notes fit the key.
  - Right: "Next, try X (why) or Y (why)".
  - Below: progression buttons.

## Behaviour
- **Ringing notes:** released notes ring for 1.2 s, so an arpeggio reads as one chord. A ringing note only counts when it completes a chord, so a melody stays one note at a time.
- **Last played:** after the last note, the strip lingers for 8 s.
- **Trail:** a chord joins the trail after being held for 300 ms.
- **Progression buttons:** one steps through its chords a bar at a time at the host tempo (`voicing.barSeconds`), lighting each voicing, and loops until tapped again.
- **Bass pitch:** comes from the 2i2 via getUserMedia plus `src/pitch.ts`, and shows only after it's steady for three frames. `pitch.ts` hasn't been sent; ask for it.
- **Keyboard fold:** the strip maps MIDI to the 25 keys relative to C3 (48), so check the MPK mini IV's default octave.

## Spur-specific parts to replace
- `window.spotterMidi(status, note, vel)`: feed it from Web MIDI, or from the Live bridge / Max.
- `/api/logic`: key, tempo and play state. Replace with the bridge's `get_session`.
- `/api/play` and `/api/playing`: Spur's song memory and recent-playing feed.
- `window.webkit.messageHandlers.spotter`: the Mac helper's show/hide and size channel.

## Theme (Spur palette)
- Paper `#f3ede2`, midnight `#001a11`, terracotta `#b8472f` (text `#a9402a`, dusk `#ee8a6e`).
- Fonts: Instrument Sans, Bricolage Grotesque, DM Mono.
- Radii: controls 10px, cards 12px.

## Also available from Spur
- `src/pitch.ts`: bass and guitar pitch over the 2i2.
- `src/ear.ts`: loudness, true peak and band balance of a recording, measured locally.
