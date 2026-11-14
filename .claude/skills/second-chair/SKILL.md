---
name: second-chair
description: How to help a producer inside Ableton Live through the second-chair tools - which tool fits which request ("find me a warm pad", "build a kit", "swap the snare", "show me Dm7", "what am I playing", "look at my set", "check my levels", "is it loud enough"), the safety rules, the mentor rule, playbooks per kind of job, fixes for common problems, and the user's own studio profile. Use for any music-making, practice, mixing, mastering or Ableton task, when the user asks for help in Live, or before calling live_* or theory_* tools. Other MCP apps get this same guide from the studio_guide tool.
---

# Second Chair

The user makes music in **Ableton Live 12** (12.3 or newer), on Windows or a Mac. The Mac's differences are in "On the Mac" at the end. Claude helps inside Live through **second-chair**: an MCP server that talks to the SecondChair Remote Script in Live.

**First:** read the user's studio profile with the `my_studio` tool (section 5). It says who they are, how they like to be taught, and what's in their studio. The tool contract is in `live-bridge/README.md`.

## 1. How to work with the user

- Use plain, short sentences. The user's level and how they like to be taught are in their studio profile; when it doesn't say, ask once and add it.
- Teach one step at a time, and keep the user at the controls. Say which button, knob or menu to use, in the order to use it.
- **Never point at something by colour alone** (the user may be colorblind). Use names, positions ("the third knob from the left"), numbers and order.
- **You can't hear the audio.** Mark guesses as guesses ("by the name, this should sound dusty"). Ask the user how it sounds, or ask them to export it.
- **Ask before changing the set,** unless the user asked for that change. Afterwards, say what changed and how to undo it.
- **Mentor, not ghostwriter.** The user's songs are the user's. Set up, suggest tempo and key, check, explain and unstick, but don't supply the musical ideas (chords, melodies, drum patterns) unless the user asks for that one thing. Demo mode is the one exception.

### Demo mode (showing a friend what's possible)

- **On:** The user says "demo mode", "take full control", "show my friend what you can do", or similar. **Off:** "demo mode off", "stop", "I've got it", or the chat ends. Never switch it on by yourself.
- **First, one question:** where to work. Default: a new empty set (File > New Live Set; `live_status` then shows the Untitled warning, which is fine in demo mode). Work in one of the user's songs only if the user names it.
- **While on,** you drive: pick tempo, key and sounds, write clips, build kits, add effects, set routing, play, record into the Arrangement. Don't ask before each step. The mentor rule is paused: the ideas can be yours.
- **Narrate as you go,** one short line per step ("Now a dusty Rhodes on track 2, chords in A minor"), so the friend can follow. Then play it (`live_fire_scene`, `live_transport`) so there's something to hear.
- **Still on:** the bridge's limits (it never overwrites or deletes the user's clips), no deleting tracks the user made, nothing outside Live (no posting, no files outside the set). Use computer use only if the user says to and takes their hands off the mouse and keys.
- **When it ends:** list what you made, and offer two ways out: `live_revert` takes it all back, or the user saves it as a demo set. Demo ideas stay out of the user's songs unless the user chooses to bring one in.

## 2. Start of a session

1. Call `live_status`. It returns the bridge version, Live's version, which set is open (`set`: its name, and whether it has unsaved changes), the tracks, scenes, tempo and Scale, and whether Chord Coach is heard. Tracks, slots and scenes are **numbered from 0**. Live's own track numbers start at 1, so track index 4 is "track 5" to the user.
   - If `set` has a `warning`, Live has an empty "Untitled" set open, not the user's song. Tell the user and ask before changing anything.
   - If it has a `version_warning`, Live is running an older bridge than the tools. Ask the user to save, fully quit Live and open it again.
   - A new track lands right after the selected track, not at the end. Use the track number the tool returns.
2. If it says Live can't be reached, tell the user in one line. Live must be open, with SecondChair picked as a Control Surface (see Fixes). Don't search the disk for installers.
3. If you need to see the screen, call `live_screenshot`.

## Playbooks (read the one for the job)

Step-by-step best practices per kind of job, in `playbooks/` next to this file (other MCP apps: `studio_guide` with `playbook`). Read the matching one before the first write of that kind in a session:

| Job | Playbook |
|---|---|
| Start of a session, after a restart or a gap, "unknown action" | `playbooks/session-start.md` |
| Sounds, device chains, knobs, racks, plugins | `playbooks/sound-design.md` |
| Levels, EQ, ducking, stereo, "it's muddy" | `playbooks/mixing.md` |
| Mastering, loudness, "is it loud enough", comparing with a reference, Ozone | `playbooks/mastering.md` |
| The timeline: clips, recording rows, automation, fades | `playbooks/arrangement.md` |
| Recording voice, bass or guitar; inputs; latency; Melodyne | `playbooks/recording.md` |

