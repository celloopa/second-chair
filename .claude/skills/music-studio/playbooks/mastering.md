# Playbook: mastering (and checking a mix by numbers)

Use for "master this", "is it loud enough", "why is my bounce quiet", "compare it to this song", and before any export that leaves the studio. You can't hear the song, so this playbook leans on `audio_analyze`: it measures an exported WAV the way a mastering meter does.

## The loop

1. **The producer exports** (File > Export Audio/Video, WAV, Main, the whole song). Scripts can't export; say the settings and let them click. Or `live_bounce_track` prints one track.
2. **`audio_analyze`** with the file's full path. Add `reference` (a released song they like, as WAV) when they have one.
3. **Say what the numbers suggest,** one thing at a time, most important first. Then **ask them to listen** before changing anything.
4. **Change one thing** on Main (they turn the knob, or you set it when asked), export again, measure again. Compare with the last measurement, and say what moved.

## Reading the numbers

| Number | What it means | Starting points (not rules) |
|---|---|---|
| **Integrated LUFS** | How loud the whole song is, as streaming services measure it | A mix before mastering: around -20 to -16. A master: -14 (streaming level) to about -9 (loud genres). Louder than -9 costs punch. |
| **True peak** | The highest peak, including between samples | -1 dB or lower. Above that it can clip after MP3 or AAC conversion. |
| **Crest** | How far peaks sit above the average | Under 8 dB: heavily squashed. 10-14 dB: typical for a mastered song. Over 18 dB: very dynamic, or stray peaks. |
| **Loudness range** | How much the loudness moves between sections | 3-6 LU: steady (pop, electronic). 8+: big quiet and loud sections. |
| **Bands** | Each band's share of the energy | Only meaningful against a reference, or against the last bounce. |
| **Correlation** | How much left and right agree | 1: mono. 0.3-0.9: normal stereo. Near 0 or negative: parts vanish in mono. |

- **Main's fader stays at 0 dB.** The export is taken after it, so a fader at -10 dB makes the file 10 dB quieter than the limiter intended (seen in a real session: a limiter ceiling of -1 dB, a true peak of -10.7 dB in the file). Check it with `live_get_device` (`mixer` on Main) before an export. Monitor quieter with the interface's knob, not this fader.
- **A quiet bounce** (say -25 LUFS, peak -10 dB) isn't broken: nothing is pushing it up. The fix is a limiter last on Main with its ceiling at -1 dB, then gain into it until the loudness is where they want it. Check first that a limiter or Utility wasn't switched off or automated down since the last bounce.
- **Against a reference:** a band that's 3 dB or more off is a question to ask ("your highs are 5 dB under the reference; does it sound dull to you next to it?"). Different songs differ for good reasons.

## The chain on Main (a starting order)

EQ (gentle, broad) → glue compression (1-3 dB of gain reduction) → limiter (ceiling -1 dB). Main has a track number (`live_status`: `main`), so `live_load_device`, `live_get_device` and `live_set_device_param` work there. One change at a time.

- **Before the chain:** the mix should peak around -6 dB on Main with no limiter (`live_get_levels`). If it's hotter, bring the tracks down, not Main's fader.
- **Live's own devices:** EQ Eight, Glue Compressor, Limiter. All their knobs can be set by text ("-1 dB").

## Ozone (and other mastering plugins)

If the user has iZotope Ozone (their studio profile lists their plugins), it's a good fit with this loop:

- **Ozone's Master Assistant** listens to the song and proposes a chain. The bridge can't press buttons inside a plugin window: the producer runs it (play the loudest section while it listens). That's fine: it keeps them at the controls.
- **Then measure the result** with `audio_analyze` as a second opinion, and talk through what Ozone did and why. Ozone decides by ear-like analysis; the producer should still understand each module (EQ, Dynamics, Maximizer) rather than accept it blind.
- **Plugin knobs** work by `percent` or `value`, not text, and only the knobs Live lists for the plugin (the device's Configure button adds more). Read them with `live_get_device` first.
- **The Maximizer is the limiter:** its ceiling and threshold are what the true-peak and LUFS numbers respond to.
- Put Ozone **last on Main**, and don't stack Live's Limiter after it unless there's a reason.

## Before it leaves the studio

- Loudness and true peak where they want them, measured on the final file.
- Listen in mono (Utility's Mono on Main, then off again), on headphones, and on a phone.
- The start and end: no cut-off first note, no clipped reverb tail.
- Export WAV for the master; make the MP3 from that.

## Always

- The numbers are measurements; the judgement is the producer's. Say "by the numbers" and ask.
- Never say a master is "done" or "good" from numbers alone.
