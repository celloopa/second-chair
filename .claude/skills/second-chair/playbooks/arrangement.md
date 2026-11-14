# Playbook: arrangement and automation

Use for the timeline: "what's where", placing and moving clips, recording rows into the Arrangement, volume builds, fades, filter sweeps and any other automation.

## Read before you write

- `live_get_arrangement`: every track's clips by bar, the last bar used, and the **Arrangement Loop**. If the loop is on, recording wraps round and records over earlier bars: say so before any recording.
- Talk in bars from 1 and track names: "Vox motif on Vox Slices, bars 33-41."

## Clips

- **Place:** `live_place_clip` (a Session clip at a bar, `bars` to repeat it). It never covers clips; if it refuses, it names what's in the way.
- **Move / delete:** `live_arrangement_clip` with the clip's name and start bar from `live_get_arrangement`. Only when the user asks. A move is revertible; a delete needs `live_undo` straight away.
- Trim and split: by hand (no script access). Teach: select the clip, drag its edge; Ctrl+E splits at the cursor.
- **After every write,** read `live_get_arrangement` again and say what's where now.

## Recording Session rows into the Arrangement

1. Arrangement Loop **off** (or set to the whole song).
2. `live_transport stop_all_clips` (launched clips otherwise keep recording), `jump` to the start bar.
3. `record_on`; the user launches the rows; then `record_off`, `stop`, `back_to_arrangement`.
4. With 1 Bar launch quantization the first row starts on bar 2: say so, or set quantization first.
Teach the steps; press the buttons only when the user asks.

## Automation on the timeline: `live_record_automation`

1. **Automate a Utility's Output, not the fader.** Add a Utility at the end of the chain if there isn't one, so the user keeps the fader for mixing.
2. **Live must be stopped,** and the user not working in Live. **Say first that Live will play the bars out loud.**
3. One call per take. Shapes:
   - Ramp: `start` / `end`, with `curve` (`linear`, `ease_in`, `ease_out`, `s`, `step`).
   - Your points: `points: [{bar, text|percent}]` ("quiet at 33, louder at 37, full at 41").
   - Wobble: `lfo: {shape, rate, low, high}`. At least 0.8 s per cycle when recorded; faster needs Live's LFO device.
   - Several knobs at once: `lanes`.
4. **Ramp up and stay:** add `hold_to_bar` (a bar, or `"end"`). Without it, after `to_bar` the lane goes back to what it had there before.
5. **Check `read_back_ok`** in the result. If it's false, `read_back_mismatch` lists the bars that don't match: tell the user which. For other bars use `live_read_knob`.
   - The very start of the song (the first moment of bar 1) can't be reached by a take: Live writes a take's first value a moment late. An old point there has to be deleted by hand: click it in the lane, press Delete.
6. Undo: `live_undo` straight away takes the whole take back (`live_revert` can't).

What the bridge handles for you: on an empty lane it first records the old setting in the bar before (so earlier bars don't jump), and it keeps Live writing during flat holds with tiny, inaudible nudges.

## Automation inside a Session clip: `live_automate`

Same shapes, written exactly, no speed limit. Give the clip's `slot`; bars count from the clip's start.

## Teaching it by hand

Press A to show automation lanes, pick the device and knob in the track's chooser, click to add breakpoints, drag them. Alt-drag a segment to curve it. Draw mode (B) draws steps on the grid.
