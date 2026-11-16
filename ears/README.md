# Second Chair Ears (spike)

An **optional** Max for Live audio effect. Drop it on a track and Second Chair can read that track's level and rough tone from the audio itself, with no export. The tool is `live_listen`.

- It needs Max for Live (Live Suite, or Standard with the add-on). Without the device, `live_listen` refuses and every other tool works as before.
- It never changes the sound: audio passes straight through. It never changes the set.
- **Status: a spike.** It has been tried in real Live. Its peak reading still needs a controlled comparison with Live's displayed meter.

## What's here

| File | What |
|---|---|
| `make_amxd.py` | Builds the device without opening Max: `python ears/make_amxd.py "ears/Second Chair Ears.amxd"` |
| `ears.js` | The device's script: turns readings into dB, finds the track, sends the report |
| `Second Chair Ears.amxd` | The built device |

## How it works

1. `plugin~` → `plugout~` passes the audio through.
2. A copy is measured every 250 ms:
   - peak, left and right (`peakamp~ 250`)
   - RMS, left and right (`average~ 12000 rms` → `snapshot~ 250`)
   - RMS in 8 bands of the mono sum (`fffb~ 8 63 2. 1.4`: 63 Hz to 8 kHz, an octave apart)
3. `ears.js` waits for `live.thisdevice`, reads the device's own path (`live_set tracks 2 devices 0`) to learn its track, and sends one OSC message to 127.0.0.1, UDP 9888:
   `/ears/levels <device id> <track|return|main> <index> <peak dB> <rms dB> <band dB> x 8`
4. The Remote Script keeps the last 5 seconds per device. A device that is quiet for 3 seconds counts as gone.
5. `live_listen` returns the latest numbers, their age, the last moment's peak and RMS, and each band's share.

Nothing is sent back to the device. The UDP side has no token, like Chord Coach: it only carries numbers into a table.

## Check it in real Live

Ask the user before each step that touches their Live. Use a new empty set.

1. Copy `Second Chair Ears.amxd` and `ears.js` together into the User Library, for example `Presets\Audio Effects\Max Audio Effect\Second Chair Ears\`.
2. Install this branch's Remote Script and **fully restart Live** (a script change needs it).
3. Put an audio loop on a track and drop Second Chair Ears after it. Check:
   - The device loads with no error. Open the Max window (right-click the title bar) and look for red lines.
   - The sound is the same with the device on and off.
4. Play the loop and call `live_listen`. Check:
   - `track` and `name` are right, and `age_ms` is under about 500.
   - `peak_db` is close to Live's track meter with the fader at 0 dB.
   - Stop playback: within a second it reads `silent`.
5. Tone check: play Operator's sine at 125 Hz, then 1 kHz, then 4 kHz. `most_energy` should follow.
6. Move the device to a return track, to Main, and inside a rack. `track` should follow within about 2 seconds.
7. Put Ears on two tracks. Both should show.
8. Delete the device. After 3 seconds `live_listen` should refuse.

## Known guesses

- **The `.amxd` header.** The `aaaa` type code for an audio effect comes from forum posts and other people's parsers, not from Ableton. Chord Coach proves the same method for `mmmm`.
- **`js ears.js` in a hand-written patch.** Chord Coach uses `jsui`; plain `js` should load the same way, but that is untested.
- **OSC types.** The docs say `udpsend` sends OSC but don't spell out the type tags. The receiver takes ints and floats, as Chord Coach's does.
- **Comparing levels.** Ears measures audio at its position in the device chain, before the track fader. Devices after it and the fader can change Live's track meter reading. Compare Ears last in the chain with the track fader at 0 dB, using the same steady signal and time window. `live_get_levels` converts Live's 0–1 meter value using the volume fader scale as a guess; its `about` value is not a calibrated reference.
- **Band levels.** `fffb~`'s gain scale isn't documented, so the 8 band numbers are for comparing with each other, not true dB per band.
- **RMS window.** 12000 samples is a quarter second at 48 kHz and a little more at 44.1 kHz.