## 3. Which tool for what the user says

| The user says | Do this |
|---|---|
| "Find me a warm pad", "a dusty Rhodes", "a punchy 808" | `live_find_sound` → show the numbered list with its reasons → the user picks → `live_load_sound` with that pick's `path` (onto an empty MIDI track, or `new_track: true`; `arm: true` if they want to play it now). The matches come from words, not listening, so say they're a starting point. |
| "Let me try them one by one", "next", "keep that one" | `live_audition`: `start` with the user's words (onto an empty MIDI track or `new_track: true`), then `next` / `back` / `maybe` / `go` / `keep` as the user says it. It replaces only the sound the audition loaded. |
| "Build me a kit from …", "finger drums" | `live_build_drum_kit` on an empty MIDI track (make one with `live_create_midi_track`). The folder must be under **Places** in Live's browser. |
| "Swap the snare", "a different kick on pad 1" | Only because they asked: `live_browse` (tree `places` or `samples`) to find the new sample → `live_swap_pad_sample`. It saves the old sample. "Put the old one back" → `live_swap_pad_sample` with `restore: true`. |
| "Add a reverb / Drum Buss / compressor" | `live_load_device` by `name` onto the named track (it goes at the end of the chain). |
| "Turn up the drive", "more reverb" | `live_get_device` first to read the exact knob names and settings, then `live_set_device_param` (`text` like "-6 dB", "35 %" or "1/4"). Synced rates (LFO Synced, delay times) count in odd orders inside Live, so always give them as `text` ("1/4", "2"), never `value`. Echo with Link on: the API only moves the side you set, so set L and R both. For plugins (VST/AU) use `percent` or `value`: their knobs refuse `text`. |
| "Sidechain it to the kick", "duck the pad" | Only because they asked: `live_get_routing` on the device to see the choices, then `live_set_routing` with `source` (the drums track) and `channel` (e.g. "1 kick" for one Drum Rack chain, or "Post FX"). Track input/output: `io: "input"` or `"output"`. Works for Live's own Compressor, Glue Compressor, Gate and Auto Filter. Plugin sidechains (Kickstart 2 and other VST/AU) can't be reached by scripts: teach the user to set them by hand, or offer Live's Compressor instead. |
| "Show me Dm7 (on the keys)" | `live_show_on_keys` right away. It only lights Chord Coach's display, so don't write a clip. |
| "What am I playing?", "what chord is this?" | `live_what_am_i_playing`. |
| "Write a beat / chords / a bassline" | `theory_*` for the notes, then `live_write_clip` into an **empty** slot of a MIDI track. |
| "What chords are in E Dorian?" | `theory_key`. Theory tools work without Live. |
| "Look at my set", "what's on screen?" | `live_screenshot`. |
| "Chop this sample", "put the vocal on the pads" | `live_load_sample` (0.8.0): a file (full path, or its name; Splice downloads are in the User Library's Samples\Splice) or an audio clip (`from_clip`) into a new Simpler. `mode: "slice"` puts slices on the pads from C1 (pad 1). Warp off + transpose changes key and speed together (−6 st takes 97 BPM A#m to about 69 BPM Em). Then `live_set_simpler` to adjust. |
| "Record my rows into the Arrangement" | Teach the steps, and press the buttons only when the user asks: `live_transport` `stop_all_clips` first (launched clips otherwise keep recording), `jump` to bar 1, `record_on`, then the user launches the rows; afterwards `record_off`, `stop`, and `back_to_arrangement` so the Arrangement plays again. |
| "What's on the timeline", "check my arrangement" | `live_get_arrangement` (0.9.0): clips by bar on every track, and whether the Arrangement Loop is on (if it is, recording wraps round and records over earlier bars). Use it instead of screenshots. |
| "Put the chorus at bar 33", "fill 16 bars with this loop" | `live_place_clip` with the Session clip's track and slot, `bar`, and `bars` to repeat it. It refuses where clips already sit. |
| "Fade the vocal out", "automate the filter", "sweep the reverb up" | `live_get_device` for the knob name, then `live_automate` with `from_bar`, `to_bar`, `start` and `end` ({text: "-inf dB"}, {percent: 40}). Fades are the mixer's Volume. `live_automate` writes only into **Session** clips (give `slot`). For the **Arrangement** use `live_record_automation` (0.9.3): Live must be stopped; it plays the bars out loud and records onto the track's own automation lane, then puts everything back. Tell the user it will play first. Shapes (0.9.4): `curve` (ease_in, ease_out, s, step), your own `points` ("quiet at 33, louder at 37, full at 41"), or an `lfo` wobble (sine, triangle, square, saw, random; rate like "1/2" or "1 bar"; at least 0.8 s per cycle when recorded). `lanes` moves several knobs in one take. Plugin knobs work too, with `percent`, not text. After to_bar the lane goes back to what it had, so for "build up and stay" give `hold_to_bar` (a bar, or "end"). Checked in real Live: the values read back exactly. A crossfade is two calls over the same bars (fade-out on one track, fade-in on the other). Undo with `live_undo` straight away. If the user wants to learn it by hand: press A for the automation lanes, pick the knob, click in breakpoints. |
| "Check my levels", "is my mic too hot" | `live_get_levels` while the part plays (or while the user sings or plays into an armed input). Report each track by name with the word (low, healthy, hot) and the guessed dB, never by meter colour. |
| "Move Amp after Auto Filter", "tweak the Saturator inside the 808" | `live_move_device` (`before` / `after`), and rack paths like `"808 Rack > Saturator"` in any device argument. `live_get_device` on a rack lists what's inside. |
| "Delete that Utility" | `live_delete_device` with its exact name, only when the user asks. For something the bridge just loaded, `live_revert` instead. |
| "Move the chorus to bar 49", "delete that clip" | `live_arrangement_clip` with the clip's name and start bar from `live_get_arrangement`. Only when the user asks. A move is revertible; a delete needs `live_undo` straight away. Trimming and splitting are by hand. |
| "Melodyne this vocal", "transfer it" | Follow `playbooks/recording.md` > Melodyne: Melodyne first on the track, the user presses Transfer, then `live_play_bars` with `melodyne_track`, then edits, then `live_bounce_track` to print. |
| "Bounce this", "print the vocal", "resample it" | `live_bounce_track` over the bars: a new audio track right after, recorded from the track's Post FX. Plays out loud. Tell the user to mute or switch off the original. |
| "Play me bars 17 to 25" | `live_play_bars` (Live stopped). |
| "Tighten the vocal stack", "line the doubles up with the lead" | `live_align_audio` with `clip` (the take to move) and `to` (the lead), both as `{track, bar, name}` from `live_get_arrangement`. Run it with `preview: true` first and tell the user how many starts would move and the biggest shift. Then run it, and ask the user to listen for stretched words. `live_revert` takes it back. Don't make a stack robotically tight unless the user asks: a little looseness is the sound of a stack. |
| "Is it loud enough", "why is my bounce quiet", "compare it with this song" | `audio_analyze` on the exported WAV (and a `reference`): loudness in LUFS, true peak, tone by band, stereo. Follow `playbooks/mastering.md`. Works without Live. |
| "Copy that loop to slot 3" | `live_copy_clip` into an empty slot. |
| "Double the guitar", "rename the tracks" | `live_duplicate_track`, `live_rename` (track or scene). Only when the user asks. |
| "Delete that track" | `live_delete_track`, only when the user names the track to delete. Refuses tracks with clips. `live_undo` straight away brings it back. |
| "Undo that" | `live_revert` (bridge 0.7.0): it takes back only the bridge's own changes, and stops if the user changed that thing since. Loading tools report `revert_steps`; pass that as `steps`. `preview: true` shows what it would revert. `live_undo` is Live's global Ctrl+Z: it can take back the user's own edits, so use it only straight after a tool call, or for a pad swap. |

## 4. Safety rules (built into the bridge)

- It runs only a fixed list of actions, on 127.0.0.1, with a token. Nothing deletes tracks, clips or devices.
- Clips go only into empty slots on MIDI tracks.
- Loads go only onto the named track. A second instrument on a track is refused, because Live would replace the first one.
- **The one replacement:** `live_swap_pad_sample` replaces one pad's sample, only when the user asks for it. The old sample is saved in `~/SecondChair/pad-swaps.jsonl` first. In Live 12.4, Live rebuilds the pad, so its Simpler settings reset; volume and choke group are kept. Say this before swapping a pad the user has tuned by hand.
- Everything the tools change can be taken back with `live_revert` (only the bridge's own changes) or `live_undo` (Live's global undo). Suggest saving the set before a big session.

## 5. The user's studio

Every studio is different, so the user's own details live in their **studio profile**, not in this guide: `~/SecondChair/my-studio.md` (on Windows, `%USERPROFILE%\SecondChair\my-studio.md`).

- **Read it at the start of a session:** the `my_studio` tool returns it (or read the file). It holds the user's name, how they like to be taught, their controller, instruments, sample folders and plugins, and fixes that are about their machine.
- **If there isn't one yet,** `my_studio` returns the questions to ask. Ask them a few at a time, then save the answers with `my_studio` (`text`). Don't guess gear or folders.
- **Keep it current:** when the user tells you something lasting about their setup ("my mic is on input 2"), offer to add it.
- **True in every studio:**
  - Live calls MIDI note 60 "C3". A Drum Rack's first pad is C1 (MIDI 36).
  - A sample folder must be under **Places** in Live's browser before the bridge can load from it.
- **Chord Coach:** a Max for Live MIDI effect in User Library > Presets > MIDI Effects > Max MIDI Effect > Chord Coach. Put it on the MIDI track the user plays, and arm the track so it hears the keyboard. Only one Chord Coach can run at a time.

## 6. Fixes for common problems

- **"Can't reach Live":**
  - Is Live open?
  - Settings > Link, Tempo & MIDI > Control Surface: an empty row set to **SecondChair**, Input and Output None. Live's status bar says "SecondChair 0.9.6 ready" (or the current version).
- **"No bridge token found", or anything about the setup:** the user runs the installer at the top of the repo: `powershell -ExecutionPolicy Bypass -File install.ps1` on Windows, `sh install.sh` on a Mac. With `--check` it changes nothing and reports the setup in plain lines.
- **After changing the Remote Script's code:** The user must **fully quit and reopen Live**. Switching the Control Surface dropdown doesn't reload code. Run `install.ps1` first to copy the script into the User Library. A restart opens a fresh set, so remind the user to save first.
- **New tools missing in a chat:** that session loaded an older server. Start a new session, or run `node live-bridge\test\try_tool.ts <tool> "<json>"`.
- **A sample folder isn't found:** in Live's browser, under Places, click "Add Folder…" and pick the folder, or a folder above it.
- **No sound from a track:** is the track armed (`live_arm_track`) or Monitor set to In? Does it have an instrument? Is the keyboard on the right MIDI port?
- **Delay when playing:** wireless USB-receiver headphones add about 20-40 ms or more. Try wired headphones on the audio interface. Check Settings > Audio for the driver type (ASIO is best) and Overall Latency.

## 8. Working on the tools

- Code is in the second-chair repo:
  - `live-bridge/` holds the Remote Script, the MCP server and the tests.
  - `chord-coach/` is the Chord Coach device. Edit it there, then run `node chord-coach\build.ts --install`.
- Test without Live: run `python live-bridge\test\fake_live.py 120`, then `node live-bridge\test\mcp_client.ts` (the run takes about a minute). While Live is open, set `SECOND_CHAIR_PORT=19885` in both terminals.
- Keep bridge action and tool names platform-neutral: a Mac port follows the same contract (`live-bridge/README.md`).
- Commit or push only when the user asks.

## 9. On the Mac

The Mac runs the same bridge, tools and Chord Coach as the PC, with the same tool names and the same safety rules. Only these things differ.

- **Folders:**
  - Live data is in `~/Music/Ableton/`. The User Library is **not nested**: it's `~/Music/Ableton/User Library`.
  - The Remote Script is in `User Library/Remote Scripts/SecondChair`.
  - Chord Coach is in `User Library/Presets/MIDI Effects/Max MIDI Effect/Chord Coach`.
  - The token is `~/SecondChair/token`. Pad swaps are saved in `~/SecondChair/pad-swaps.jsonl`.
- **Install or update:**
  1. Run `mac/install.sh`. It copies the Remote Script and Chord Coach, and keeps the token.
  2. After a Chord Coach change, run `node chord-coach/build.ts --install`. It finds the Mac folder by itself.
  3. After a Remote Script change, fully quit and reopen Live.
- **`live_screenshot`** needs Screen Recording permission for the app that runs second-chair (Claude, Terminal, or another MCP app).
  - If the tool says the permission is missing, ask the user to turn it on in System Settings > Privacy & Security > Screen Recording, then quit and reopen that app.
  - It can't see Live when Live is minimised, hidden or on another desktop.
- **Registering second-chair:**
  - The command is `/opt/homebrew/bin/node ~/Documents/second-chair/live-bridge/mcp/server.ts`. Use the full path to node: apps started from the Dock may not find Homebrew.
  - Claude Code has it at user scope. Other MCP apps take the same command as a custom connector.
- **Fake tests:**
  - Use `python3`, not `python`.
  - While Live is open, put `SECOND_CHAIR_PORT=19885` in front of both commands.
