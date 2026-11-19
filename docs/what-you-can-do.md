# What you can do (up to 0.11.0)

Everything here works by asking Claude in plain words. You don't need the tool names; they're listed so you can see what's behind each request.

**How sure are we?** Each section ends with one of these:

- **Proven:** used in real Live sessions and it held up.
- **Partly proven:** the main path worked in real Live; the details listed haven't been tried there.
- **Not proven yet:** it passes our tests against a stand-in for Live, but nobody has run it in real Live. It may have rough edges. Tell us what you find.

Numbers Claude uses: tracks, clip slots and scenes count **from 0** inside the tools, and bars count **from 1**. Claude translates, so just say "the vocal track" or "bar 33".

## Contents

1. [See and understand your set](#1-see-and-understand-your-set)
2. [Mixing](#2-mixing)
3. [Mastering: measure a bounce](#3-mastering-measure-a-bounce)
4. [Automation](#4-automation)
5. [Devices and plugins](#5-devices-and-plugins)
6. [Routing, buses and return tracks](#6-routing-buses-and-return-tracks)
7. [The Arrangement timeline](#7-the-arrangement-timeline)
8. [Recording, bouncing and vocals](#8-recording-bouncing-and-vocals)
9. [Finding and loading sounds](#9-finding-and-loading-sounds)
10. [Drums and sample chopping](#10-drums-and-sample-chopping)
11. [Notes, clips and theory](#11-notes-clips-and-theory)
12. [Undo](#12-undo)
13. [Your studio profile and the guide](#13-your-studio-profile-and-the-guide)
14. [Demo mode](#14-demo-mode)
15. [Every tool, in one list](#15-every-tool-in-one-list)

---

## 1. See and understand your set

| Say | What happens |
|---|---|
| "What's in my set?" | Tracks, return tracks, Main, scenes, tempo, key, which set is open and whether it's saved. |
| "What's on the timeline?" | Every Arrangement clip per track, with start and end bars, plus the loop brace. |
| "What's on my vocal track?" | Its devices in order, including devices inside racks. |
| "What is this compressor doing?" | Every knob and switch on the device, as Live shows them, explained. |
| "Look at my set" / "what's on screen?" | A picture of Live's window, so Claude sees what you see. Only Live's windows. |

Tools: `live_status`, `live_get_track`, `live_get_arrangement`, `live_get_device`, `live_get_routing`, `live_get_clip_notes`, `live_screenshot`.

**Proven.** On a Mac the picture needs Screen Recording permission.

## 2. Mixing

| Say | What happens |
|---|---|
| "Play it and check my levels." | Each track's and Main's peak as a word (silent, low, healthy, hot, near the top) and its peak in dB, as Live's meter shows it. |
| "How loud is the bass right now, and where does its energy sit?" | With the optional Second Chair Ears device on that track: its peak and average level in dB, and 8 rough bands from sub to air, measured from the audio. No export needed. It reads before the track's fader. |
| "Turn the bass down 3 dB." / "Pan the guitar a bit left." | Sets the track's Volume, Pan or a Send. Any setting can be given in Live's own units ("-6 dB", "1.2 kHz", "35 %"). |
| "Put an EQ on the vocal with a low cut around 100 Hz." | Loads the device and sets the knobs, and tells you what it set. |
| "Duck the bass when the kick hits." | Loads Live's Compressor on the bass and sets its sidechain to the kick, even one pad inside a Drum Rack. |
| "Make the low end mono." | Utility with Bass Mono, set up. |
| "The three vocal tracks each have their own reverb. Tidy that up." | One reverb on a return track, sends from each track; or a bus track for all three (see section 6). |
| "Walk me through a mix check." | Claude follows the mixing playbook: gain staging first, then EQ, compression, space, with you listening at each step. |

Second Chair Ears is a Max for Live audio effect, so it needs Live Suite or the Max for Live add-on. Install it with the installer's `--ears` option, then drop it on a track from User Library > Presets > Audio Effects > Max Audio Effect. It never changes the sound.

Tools: `live_get_levels`, `live_listen`, `live_set_device_param`, `live_get_device`, `live_load_device`, `live_move_device`, `live_set_routing`, `live_create_return_track`.

**Partly proven.** Knobs, loading devices and Compressor sidechains are proven. The dB figure from the meters is an estimate (the word is the safer read). Meters on return tracks and Main haven't been checked in real Live.

Limits: it can't hear, so it asks you to listen. Mute and Solo are yours to click. A plugin's sidechain input (not Live's own Compressor) is set by hand.

## 3. Mastering: measure a bounce

Claude can't hear, so it measures a file the way a mastering meter does.

| Say | What happens |
|---|---|
| "Measure this file: `<path to a WAV>`" | Integrated loudness (LUFS), true peak, loudness range, the loudest 3 seconds, crest, clipped samples, tone in six bands, and stereo width. |
| "Compare it to this reference: `<path>`" | The same for the reference, side by side, with the differences in plain words. |
| "Is it loud enough for streaming?" | It reads the numbers against the usual targets and says what would change them. |
| "Walk me through mastering this." | The mastering playbook: export, measure, change one thing on Main, listen, measure again. It knows a chain of Live's own devices, and iZotope Ozone if you have it. |

Tool: `audio_analyze`. It runs on your computer and reads the file directly; Live doesn't need to be open.

**Proven** on test signals with known answers and on real bounces. The mastering playbook is new and hasn't been through a full session.

### What key, what tempo

| Say | What happens |
|---|---|
| "What key and tempo is this song? `<path to a WAV>`" | The key, the runner-up and the relative key with their notes; the tempo with its half and double; the tuning; how often the groove and the chords repeat; where the drums land in one bar (or that there are no clear drums); a rough bass note per bar; and the loudness. Each with a confidence and a way to check it by ear. |
| "Analyze it with the stems" (after you split it with Separate Stems) | Each stem's level, so a missing part is obvious ("there are no drums"). The tempo the drums make you feel. The bass line and when it plays. The singer's range: the lowest and highest held notes, where the voice sits most of the time, and the notes with the most time. The key the chords lean to and the key the melody leans to. A rough chord loop. |
| "What key suits this singer?" | A few keys to try, each with where the melody would sit. They are options: you and the singer choose by ear. |

Tool: `song_analyze`. It runs on your computer and reads the file directly; Live doesn't need to be open. A 2-minute song takes a few seconds.

**New.** Checked on a made-up loop and a few real songs. It can't decide a key from its relative (they share every note) or whether the beat feels half or double: you decide by ear.

**Stems:** Live Suite 12.3 or later splits a song. Save the set first. Then say "split this into stems" (Windows): `live_separate_stems` runs Live's Separate Stems on a Session clip, with Live in the background and no screen control. Or right-click the clip and pick **Separate Stems to New Audio Tracks** yourself. High Quality takes about 9 minutes for a 2-minute song. Claude checks on it, then reads the stem files Live wrote, in about 10 to 20 seconds. Live may change the set's tempo to its own guess: Claude tells you and asks before setting it back. Stems aren't perfectly clean, so a stray note may be leakage from another part.

Limits: **WAV files only** for now (16, 24 or 32-bit). **You export**; Live gives tools no export. Claude can tell you the export settings.

## 4. Automation

Live gives scripts no way to draw on an Arrangement automation lane. So the bridge **records** automation the way a hardware knob would: it plays the bars and moves the knob while Live records. You'll hear the bars play during the take.

| Say | What happens |
|---|---|
| "Fade the pad in from bar 9 to bar 17." | A recorded volume ramp, then a read-back that checks the lane really holds the values. |
| "Open the filter slowly over the build, then snap shut on the drop." | A curve (linear, ease in, ease out, S, or a held step), or your own points bar by bar. |
| "Make the pan wobble every half bar through the bridge." | An LFO shape: sine, triangle, square, saw up or down, or random, at a note length. |
| "Automate the reverb send and the filter together." | Up to 8 knobs in one take, on any tracks. |
| "Automate this knob on my plugin." | Any plugin knob that Live shows in the device's list. |
| "What's the volume at bar 33?" | Reads a knob as its automation leaves it, at any bars. |
| "Write a filter sweep into this Session clip." | Written straight into a Session clip's envelope, exactly, with no playback. |

Tools: `live_record_automation`, `live_read_knob`, `live_automate` (Session clips).

**Partly proven.** Recorded ramps on the timeline are proven and read back exactly. Curves, LFO shapes, several knobs at once, plugin knobs and Session-clip envelopes aren't proven in real Live yet.

Limits:
- A take replaces automation already in those bars, and it's at most about 4.5 minutes long.
- A recorded wobble can't be faster than about one cycle per 0.8 seconds. For faster ones, use Live's LFO device.
- It can't reach the very first instant of bar 1.
- It can't delete or nudge single automation points. That's by hand.
- Undo a take with Ctrl+Z (Cmd+Z) straight away.

## 5. Devices and plugins

| Say | What happens |
|---|---|
| "Add a Drum Buss to the drums." | Loads any Live instrument, audio effect or MIDI effect onto a track, a return track or Main. |
| "Load Ozone on Main." | Loads a plugin from Live's Plug-ins list. |
| "Move the EQ before the compressor." | Reorders devices on a track or inside a rack chain. |
| "Set the Echo to a quarter note." | Any knob, by its text ("1/4", "-6 dB", "Hard"), by percent, or by raw value. |
| "Open up the rack and change the saturator inside." | Reaches devices inside racks. |
| "Delete that second reverb." | Only on your clear request, with a name check. |

Tools: `live_load_device`, `live_browse`, `live_get_device`, `live_set_device_param`, `live_move_device`, `live_delete_device`.

**Proven** for loading, reading, setting and deleting. Moving devices and reaching into racks are **not proven yet**.

Limits for plugins (VST and AU):
- Claude sees only the knobs Live shows in the plugin's device box. To show more, click **Configure** on the device and touch the knobs in the plugin's window.
- Plugin knobs are set by percent, not in the plugin's own units.
- Nothing inside the plugin's own window can be clicked by the tools (presets, Ozone's assistant, Melodyne's notes).

## 6. Routing, buses and return tracks

| Say | What happens |
|---|---|
| "Where is this track's audio going?" | Its input and output, and every choice Live offers. |
| "Make a return track with a plate reverb." | A new return track with the effect loaded. Every track gets a send to it. |
| "Make a vocal bus." | A new audio track; each vocal's output routed to it; its monitor set to In; shared effects go on it once. |
| "Send the snare pad to its own track." | Routing from one Drum Rack chain. |

Tools: `live_get_routing`, `live_set_routing`, `live_create_audio_track`, `live_create_return_track`, `live_set_monitoring`.

**Partly proven.** Making audio and return tracks and setting monitoring are proven. A bus built from routing is **not proven yet**.

Limit: it can't **group** tracks (Live's Ctrl+G / Cmd+G). A bus track built from routing does the same job for the sound.

## 7. The Arrangement timeline

| Say | What happens |
|---|---|
| "Put this Session clip on the timeline at bar 17 for 8 bars." | Copies it there, repeated to fill the bars. It refuses anywhere a clip already sits. |
| "Move that clip to bar 33." / "Delete the clip at bar 41." | On your request; the clip is checked by name and bar. |
| "Duplicate the bass track." | Like Ctrl+D on the track. |
| "Rename the tracks so I can tell them apart." | Renames tracks and scenes. |
| "Play bars 17 to 25." | Plays that range once, then puts the loop and play position back. |
| "Stop everything and go back to the arrangement." | Transport, Stop All Clips, Back to Arrangement, Arrangement Record. |

Tools: `live_get_arrangement`, `live_place_clip`, `live_arrangement_clip`, `live_duplicate_track`, `live_rename`, `live_play_bars`, `live_transport`.

**Partly proven.** Reading the timeline and the transport are proven. Placing, moving and deleting timeline clips and duplicating tracks are **not proven yet**.

Limits: no splitting, trimming, consolidating or fade handles. Those are by hand.

## 8. Recording, bouncing and vocals

| Say | What happens |
|---|---|
| "Set me up to record a vocal on input 2." | A new audio track, input set, armed, monitoring set. The recording playbook covers latency and levels. |
| "Bounce the vocal track from bar 17 to 33." | Prints the track's sound, effects included, onto a new audio track with exact edges. |
| "Line up my double with the lead." | Finds where notes start in each take and adds warp markers so close starts land together. It shows a preview first and changes nothing until you agree. |
| "Help me with Melodyne on this take." | Plays the exact bars so Melodyne can hear them for its Transfer. You press Transfer; Claude can't click inside the plugin. Then it can bounce the result. |
| "Transpose this audio clip down two semitones." | Transpose, warp on or off, and warp mode for an audio clip. |

Tools: `live_create_audio_track`, `live_arm_track`, `live_set_monitoring`, `live_bounce_track`, `live_align_audio`, `live_audio_clip_info`, `live_play_bars`, `live_set_audio_clip`.

**Partly proven.** Recording setup and bouncing a single track have worked in real sessions. **Not proven yet:** the newest bounce (exact edges by punch-in, and bouncing a group), lining up takes, and the Melodyne helper. Try lining up on a copy of the track first.

Limits: lining up reads WAV files only, and soft, slurred note starts are skipped rather than moved.

## 9. Finding and loading sounds

| Say | What happens |
|---|---|
| "Find me a warm pad." / "A dusty Rhodes." | A short numbered list from Live's own library, with the reason for each pick. You choose. |
| "Load number 2." | Loads it onto a new or empty MIDI track, armed so you can play it. |
| "Let me try them one by one." | An audition: next, back, maybe, keep. It only ever swaps the sound it loaded. |
| "What's in my sample folder?" | Browses Live's browser, including folders you added under Places. |

Tools: `live_find_sound`, `live_load_sound`, `live_audition`, `live_browse`.

**Proven.** It matches words (names and Live's tags), not sound, so the list is a starting point for your ears.

## 10. Drums and sample chopping

| Say | What happens |
|---|---|
| "Build a kit from this folder." | A Drum Rack with up to 16 samples on the pads, hats choked together. |
| "Swap the snare for this one." | Replaces one pad's sample and keeps its volume and choke group. The old one can be restored. |
| "Chop this sample across the pads." | Loads an audio file into Simpler, sliced, ready to play. |
| "Slice by beat instead." | Simpler's mode, slicing, warp and transpose. |

Tools: `live_build_drum_kit`, `live_swap_pad_sample`, `live_load_sample`, `live_get_simpler`, `live_set_simpler`.

**Proven.** Sample folders must also be under Places in Live's browser.

## 11. Notes, clips and theory

These write MIDI only, into empty slots, when you ask for it.

| Say | What happens |
|---|---|
| "What chords are in D minor?" | The key's notes, chords and common progressions. Works without Live. |
| "What chord is this?" (some notes) | Names it and reads it against the key. |
| "Write a simple bassline under these chords so I can edit it." | A MIDI clip in an empty slot. Every note is yours to change. |
| "Set the tempo to 92 and the scale to A minor." | Live's tempo and Scale. |
| "Play scene 2." | Launches clips and scenes. |

Tools: `theory_key`, `theory_name_chord`, `theory_voice_chord`, `live_write_clip`, `live_add_notes`, `live_copy_clip`, `live_get_clip_notes`, `live_create_midi_track`, `live_set_tempo`, `live_set_scale`, `live_fire_clip`, `live_fire_scene`, `live_stop_track`, `live_select_track`.

**Proven**, except `live_copy_clip` (**not proven yet**).

Limits: it adds notes; it doesn't delete or rewrite notes already in a clip. With the optional Chord Coach device there are two more tools, `live_show_on_keys` and `live_what_am_i_playing`.

## 12. Undo

### Saving without taking over your screen

- "Save my set": `live_save` saves a set that already has a file, with Live in the background. It checks the save really happened: the `*` leaves the title, the file changes, and Live shows no message box.
- A set that was made by an older Live, or a copy of a template, opens Save As the first time. The tool says so and asks you to press Ctrl+S once.
- `live_menu` runs one of Live's menu commands by name, such as View > Browser, only when you ask. It never runs New, Open, Close Window or Quit.
- Windows and Mac. On a Mac, the app that runs Second Chair needs Accessibility permission (System Settings > Privacy & Security > Accessibility). Saving this way on a Mac hasn't been checked yet.

### More without the screen (Live script 0.11.0)

- "Is Live waiting on something?": `live_status` says when Live shows a message box, and what it says. You answer it in Live.
- "Select the kick clip": `live_select_clip` selects a Session clip, so a menu command like Separate Stems has something to work on.
- "Split this song into stems": `live_separate_stems` runs Live's Stem Separation (Live Suite 12.3 or later, Windows, a saved set). It ticks the stems and the quality in Live's own window and presses Separate, then checks on the files until Live's new group track is there. Only when you ask. `live_revert` can't take it back: delete the group track in Live. Not yet on the Mac: there it tells you the clicks.
- "Put this WAV on track 3": `live_import_audio` puts a file from disk into an empty slot or at a bar on the Arrangement. A saved set keeps a copy in its project. It never covers clips.
- "Get the notes out of this": `live_convert_to_midi` turns an audio clip into MIDI on a new track (harmony, melody or drums), like Live's Convert commands.
- "Tighten this loop": `live_quantize_audio` moves an audio clip's note starts toward a grid, by an amount you choose.

### File boxes without the screen (0.14.0)

- "Save this new set as My Song in my Projects folder": `live_save` with a path does Save As for a set that has no file yet. It opens Live's Save As box by name and fills in the full path. Live may put the set in a new "My Song Project" folder.
- "Save a copy here", "export it to this file": open the box with `live_menu` (File > Save a Copy, or File > Export Audio/Video and then its Export button), then `live_file_dialog` puts in the full path you gave and presses Save.
- It never replaces a file unless you said to. If the file is there already, it stops and asks you.
- "Import this file": after Create > Import Audio/MIDI File, `live_file_dialog` fills the Open box too. (`live_import_audio` is usually simpler.)
- It works even when Live sits on another desktop or workspace. It only fills Windows' own file boxes, never Live's own windows, so Live's Export settings and its Export button stay yours (or computer use).
- Windows only for now. On the Mac it tells you what to type.

### Offline mode, for when there's no internet (0.16.0, a first version)

- Start the tools with `SECOND_CHAIR_TOOLS=offline` (for example in LM Studio's MCP settings) and a local model can help with no internet. It can do theory, look at your set, check levels, play and stop, and find sounds.
- It can't change your set: anything that would (write, load, delete, tempo, mixing, recording) is saved for later with `hand_to_stronger_model`, and it tells you so.
- It sees 26 tools with short descriptions (about 3,600 tokens instead of about 21,000), because small models choose worse from long lists.
- It's new and not measured yet on many models: see `live-bridge/test/local_bench.ts`.

### Export without the screen (0.15.0)

- "What will the export be?": `live_export` opens Live's Export window, reads it (track, start and length, file type, sample rate, bit depth, Normalize and the other options) and closes it again.
- "Export it to my Bounces folder as Song.wav": `live_export` with the path opens the window, presses Export and fills Windows' save box, then waits for the file. It takes a few seconds for a short export; longer songs take longer.
- It never changes anything in Live's Export window. Set the length and options there yourself (or ask it to leave the window open while you do), then say "export".
- It stops if the file type doesn't match the path, if the length is 0, or if the file is already there (unless you said to replace it).
- Afterwards it offers `audio_analyze` on the file. Windows only for now.
- Each of these is taken back with "take that back" (`live_revert`). They need the Live script 0.11.0: after an update, quit and reopen Live once.

| Say | What happens |
|---|---|
| "Take that back." | Reverts the bridge's own last changes, newest first. Your own edits in between are left alone. |
| "Undo." | Live's own undo (Ctrl+Z / Cmd+Z). It's global, so it can also undo something you did. |

Tools: `live_revert`, `live_undo`.

To delete a Session clip, name it: "Delete the clip called Scratch idea on the pad track." Claude checks the name first (`live_delete_clip`).

**Proven.** Three things can't be reverted by `live_revert` and need Live's undo straight away: a recorded automation take, a deleted device, and a deleted clip (Session or timeline). Claude tells you when that's the case.

## 13. Your studio profile and the guide

- **Your profile** is one text file, `SecondChair/my-studio.md` in your home folder: your name, how you like to be taught, gear, folders, plugins, and fixes for your machine. Say "update my studio profile: I got a new interface" and Claude rewrites it and keeps the previous version.
- **The guide** teaches Claude how to help: which tool fits which request, the safety rules, and six playbooks (starting a session, sound design, mixing, mastering, arrangement, recording).

- **Your plugin guide** is a second text file, `SecondChair/my-plugins.md`: one line per plugin you own, saying what it is and what it's good for. Ask "which of my plugins should I use for a wide chorus?" and Claude reads the guide first, so it recommends what you have. Lines Claude wrote and you haven't checked say "(unconfirmed)". Say "update my plugin guide" after you install something new.

Tools: `my_studio`, `my_plugins`, `studio_guide`.

## 14. Demo mode

Say **"demo mode"** to show a friend what's possible. Claude asks where to work (a new empty set by default), then drives: picks tempo, key and sounds, writes clips, builds a kit, adds effects, and narrates each step. It still never deletes your work. Say "demo mode off" to stop. At the end it lists what it made and offers to take it all back.

## 15. Every tool, in one list

76 tools. "Reads" change nothing.

| Group | Tools |
|---|---|
| Reads | `live_status`, `live_get_track`, `live_get_arrangement`, `live_get_clip_notes`, `live_get_device`, `live_get_routing`, `live_get_levels`, `live_listen`, `live_read_knob`, `live_get_simpler`, `live_audio_clip_info`, `live_browse`, `live_find_sound`, `live_screenshot` |
| Tracks | `live_create_midi_track`, `live_create_audio_track`, `live_create_return_track`, `live_duplicate_track`, `live_rename`, `live_delete_track`, `live_arm_track`, `live_select_track`, `live_set_monitoring`, `live_mute_track` |
| Devices | `live_load_device`, `live_set_device_param`, `live_move_device`, `live_delete_device`, `live_set_routing` |
| Automation | `live_record_automation`, `live_automate` |
| Timeline and transport | `live_place_clip`, `live_arrangement_clip`, `live_play_bars`, `live_transport`, `live_fire_clip`, `live_fire_scene`, `live_create_scene`, `live_stop_track`, `live_set_tempo`, `live_set_scale` |
| Audio | `live_bounce_track`, `live_align_audio`, `live_set_audio_clip`, `live_import_audio`, `live_convert_to_midi`, `live_quantize_audio`, `audio_analyze`, `song_analyze` |
| Sounds and samples | `live_load_sound`, `live_audition`, `live_build_drum_kit`, `live_swap_pad_sample`, `live_load_sample`, `live_set_simpler` |
| MIDI | `live_write_clip`, `live_delete_clip`, `live_add_notes`, `live_copy_clip` |
| Theory | `theory_key`, `theory_name_chord`, `theory_voice_chord` |
| Saving and Live's menus | `live_save`, `live_menu`, `live_export`, `live_file_dialog`, `live_select_clip`, `live_separate_stems` |
| Checking the bridge | `live_probe` |
| Undo | `live_revert`, `live_undo` |
| You and the guide | `my_studio`, `my_plugins`, `studio_guide` |
| Chord Coach (optional device) | `live_show_on_keys`, `live_what_am_i_playing` |

How each one works inside is in [live-bridge/README.md](../live-bridge/README.md).
