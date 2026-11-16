# Playbook: mixing

Use for "it sounds muddy", "the kick and bass fight", "check my levels", "make room for the vocal", ducking and gain staging.

## Levels first (no colours)

1. Play the busiest part (the user presses play, or `live_transport` play when asked).
2. `live_get_levels`: each track and Main get a peak in dB (`peak_db`, as Live's meter shows it) and a word: silent, low (under -18 dB), healthy, hot (above -3 dB), near the top (0 dB or over).
3. Report by **track name and word**, never by meter colour: "Drums: hot. Vox Slices: low. Main: near the top, so turn things down before adding a limiter."
4. Fix level with **Utility's Output** or the clip's gain first, so the faders stay free for the mix.

## An EQ starting recipe (per track, then listen)

- **Low cut** on everything that isn't kick or bass: start around 80-120 Hz for vocals and keys, higher (150-250 Hz) for pads and hats. Ask the user to sweep it up until the sound thins, then back a little.
- **Low-mid dip** for mud: a wide cut of 2-4 dB around 250-400 Hz on pads, guitars and keys.
- **Kick vs bass:** pick which owns the lowest octave. Cut the other one there a little.
- Everything here is a starting point. You can't hear it: ask the user to A/B with EQ Eight's Device On switch.

## Ducking (sidechain)

- **Live's Compressor** keyed from the kick: `live_set_routing` with the Compressor, `source` the drums track, `channel` "1 kick" (one Drum Rack chain) and "Post FX". Then threshold down until the gain reduction moves on each kick, ratio 4:1 or more, attack fast, release to taste (100-200 ms to start).
- Choose **Post FX** vs **Pre FX** on purpose: Post FX follows any filters on the drums (a filtered-out kick stops ducking); Pre FX doesn't.
- **Plugin sidechains (Kickstart 2 and other VST/AU)** can't be set from a script: teach the user the two clicks (the plugin's Sidechain chooser, then Post FX).

## Shared effects: return tracks and buses

When several tracks each carry their own reverb or delay, it gets washy and heavy. Two ways to share:

- **Return track** (one reverb or delay, each track sends a little): `live_create_return_track`, load the effect on it at 100 % wet, then raise each track's send (`live_set_device_param`, device `mixer`, "Send A"...). Return tracks and Main have track numbers too (`live_status`: `returns`, `main`).
- **Bus** (several tracks through one chain, e.g. all vocals through one compressor and EQ): the bridge can't group tracks, so build it from routing: `live_create_audio_track` "Vocals Bus", each track's output to the bus (`live_set_routing`, `io: "output"`), the bus's Monitor to In (`live_set_monitoring`), effects once on the bus. Read `live_status` again afterwards: the track numbers after the new track shift.
- Then remove or switch off the per-track copies, one at a time, with the user listening. Only when the user asks.

## Stereo and low end

- **Bass Mono:** Utility's Bass Mono on bass, 808 and anything under an Auto Pan, around 120 Hz, so the low end stays centred.
- Auto Pan on a low sound without Bass Mono makes the bass wander: check for it.

## Always

- One change at a time, then ask how it sounds.
- Say what changed and how to undo it.
- Mark guesses as guesses ("by the numbers, the vocal is 6 dB under the drums; does it feel buried?").
