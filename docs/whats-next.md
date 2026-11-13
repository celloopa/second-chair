# What's next: not proven yet, could be patched, and planned

As of 0.9.8 (2026-11-12). Three lists: what still needs proving in real Live, what could be added with a patch, and what Live would have to change first. Guesses are marked.

## 1. Built, but not proven in real Live yet

These pass the tests against a stand-in for Live. The stand-in has been wrong before, so treat these as "should work". If one misbehaves, tell us what you asked and what happened.

| Thing | What's unproven |
|---|---|
| Lining up takes (`live_align_audio`) | The newest version reads the clip's own warp markers. It always previews first and refuses if the reading looks wrong. Try it on a copy of the track. |
| Bouncing (`live_bounce_track`) | The older bounce worked in real sessions. The newest one (exact edges using Punch In and Out; a group's print landing outside the group) hasn't been run. |
| A bus built from routing | Whether the bus track hears the routed tracks without more setup. |
| Automation shapes | Straight ramps are proven. Curves, LFO wobbles, your own points, several knobs in one take, and plugin knobs are not. |
| Automation in Session clips (`live_automate`) | All of it. |
| Timeline edits | Placing, moving and deleting Arrangement clips; duplicating a track; copying a Session clip. |
| Devices | Moving a device; reaching devices inside racks. |
| Meters (`live_get_levels`) | The dB figure assumes Live's meter uses the same scale as the volume fader (a guess). Meters on return tracks and Main. |
| Melodyne helper (`live_play_bars`) | Playing a range for Transfer. |
| Measuring on a Mac (`audio_analyze`) | Proven on Windows only. |
| The installer | Run for real on one Mac and one Windows PC, both of which already had an older setup. **Not run on a clean machine yet.** |
| Other AI apps | A second way in (MCP over HTTP on this computer, with the token) exists for apps that can't start a local command. No app has been tested against it. |

## 2. Could be patched in

Live's script door allows these, as far as we know. They aren't built. Roughly in order of use for mixing and mastering.

### Small patches

- **Mute and Solo** as things Claude can set, not just see.
- **MP3 and AIFF** for measuring and lining up. Today it's WAV only.
- **A one-go mix check:** one request that walks the set and reports levels per track, what's on Main, tracks with no low cut, and reverbs that could share a return.
- **"Check my setup" and the survey as tools,** so you can ask Claude instead of running the installer with `--check` or `--survey`.
- **A "save a report" tool** for feedback: versions, the last errors, what was asked.
- **Locators:** add and name them, and jump to one (guess: Live's cue points are open to scripts).
- **The loop brace and punch points** as settings of their own.
- **Clip gain, rename and colour** for clips.
- **The metronome and count-in** switches.

### Medium patches

- **Editing notes:** delete, move, quantize and change velocity in an existing MIDI clip, with a saved copy so it can be put back. Left out so far on purpose, because the first rule is "never change your clips".
- **Reference matching for mastering:** from the two measurements, suggest EQ moves by band and a limiter setting, then measure again.
- **Loudness over time:** a list of the loud and quiet sections of a bounce, by bar.
- **Checking a bounce for problems:** clipping spots, DC offset, silence at the start or end, mono compatibility.
- **Deleting automation for a knob** (guess: possible for Session clip envelopes; not for Arrangement lanes).
- **Scenes:** make, duplicate and capture.
- **Sends and return levels by name** ("more reverb on the vocal"), without reading the mixer device first.
- **A profile of your plugins' knobs,** so common plugins can be set in their own units instead of percent.

### Bigger pieces

- **A double-click installer** (no terminal), with Node bundled, and an update check.
- **The real name.** CelloBridge and cello-live are working names. A rename touches the script's folder, the token folder and the entry in Claude.
- **Voice.** A voice front end is planned, so you can talk while your hands are on the instrument. It isn't part of this beta.
- **Chord Coach** as a proper optional add-on (it needs Max for Live).
- **A Windows-and-Mac test run on clean machines** before each release.

## 3. Blocked by Live itself

Live 12 gives scripts no way to do these. They need computer use or your hands (see [needs-your-hands.md](needs-your-hands.md)) until Ableton changes something.

- Exporting audio, and saving the set.
- Drawing on Arrangement automation lanes (the tools record automation instead).
- Plugin sidechain inputs.
- Grouping tracks.
- Fade handles, splitting, trimming and consolidating clips.
- Track delay.
- Anything inside a plugin's own window.
- Macro and MIDI mapping.
- Take lanes and comping.

**Live 13** (a guess, since nothing is announced to us): if it brings ARA, Melodyne would work on clips directly and the play-the-bars helper goes away. We'll check what its script door adds when it ships.

## 4. Known rough edges

- **A chat keeps the tool list it started with.** After an update, start a new chat.
- **A change to the script in Live needs a full Live restart.** Switching the Control Surface row off and on doesn't reload it.
- **New tracks shift the numbers** of every track after them. Claude re-reads the set, but if it ever names the wrong track, ask it to check `live_status` again.
- **Echo's Link switch:** setting the left time doesn't move the right one through the tools. Claude sets both.
- **A recorded automation take can't start at the very first instant of bar 1.** A stray point there is deleted by hand.
- **The first questions** (your studio profile) come once. If Claude skips them, say "set up my studio profile".

## 5. What we'd like to hear from you

- Did it teach you something you now do yourself?
- Did it ever get in the way of your own decisions?
- What did you reach for that wasn't there?
- Did anything change in your set that you didn't ask for?
- Which "not proven yet" things worked, and which didn't?
