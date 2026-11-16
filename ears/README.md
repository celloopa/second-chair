# Second Chair Ears

An **optional** Max for Live audio effect. Drop it on a track and Second Chair can read that track's level and rough tone from the audio itself, with no export. The tool is `live_listen`.

- It needs Max for Live (Live Suite, or Standard with the add-on). Without the device, `live_listen` refuses and every other tool works as before.
- It never changes the sound: audio passes straight through. It never changes the set.
- **Status:** checked in real Live 12.4 on one Windows PC (see "Checked in real Live"). Not tried on a Mac.

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

Ask the user before each step that touches their Live. Use a new empty set. Steps 1 to 4 have been done once; steps 5 to 8 have not.

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

## Checked in real Live (Live 12.4, Windows)

- The built `.amxd` loads from the User Library, `js ears.js` runs, and the bridge receives the OSC reports. So three build guesses held: the `aaaa` type code, plain `js` in a hand-written patch, and `udpsend`'s number types.
- **Peak:** with Operator's sine, Ears last in the chain and the fader at 0 dB, Ears read -13.6 dB and Live's own peak readout showed -13.6. Over 14 levels from -62 to +4 dB, Ears and Live's meter stayed on one straight line.
- **RMS:** 3.0 dB under the peak on a sine, as it should be.

## Still guesses

- **Comparing levels.** Ears measures audio at its position in the device chain, before the track fader. Devices after it and the fader change Live's track meter, so the two only match with Ears last and the fader at 0 dB.
- **Band levels.** `fffb~`'s gain scale isn't documented, so the 8 band numbers are for comparing with each other, not true dB per band.
- **RMS window.** 12000 samples is a quarter second at 48 kHz and a little more at 44.1 kHz.
