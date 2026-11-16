# Playbook: recording (voice, bass, guitar)

Use for "I want to record a verse", "my mic is too quiet", "set up the guitar", input and monitoring problems.

## Setup (once per track)

1. **Audio track** for the input. Its input: `live_set_routing` with `io: "input"`, source "Ext. In", channel = the interface input (e.g. "2" for a mic on input 2; the user's interface and inputs are in their studio profile). Only when the user asks.
2. **Monitoring:** "Auto" hears the input while armed. If the user hears an echo of themselves, the interface's direct monitor is also on: use one or the other.
3. **Arm** the track (`live_arm_track`). Say which track is armed, by name.
4. A mic into the interface: a **mono TS** (or XLR) lead. A stereo cable into a mono input can lose the signal or half of it.

## Gain staging before the take

1. The user sings or plays the loudest part with the track armed.
2. `live_get_levels` on that track: aim for **"healthy"** (peaks well under the top, between -18 and -3 dB on Live's meter; around -12 dB leaves good room). "Hot" or "near the top": turn the interface's gain knob down, not Live's fader. "Low": up a little.
3. Report by name and word, never by meter colour.

## Takes

- **Session:** an empty slot on an armed track records when fired (`live_fire_clip` on an empty slot; a guess until checked in real Live). Session takes are good for trying ideas.
- **Arrangement:** Arrangement Loop off (or around the section), `jump` to a bar before, `record_on`, play, `record_off`. Count-in in Live's settings helps a singer.
- After a take: `live_get_arrangement` to see where it landed, and name it.

## Latency

- If the user hears a delay: wireless headphones on a USB receiver add 20-40 ms or more (a guess). Try wired headphones on the interface, and check Settings > Audio for the driver type (ASIO) and buffer size (128-256 while recording).

## Pitch editing (Melodyne)

Live 12 has no ARA, so Melodyne works by **Transfer**: it has to hear the part played in real time. One step at a time:

1. **Melodyne first on the vocal track:** `live_load_device` (`name: "Melodyne"`, `tree: "plugins"`), then `live_move_device` to `position: 0`. Melodyne must come before any effects.
2. **The user opens Melodyne's window and presses Transfer.** The bridge can't press buttons inside a plugin window.
3. **`live_play_bars`** with `melodyne_track` and the bars of the part. It checks Melodyne is first and there are clips there, plays exactly those bars once, stops, and puts the play position back. Melodyne should now show the notes; if not, Transfer wasn't on: press it and run again.
4. **The user edits in Melodyne.** Teach one tool at a time: the main tool to drag notes, Correct Pitch for a gentle fix (start around 50 % pitch centre, 0 % drift). Keep the character; don't flatten every note.
5. **Print it:** `live_bounce_track` on the vocal track over the same bars (Post FX: Melodyne's edits are in the take). It lands on a new audio track right after. Then the user switches off the original track (or removes Melodyne) to save CPU.
6. If the vocal is edited later (a new take), Transfer again for just those bars.

## Bouncing in general

`live_bounce_track` prints any track to audio (resampling): to commit a sound, free CPU, or chop a printed part. `channel`: Post FX (default, devices included), Pre FX, or Post Mixer (fader and pan included).
