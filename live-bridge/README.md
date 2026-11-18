# live-bridge

This lets Claude (and HeyClicky, or any MCP client) work inside Ableton Live 12, on Windows or a Mac.

| Piece | Where | What it does |
|---|---|---|
| SecondChair Remote Script | `remote_script/SecondChair/`, installed to `Music\Ableton\User Library\User Library\Remote Scripts\SecondChair` | Runs inside Live. Listens on 127.0.0.1:9885 only and needs the token in `%APPDATA%\SecondChair\token`. Runs a fixed list of actions and never code a client sends. |
| second-chair MCP server | `mcp/server.ts` (Node 24, no dependencies) | Turns the bridge into tools, plus music-theory tools built on Spur's `theory.ts` and `voicing.ts`. |
| Spur code | `vendor/spur/` | `theory.ts`, `voicing.ts` and `recent-playing.ts`, sent by the Spur lead with the author's OK. `STRIP-NOTES.md` covers the HUD ideas for step 2. |
| Tests | `test/` | `fake_live.py` runs the real Remote Script against a stand-in for Live's API. `mcp_client.ts` drives the MCP server end to end. |

## Set up (once)

Run the installer at the top of the repo. The top-level `README.md` has the full steps for a new user.

1. Windows: `powershell -ExecutionPolicy Bypass -File install.ps1`. Mac: `sh install.sh`. Both run `install.mjs` (Node 24, no dependencies). Rerunning is safe. `--check` reports the setup and changes nothing; `--dry-run` says what it would do; `--uninstall` takes it out.
   - It reads Live's User Library from Live's own `Library.cfg` (the newest Live version's `ProjectPath` + `ProjectName`; the file is in `Live x.y.z/Preferences` on Windows and directly in `Live x.y.z` on the Mac), or takes `--user-library "<folder>"`. It copies `remote_script/SecondChair` into `Remote Scripts/SecondChair`.
   - It makes or keeps the token: `~/SecondChair/token`, and on Windows also `%APPDATA%\SecondChair\token` and a copy next to the script.
   - It adds `second-chair` to Claude Code (`~/.claude.json`) and to the Claude desktop app (`claude_desktop_config.json`, classic and Store installs), with a backup of each file.
   - It copies the skill to `~/.claude/skills/second-chair` and writes `dist/second-chair-skill.zip` (the zip is written by the installer itself, with `/` paths).
   - `--chord-coach` also installs the Chord Coach device. It's off by default: the beta ships without it.
   - `live-bridge/install.ps1` now just calls the top-level installer. `mac/install.sh` is the Mac lead's older script (Remote Script, token and Chord Coach only) and still works.
2. Restart Live.
3. Go to Settings > Link, Tempo & MIDI > Control Surface. In an empty row, pick **SecondChair** and leave Input/Output on None. Live's status bar says "SecondChair 0.11.0 ready".
4. Restart Claude, or start a new session, to load the tools.
5. Testing the installer: `SECOND_CHAIR_INSTALL_HOME=<an empty folder>` points everything at a pretend home folder.

To add it to HeyClicky, go to Settings > Integrations > Custom connectors and add a command:
`"C:\Program Files\nodejs\node.exe" "<repo>\live-bridge\mcp\server.ts"`

## Tools

- **Live, read:**
  - `live_status`
  - `live_get_track`
  - `live_get_clip_notes`
- **Live, write** (all undoable with `live_undo`; Live can group changes made within a couple of seconds into one undo step, so one undo may take back several):
  - `live_write_clip`: only into an empty slot of a MIDI track.
  - `live_add_notes`
  - `live_create_midi_track`
  - `live_set_tempo`
  - `live_set_scale`
  - `live_transport`
  - `live_fire_clip`
  - `live_stop_track`
  - `live_fire_scene`
  - `live_arm_track`
  - `live_select_track`
  - `live_undo` takes `steps` (1-40) to take back a multi-step load in one call.
- **Device settings** (undoable with `live_undo`):
  - `live_get_device` reads every knob and switch on one device, with each setting as Live shows it. Use `device: "mixer"` for the track's Volume, Pan and Sends.
  - `live_set_device_param` turns one knob or flips one switch. The setting can be given three ways:
    - as `text` in Live's units ("-6 dB", "35 %", "1.2 kHz", "500 ms", or a choice like "Hard");
    - as a `percent` of the knob's travel;
    - as Live's raw `value`.
    - Plugins (VST/AU) only show their current setting, so `text` is refused for their knobs (bridge 0.6.0). Use `percent` or `value`.
- **Routing** (bridge 0.6.0; undoable with `live_undo`; change it only when the user asks):
  - `live_get_routing` is read-only. With no device it shows the track's input and output and every choice. With a device it shows its sidechain input.
  - `live_set_routing` sets a device's sidechain (`source` = the track, `channel` = the tap point or one Drum Rack chain, like "1 kick"), or a track's `io: "input"` / `"output"`.
- **Live's browser** (loads devices and samples; undoable with `live_undo`):
  - `live_browse` is read-only. It lists one folder (`path`) or searches names (`query`) inside one tree: `instruments`, `drums`, `audio_effects`, `midi_effects`, `sounds`, `samples`, `plugins`, `max_for_live`, `user_library` or `places` (the folders added under Places).
  - `live_load_device` loads an instrument, audio effect or MIDI effect, by `name` ("Drum Buss") or `path`, onto the end of the named track's chain.
  - `live_build_drum_kit` puts a Drum Rack on an empty MIDI track. It loads up to 16 samples from one folder onto pads C1 upward (MIDI 36+), in file-name order. Options:
    - `volumes_db` sets each pad's volume.
    - `choke_hats` is on by default: samples with "hat" in the name go in choke group 1.
    - `name` renames the track.
- **Sounds by description** (bridge 0.4.0):
  - `live_find_sound` is read-only. Give it the user's words ("a warm pad", "a dusty Rhodes", "a punchy 808 bass"). It returns a short numbered list, each with plain reasons: its name, its folder in Live's Sounds, and Live's own tags.
  - `live_load_sound` loads the pick onto a MIDI track that has no instrument, or onto a new MIDI track (`new_track: true`, named after the sound). `arm: true` arms it to play.
  - It matches words, not audio, so the list is a starting point. Show it to the user and let them choose.
  - `live_audition` (0.6.0) steps through a shortlist on one track: `start` loads pick 1, then `next`, `back`, `maybe` (note it and move on), `go` (a number) and `keep`. It replaces only the sound the audition loaded.
- **Swapping one pad's sample** (bridge 0.5.0, only when the user asks for that swap):
  - `live_swap_pad_sample` replaces the sample on one Drum Rack pad, on the track named. Name the pad by number (1-16), by note ("C#1"), or by a word from its sample's name ("snare").
  - It keeps the pad's volume and choke group. It refuses empty and layered pads, and undoes itself if any other pad changed.
  - Every swap is saved first, in `~/SecondChair/pad-swaps.jsonl`, so `restore: true` puts the old sample back, even after `live_undo` can't. `live_undo` also works.
- **Chord Coach** (needs the device on a MIDI track, and the track armed so it hears the keyboard):
  - `live_show_on_keys`: lights a chord on the device's keys. Takes a symbol (`Dm7`, `A13`, `G/B`, `F sharp minor`), tones, or MIDI notes. Chords are voiced for the keyboard's 25 keys (48-72) with Spur's `voicing.ts`. `clear: true` goes back to the device's own chord.
  - `live_what_am_i_playing`: the held notes, the chord's name read against the key (Live's Scale, or `root`/`scale`), the chord trail and a recent-notes timeline from Spur's `recent-playing.ts`.
- **Seeing Live:**
  - `live_screenshot`: a picture of Live's window, returned as an image, so Claude can see what the user sees. `windows: "all"` adds open plugin and device windows.
  - It captures only Live's own windows, never the rest of the screen. It works when other windows cover Live, but not when Live is minimised (or, on the Mac, hidden or on another desktop).
  - It runs in the MCP server, because Live's Python can't take screenshots: `mcp/screenshot.ts` with `screenshot.ps1` on Windows, and with `screenshot-mac.js` plus `screencapture -l <window id>` on the Mac.
  - On the Mac it needs Screen Recording permission for the app that runs second-chair (Claude, HeyClicky or Terminal), in System Settings > Privacy & Security > Screen Recording. Without it, the tool says so.
- **Live's menu bar, without the screen** (Live's Python has no save, export or stems calls):
  - `live_menu`: fires one menu command by name, such as `View > Browser`. On Windows it posts the command to Live's window (`mcp/menu.ts` with `menu.ps1`), so Live can stay in the background and the mouse, keys and clipboard aren't touched. It works only on an allow-list: commands that open a dialog, change only the view, or save. New, Open, Close Window and Quit are always refused. An unknown name is refused with the close matches.
  - Live 12.4 on Windows never marks its menu items greyed out or ticked, so a command that needs a selection is sent anyway. After a dialog command, the tool reports which window opened.
  - `live_save`: saves a set that already has a file, then checks that the `*` left the title, the `.als` changed and no message box appeared in Live's `Log.txt`. If Live answers with Save As (a copy of a template opened from disk), it says so. If anything fails, it asks the user to press Ctrl+S; computer use stays the fallback.
  - On the Mac, `menu-mac.js` clicks the menu through System Events (needs Accessibility). It is written but not yet tested.
- **Less screen, part 2** (bridge 0.11.0, server 0.12.0; an older bridge gets an "update the Live script and restart Live" answer):
  - `live_status` has `dialog: {open, text, buttons, source}` from Live's own message-box properties, plus `dialog.log`: the `Message Box:` lines in Live's `Log.txt` since Live last started (`mcp/dialogs.ts`). The log never says when a box closes. If the bridge doesn't answer, `live_status` names the newest logged box (a crash-recovery question, for example). Nothing presses a dialog button.
  - `live_select_clip {track, slot}`: sets `song.view.highlighted_clip_slot` and `detail_clip`, and shows Session and Clip View (`show: false` skips that), so a `live_menu` command that acts on the selection has a target. It reports what Live says is selected.
  - `live_import_audio {file, track, slot}` or `{file, track, bar}`: `ClipSlot.create_audio_clip` (an empty Session slot) or `Track.create_audio_clip` (the Arrangement). The server first copies the file into the set's `Samples\Imported` (never overwriting: a different file with the same name gets ` (2)`); an unsaved set has no project, so the file is used where it is. On the Arrangement it refuses to cover clips (a WAV's length is read from its header; other formats need the rest of the track empty), and if Live still changed a clip there, it undoes once and says so. Long files can block Live for a while (120 s limit). Revertible.
  - `live_convert_to_midi {track, slot | bar+name, kind}`: `Live.Conversions.audio_to_midi_clip` with `AudioToMidiType.harmony_to_midi`, `melody_to_midi` or `drums_to_midi`, after `is_convertible_to_midi`. The call's arguments are picked from the function's own signature line (Boost.Python's `__doc__`), with known forms as a fallback. Live makes a new MIDI track; `live_revert` deletes it while its devices, clips and notes are unchanged.
  - `live_quantize_audio {track, slot | bar+name, grid, amount}`: `Clip.quantize(grid, amount / 100)` on a warped audio clip. The grid is Live's recording-quantize value (1/4 to 1/32, triplets too). The warp markers are kept first, so `live_revert` puts them back.
  - `live_probe`: read-only. Signatures (`__doc__`) of the calls above and the dialog calls, the set's name and path, the dialog values, whether `ctypes`, `subprocess` and `_winapi` import inside Live, and Python's version. It looks up `press_current_dialog_button` but never calls it.
- **Studio guide** (works without Live):
  - `studio_guide` returns the second-chair skill (`.claude/skills/second-chair/SKILL.md` at the repo root): how to work with the user, which tool fits which request, the safety rules, the studio facts and fixes. `section` narrows it.
  - Claude Code sessions in this repo load the same file as a skill. HeyClicky can't load skills, so it reads the guide through this tool. Edit the skill file; there's no second copy.
- **Theory** (works without Live):
  - `theory_key`: notes, chords, progressions and the in-scale keys.
  - `theory_name_chord`: also reads 9ths, 13ths, 7♭9, 6ths and add9 with the bass as the root.
  - `theory_voice_chord`

Nothing deletes tracks, clips or devices, except `live_revert` taking back something the bridge itself made (and only if nobody changed it since). Two tools replace a sound, both only when the user asks: `live_swap_pad_sample` (one pad, saved first so it can be put back) and `live_audition` (only the sound the audition itself loaded). Save the set before a big session anyway.

## Browser loading (bridge 0.3.0)

This is shared with the Mac port. The action names, parameters and results are the contract, and nothing here is Windows-only. A path is browser names joined with `/`, never a disk path. The MCP server turns a disk path into its last three folder names.

- **`browse`** `{tree, query?, path?, limit? (1-200, default 40)}` → `{tree, path, items: [{name, path, loadable, folder, device}], more}`.
  - A search also returns `searched` and `complete`.
  - It stops after 30,000 items and hands the tick back to Live every 400.
- **`load_device`** `{track, name? | path?, tree?}` → `{track, loaded, from, added, position, devices, undo_steps}`.
  - Without `tree`, it looks in `audio_effects`, then `midi_effects`, then `instruments`.
  - Names match without case or file extension.
- **`build_drum_kit`** `{track, folder, volumes_db?, choke_hats? = true, name?}` → `{track, track_name, folder, found_in, pads: [{pad, note, note_name, sample, volume?, choke_group?}], undo_steps, skipped?, notes?}`.
  - It looks for `folder` in `places`, then in `user_library`, matching the longest tail of the path.
  - If the folder isn't there, the error tells the user how to add it under Places.
- **`undo`** now takes `steps` (1-40).
- **`get_device_params`** `{track, device}` → `{track, device, params: [{index, name, value, min, max, shown_as, choices?, locked?}]}`.
  - `device` is a name, an index from 0, or `"mixer"`. The mixer's params are named Volume, Pan and Send A, B and so on.
  - Names match exactly (any case) first, then by the only name that contains the words.
- **`set_device_param`** `{track, device, param, text? | percent? | value?}` (exactly one) → `{track, device, param, was, now, value, undo_steps}`.
  - `text` matches a switch's choice. For a knob, it searches the knob's range for that number on its display.
  - kHz counts as 1000 Hz and s as 1000 ms, so units can be mixed.
  - A knob whose display has no number (Pan shows "C", "20R") needs `percent` or `value`.
  - It refuses a locked knob, one controlled by a macro or automation.
- **How loading works:**
  - Live's browser loads onto the selected track, so each load first selects the named track.
  - It clears `browser.hotswap_target` and sets the track's `device_insert_mode` to default, which means the end of the chain.
  - A sample goes on a pad by making that `DrumPad` the hotswap target, the way Push does it.
  - In Live 12.3+, the Drum Rack itself goes in with `track.insert_device("Drum Rack")`. Older versions load it from the browser.
  - A load can finish on a later tick, so these three actions are jobs. `update_display` steps them once per tick, one job at a time. The client waits up to 18 s, or 45 s for a kit.
- **Safety:**
  - It loads only onto the track the call names.
  - It refuses an instrument on an audio track. It also refuses a second instrument on a MIDI track, because Live would replace the first.
  - It refuses a kit on a track that already has an instrument.
  - After any load, it checks that every device that was on the track is still there. If Live replaced one, it undoes the load and says so.
- **Undo:** each load, volume, choke group and rename can be its own undo step. Results report `undo_steps`, but Live may group quick changes together. After undoing, check with `live_status`.
- **Possible later:** Live 12.4's `SimplerDevice.replace_sample(path)`, with `RackDevice.insert_chain` and `DrumChain.in_note`, could load samples straight from disk, with no Places step. It would take disk paths, though, so the Mac port would need to agree first.

## Sounds by description (bridge 0.4.0)

Shared with the Mac port, like the browser section above. The bridge only lists names. The MCP server does the matching, so matching can improve without restarting Live.

- **`list_tree`** `{tree, path?, limit? (1-5000, default 3000)}` → `{tree, path, items: ["Pad/Warm Analog Pad.adg", ...], more, searched, complete}`.
  - Every loadable item under one tree, or one folder of it, as browser paths. It is read-only.
  - It walks the tree like a `browse` search, so it has the same 30,000-item cap and hands the tick back to Live every 400 items.
- **`load_device`** takes a new option, `only_if_no_instrument: true`. It refuses an audio track, and any track that already has an instrument, whatever the item turns out to be. `live_load_sound` always sets it.
- **Exact names win:** a path now matches an item's exact name first, and only then the name without its extension. So `Pad/Noisy Pad.adv` never loads its neighbour `Noisy Pad.adg`. Live's Sounds has several such pairs.
- **How `live_find_sound` ranks** (`mcp/sounds.ts`):
  - It reads the description as words. Some words name a kind of sound (pad, Rhodes, 808, bass, keys, pluck, strings, choir, bells). Some say how it sounds (warm, dusty, punchy, dark, bright, evolving). Two-word phrases come first, like "electric piano" and "lo fi". Other words are only looked for in names.
  - Each word maps to Live's folders, Live's tags and name words. For example, "dusty" maps to the tag Lofi & Vinyl and to names with dust, vinyl, old, rusty or tape. "Warm" maps to the tags Analog and Soft, because Live has no Warm tag.
  - For each word, an item scores for its name (3 for the user's own word, 2 for a related word), its folder (2.5, or 1 when the folder holds other kinds too, like Piano & Keys), and Live's tags (2.5). Kinds of sound count 1.5 times.
  - An item that isn't the kind asked for scores much lower. MPE sounds lose a point and are marked, unless the user says "MPE".
  - It keeps one item per name, since a `.adg` rack and a `.adv` preset with the same name read as the same choice.
- **Live's tags:** Live's Python API can't see tags, so the server reads them from the packs' own files, `Ableton Folder Info/*.xmp`. It looks in:
  - Live's Core Library: `C:\ProgramData\Ableton\Live 12 Suite\Resources\Core Library` on Windows, or `Ableton Live 12 Suite.app/Contents/App-Resources/Core Library` on the Mac;
  - each folder in `~/Music/Ableton/Factory Packs`;
  - the User Library.
  - `SECOND_CHAIR_ABLETON_LIBRARIES` (folders split by `;` on Windows, `:` on the Mac) replaces that list. The tests use it.
  - Tags match a browser item by file name. When two packs share a file name, the one in the same-named folder wins.
  - Without tag files, it still matches names and folders, and says so.
- **Caching:** the server keeps each tree's list for 10 minutes and the tags until it restarts. `refresh: true` re-reads both, for example after installing a pack.
- **Undo:** `live_load_sound` reports `undo_steps`: 1 for the load, 2 more for a new track and its name, and 1 for arming. Live may group these.

## Swapping one pad's sample (bridge 0.5.0)

Shared with the Mac port. This is a deliberate change to the safety rules, agreed with the user on 2026-11-08: replacing is fine when the user asks for it, and the old sound is saved first.

- **`swap_pad_sample`** `{track, pad, sample, tree?}` → `{track, track_name, pad, note, note_name, was: {sample, file}, now: {sample, file, path, from}, kept, undo_steps, notes?}`.
  - `pad` can be:
    - a number 1-16 (pads from C1 = MIDI 36 up, as the keyboard's Bank A sends them);
    - a MIDI note 17-127;
    - a note name ("C#1");
    - words from the pad's name ("snare"). It refuses when more than one pad matches.
  - `sample` is a browser path. The bridge matches the longest tail of the path in Places, then the User Library, Samples and Drums (or only `tree`). Then it looks a few folders down for that file name. The MCP server turns a disk path into its last three names, as for kits.
  - **What it refuses:** a track with no Drum Rack, an empty pad (use a normal load), a layered pad, a pad with no Simpler or Sampler, a device instead of a sample, and the sample the pad already plays.
  - **How it swaps:** it sets `browser.hotswap_target` to the pad's Simpler and calls `load_item(sample)`.
    - **In Live 12.4.16, Live rebuilds the pad instead of swapping inside the Simpler.** The result says `kept: "volume and choke group"` and a note. The bridge puts back the pad's volume and choke group if they changed, but the Simpler's own settings (start, length, envelope) go back to defaults.
    - When Live keeps the Simpler, `kept` says "Simpler settings, volume and choke group".
  - **Guard:** it snapshots every other pad (chains, devices, sample files) before the swap. If any of them changed, or the pad's layout changed, it calls `song.undo()` and refuses.
- **Saved swaps:** `live_swap_pad_sample` appends each swap to `~/SecondChair/pad-swaps.jsonl` (track, pad note, old and new sample with file paths). `SECOND_CHAIR_STATE_DIR` moves this file; the tests use a temp folder.
  - `restore: true` (optionally with `pad`) swaps back to the old file from the newest open swap on that track. It is saved too, so the same swap isn't put back twice.
- **Possible later:** Live 12.4's `SimplerDevice.replace_sample(file_path)` would keep the Simpler's settings. It takes disk paths, and the browser API gives no disk path for an item. So it would need the contract to carry disk paths, which the Mac port would need to agree first.

## A second door: MCP over HTTP (0.9.5)

For front ends that can't start a local command, or whose runner for local commands fails (HeyClicky 1.1.5 on Windows). Part of the product direction: the engine serves any front end.

- **Start it:** `node live-bridge/mcp/server.ts --http` (port 9887; `--http 9900` or `SECOND_CHAIR_HTTP_PORT` picks another). Without `--http` the server speaks stdio as before.
- **Address:** `http://127.0.0.1:9887/mcp`. MCP "Streamable HTTP" with plain JSON answers: POST a JSON-RPC message, get its answer; notifications get 202; GET gets 405 (no event stream).
- **Safety:** it listens on 127.0.0.1 only. Every request needs the bridge token, as `Authorization: Bearer <token>` or `X-SecondChair-Token`. A request with a web page's Origin, or a Host that isn't this computer, is refused (403).
- **Checked:** no token and a wrong token get 401, a web Origin 403, `initialize` / `tools/list` / `tools/call` answer, and the stdio tests still pass. **Not checked:** HeyClicky or Spur connecting to it.
- Port 9887 is also Chord Coach's number, but that one is UDP and this is TCP, so they don't clash. Keep it in mind when reading a port list.
- **Checked on the Mac too** (2026-11-12, against the fake Live): the same answers, 56 tools listed.
- The Remote Script is unchanged apart from the version number; Live doesn't need a restart for this.

## Any user: the studio profile (0.9.8)

First step towards the beta: the tools and the guide hold no one's name or details. Those live in the studio profile.

- **The studio profile** (`mcp/profile.ts`): one Markdown file per user and machine, at `~/SecondChair/my-studio.md` (`SECOND_CHAIR_STUDIO_FILE` overrides it). It holds the user's name, how they like to be taught, their controller, interface, instruments, sample folders and plugins, and fixes that are about their machine.
- **`my_studio`** `{text?}`: reads the profile. With none, it returns the questions to ask. With `text`, it saves the profile and keeps the previous one as `my-studio.previous.md`. Works without Live.
- **Names:** tool descriptions, the server instructions, the guide and refusals are written for "the user". When the profile has a `- **Name:** ...` line, the server swaps that name in as it sends them (`personalize`). Names are letters, spaces, `-` and `'`, at most 30 characters.
- **`live_status`** adds `studio_profile` ("yes (name)" or "none yet: call my_studio").
- **`my_plugins`** `{text?, find?}` (added 2026-11-13): the plugin guide, `~/SecondChair/my-plugins.md` (`SECOND_CHAIR_PLUGINS_FILE` overrides it). One line per plugin: what it is and what it's good for, marked "(unconfirmed)" until the user has checked it. With none, it returns the outline and how to write it from the installer's `--survey` list. `find` returns only the lines (and headings) that hold any of the words. With `text`, it saves the guide (at most 150,000 characters) and keeps the previous one. `live_status` adds `plugin_guide`. Works without Live.
- **`studio_guide`** ends with a "My studio" section holding the profile; `section: "my studio"` returns just that.
- **The guide** (`SKILL.md` and the playbooks) keeps what's true for everyone. The user's own details moved out of the repo, into one profile file per machine; each machine copies its one to `~/SecondChair/my-studio.md`.
- **The Remote Script** only had its messages reworded ("ask the user"). Its actions are unchanged, so `NEEDS_BRIDGE` stays 0.9.6 and an older installed script keeps working.
- **The names** changed on 2026-11-13: the product is Second Chair, the Remote Script is SecondChair, the MCP server is second-chair, the settings start with `SECOND_CHAIR_`, and the home folder is `~/SecondChair`. The installer moves an older install over (`migrate` in `install.mjs`).

## Real-Live fixes: alignment and bouncing (bridge 0.9.8)

From the beat chat's first real use of 0.9.6 (2026-11-12). These change the Remote Script, so they need an install and a Live restart.

- **`align_audio` misread where notes fall.** Previews found 20-25 starts but moved none, even against a 1/8 grid, and one clip had "no starts inside the clip". The cause, as far as the evidence goes: `Clip.sample_to_beat_time` doesn't take seconds. Now the bridge doesn't call it. It reads the clip's own `warp_markers` and draws straight lines between them (`_warp_map`), and it works out whether the markers count seconds or samples from the file's length, which the server now sends. New markers are added in the markers' own unit.
  - If a clip's starts still all read as one moment, it refuses and changes nothing.
  - The result lists `first_starts_at_bars` and `lead_starts_at_bars`, so a wrong reading shows at a glance.
  - **`live_audio_clip_info`** returns what Live reports about a clip (markers, start and end markers, position), for tracing.
  - **Still a guess until tried in real Live:** the unit of `WarpMarker.sample_time`, and that an Arrangement clip's left edge is its start marker.
- **`bounce_track` on a group track** put the print inside the group, fed by the group's own output. Now a group's print is made at the end of the track list. If Live still groups it, its output goes to Main. After every bounce the print's input is set to "No Input".
- **The print started about 80 ms after the bar.** Punching in by hand is up to one display tick late. Now the bounce sets the loop brace to the bars and uses Live's Punch In and Punch Out (`Song.punch_in`, `punch_out`), with Record on from the pre-roll, so the take has exact edges. The brace and punch switches are put back.
- **Not tested:** the group case has no stand-in in the fake Live.

## Measuring a bounce: loudness and tone (second-chair 0.9.7)

For mastering, where Claude has no ears (the beta's first use, 2026-11-12). MCP server only: the Remote Script stays 0.9.6.

- **`audio_analyze`** `{file | clip, reference?}` (`mcp/loudness.ts`): integrated loudness in LUFS (ITU-R BS.1770-4: K-weighting made for the file's sample rate, 400 ms blocks, gates at -70 LUFS and -10 LU), loudness range (EBU Tech 3342), the loudest 3 seconds, true peak (4x, checked near the loudest samples), sample peak, RMS, crest, clipped samples, energy share in six bands (an FFT average over each channel), and stereo correlation and side-versus-mid level. With `reference`, the same for a second file and the differences. `reading` puts the main points in plain words.
- **Checked against known signals:** a 1 kHz stereo sine at -23 dBFS reads -23.0 LUFS at 48 kHz and 44.1 kHz; with quiet sections before and after it still reads -23.0 (gating); a 12 kHz sine whose samples miss its peaks reads the true peak 3 dB above the sample peak.
- **Tried on real files:** one quiet bounce reads -25.6 LUFS with a true peak of -10.7 dB; an earlier bounce reads -13.7 LUFS and -1.7 dB. 91 seconds of stereo takes about 1.5 s.
- WAV only (16/24/32-bit PCM, 32-bit float). No MP3 or AIFF yet.
- **Version check:** `live_status` now warns only when Live's Remote Script is older than `NEEDS_BRIDGE` (0.9.6), so server-only releases like this one don't ask for a Live restart.
- **Playbook:** `playbooks/mastering.md` (the export-measure-listen loop, what each number means, the chain on Main, Ozone).

## Song analysis: key, tempo and more (song_analyze, not yet released)

What the music is doing, from a full mix. A port of the one-off scripts `key_tempo.py` and `fold.py` (Cello Brain, `inbox/music-studio/song-analysis-scripts`), from the song chat of 2026-11-18. MCP server only.

- **`song_analyze`** `{file | clip}` (`mcp/songanalysis.ts`). Read-only. WAV only, like `audio_analyze`. Everything is measured in mono at 22.05 kHz (a windowed-sinc resampler).
  - **Key:** spectral peaks per frame (55 Hz to 2.5 kHz), the tuning offset, a 12-note chroma, then correlation with three key profiles (Krumhansl-Kessler, Temperley, Albrecht-Shanahan). It reports the best key, the runner-up, the relative key (always), the scale's notes, the key per section, and the top five. F♯ major and D♯ minor are named with sharps, with the flat name beside them.
  - **Key confidence:** high only when all three profiles agree, every section agrees, the winner leads the runner-up by 0.05 and the relative key by 0.10. Within 0.10 of the relative key it says "the relative key is close: listen for home". Low when one profile or fewer agrees, under half the sections agree, or the lead is under 0.02.
  - **Tuning:** cents from A440, with how much the peaks agree on it.
  - **Tempo:** spectral-flux onsets in log bands, a Fourier tempogram and an autocorrelation, a dynamic-programming beat tracker (Ellis 2007), and a straight-line fit through the beats. It picks the pulse both methods back (the strongest periodicity alone was a syncopated hat at 175 in a 140 song). Then it leads with the reading nearest 110 BPM, a convention; the half and the double sit beside it.
  - **Repeats:** a short pattern (the loop length, 1 to 12 s, that makes the hits line up best, as `fold.py`, preferring 1, 2, 4, 8, 16 or 32 beats), and a chord cycle and a bass cycle (after how many bars the notes come round again, from bar-by-bar chroma).
  - **Drums:** the mix is split into hits and held notes by median filtering (Fitzgerald 2010). If the low hits (30–150 Hz) make less than −18 dB of the mix, it says "no clear drums" and draws no map. Otherwise it draws one bar of kick, snare and hats in 16 steps, placed by the tracked beats, from a downbeat guess (where the chords change most, with the kick as a tie-break).
  - **Bass note per bar, rough:** the strongest pitch class from peaks at 32–120 Hz. The upper limit is kept low because the song chat's 200 Hz limit caught the voice.
  - **Loudness and tone:** `analyze()` from `loudness.ts`, on the same audio. The FFT is shared from there.
- **Each reading** has a confidence and a check-by-ear step. The description follows the mentor rule: report, offer options, and the user decides by ear.
- **Checked** (`test/song_analyze.ts`, 16 checks):
  - The made-up loop (G minor, 92 BPM, Gm–E♭–Cm–D) comes back as G minor at 92.00 BPM, chord and bass cycle 16 beats, bass notes G, E♭, C and D, with a drum map. Without its drums: still G minor, and "no clear drums".
  - A 2-minute R&B song with no drums read the same as the Python scripts: F♯ major with D♯ minor close behind (medium: listen for home), 123.99 BPM, +1 cent, chord cycle 32 beats, no clear drums. Its hook bass came out B–G♯–D♯–C♯, the same as its bass stem. About 5 s.
  - The drum line (−18 dB) rests on seven files: three mixes with drums (−11 to −16 dB) and four without (−20 to −43 dB). Treat it as a first guess.
  - A 140 BPM trap beat (felt as 70) reads 139.35, half 69.7. A 4:52 house track takes about 12 s.
- **Not yet:** stems (step 2 of the plan), MP3, chords, vocal range.

## Return tracks and Main in real Live (bridge 0.9.6)

- **The 0.9.5 bug:** `live_status` failed in real Live with "RuntimeError: Main and Return Tracks have no Clips". On return tracks and Main, Live raises RuntimeError for clip properties (`clip_slots`, `playing_slot_index`). `getattr(t, ..., default)` only catches AttributeError, so it didn't help.
- **The fix:** `_safe()` and `_slots()` read those properties. `_slot` refuses return tracks and Main with a clear message. The fake's return tracks and Main (`NoClipTrack`) now raise the same way, so the tests catch this.
- **Checked in real Live 12.4.16 on the Mac (2026-11-12), on an empty set:**
  - `live_status` lists the return tracks and Main with the right numbers.
  - `create_audio_track`, `create_return_track` and `set_monitoring` work. A new audio track starts with Monitor "off".
  - `get_track` works on a return track and on Main. A clip slot on Main is refused.
  - `live_revert` took all of it back.
- **Still not checked:** whether a bus's input follows the tracks routed to it, automation and meters on return tracks and Main, and the HTTP door with real Live.
- **Also in 0.9.6 (Windows lead):** `_arr()` reads Arrangement clips the same safe way everywhere; `get_arrangement` works on a return track's number; `place_clip` and `move_arrangement_clip` refuse return tracks and Main as targets.

## Lining up stacked takes (bridge 0.9.6)

The user, 2026-11-12: three stacked vocal takes should start their notes together. By hand that's Ctrl+U or dragging warp markers.

- **MCP side (`mcp/onsets.ts`):** reads the take's WAV (16/24/32-bit PCM or 32-bit float) and finds note starts: a level jump within 15 ms, then the first sample that reaches a quarter of the local peak. `sensitivity` 0-100. Soft, slurred starts are missed, and a missed start is simply left alone.
- **`audio_clip_info`** `{clip}`: the clip's file and warp state. A clip is `{track, slot}` (Session) or `{track, bar, name}` (Arrangement).
- **`align_audio`** `{clip, onsets, to + to_onsets | grid, max_ms, preview}`: turns each start into a song beat (`Clip.sample_to_beat_time`, the clip's start marker and position). A start within `max_ms` of the lead's nearest start (or grid line) gets that beat; every other start keeps its own. Then one `Live.Clip.WarpMarker(sample_time, beat_time)` per start through `Clip.add_warp_marker`, so moved starts land on target and the rest are pinned. A start never crosses the one before it. Warp is switched on if it was off. Revertible (`remove_warp_marker`, Warp back off).
- **Guesses to check in real Live:** the `WarpMarker(sample_time, beat_time)` argument order and that `sample_time` is in seconds; `remove_warp_marker(beat_time)`; that an Arrangement clip's left edge is its start marker; and how the stretched syllables sound (Complex or Complex Pro warp mode suits vocals).
- Tested against the fake with two generated takes: 6 of 7 starts 30 ms late move onto the lead, and one 200 ms late stays.

## Buses and return tracks (bridge 0.9.5)

The user, 2026-11-12, by way of the beat chat: three vocal tracks each had their own Echo and Reverb; "can we get around these limitations?" Live's API can't group tracks (no Ctrl+G), so a bus is built from routing.

- **One numbering for every track:** regular tracks, then the return tracks, then Main (`_all_tracks`). `get_session` lists `returns` (with `send`: "Send A"...) and `main` with their numbers. So `load_device`, `get_device_params`, `set_device_param`, `move_device`, `get_levels`, `record_automation` and the rest work on return tracks and Main. `delete_track` and `duplicate_track` refuse them.
- **`create_audio_track`** `{name?, index?}` and **`create_return_track`** `{name?}` (`Song.create_audio_track`, `Song.create_return_track`). Revertible while empty (`delete_track`, `delete_return_track`).
- **`set_monitoring`** `{track, monitor: in|auto|off}`: `Track.current_monitoring_state` (0, 1, 2). Revertible.
- Track info now has `monitor`, `in_group` (the group's name) and `is_group`.
- **A bus without grouping:** `create_audio_track` "Vocals Bus"; each vocal track's output to it (`set_routing`, `io: "output"`); the bus's Monitor to `in`; the shared effects once on the bus. A new track shifts the numbers of everything after it, returns and Main included: read `live_status` again.
- **Still not possible:** grouping tracks, saving the set, exporting audio (no script API for any of them).
- **Not checked in real Live yet:** all of this, including whether a bus track's input follows the tracks routed to it without more setup.

## Automation shapes, several knobs, plugins (bridge 0.9.4)

The user, 2026-11-12: use the recording trick for "any sort of automation/modulation", and "any parameter on plugins".

- **One shape engine** (`_lane`) for `record_automation` and `automate`. Each lane is one knob, with one of these:
  - `start` / `end`: a ramp, with `curve`: `linear`, `ease_in`, `ease_out`, `s` or `step` (hold, then jump).
  - `points`: `[{bar, text|percent|value, curve?}]`. Each point's curve shapes the way to the next point.
  - `lfo`: `{shape: sine|triangle|square|saw_up|saw_down|random, rate, low, high, phase}`. The rate is a note length (`"1/4"`, `"1/8t"`, `"1/4d"`), bars (`"2 bars"`) or beats.
- **`record_automation`** takes `lanes` (up to 8 knobs, on any tracks) and records them in one take, each as its own gesture.
  - **Speed limit:** a recorded wobble must take at least 0.8 s per cycle (`MIN_LFO_SECONDS`). The bridge only gets Live's display tick, about 10 a second. Faster wobbles are refused, with a pointer to Live's LFO device or a Session clip.
- **`automate`** is now Session-clip only (Live refuses Arrangement clips). It writes the shape exactly with `insert_step`: steps of a quarter beat, or 1/16 of an LFO cycle, at most 2048.
- **Plugins:** a plugin knob is a `DeviceParameter` like any other, so every shape works on it. Plugin knobs take `percent` or `value`, not `text`, because they only show their current setting. Live exposes only the plugin parameters in the device's list; the plugin's Configure button adds more.
- **Checked in real Live (0.9.3, 2026-11-12):** `record_automation` works. Utility "Output" on 3 tracks read back exactly (-18 dB at bar 33, -11 at 37, -4.04 at 41), with a smooth line (127 steps over 8 bars). Three gotchas, handled in 0.9.4:
  1. **Live only writes while a knob moves.** A flat take wrote nothing. Now, wherever a knob should stay still, it's nudged by 1/10000 of its range each tick, so Live keeps writing.
  2. **On an empty lane** (`automation_state` 0), the first recorded point holds backwards to the start of the song. Now such a lane first gets its current value recorded in the bar before `from_bar` (reported as `kept_before`).
  3. **After punch-out,** the lane goes on with what it had before, so a ramp up falls back afterwards. Now `hold_to_bar` (a bar, or `"end"` for the last Arrangement clip's end) keeps the end value.
  - A leftover point at time 0 from the first 0.9.3 take can't be removed by a script: delete it by hand in the lane.
- **Read-back:** after every take, `record_automation` moves the play position to bars before, inside and after the ramp (Live stopped), lets Live apply the automation, and reports each knob's setting as `read_back`. `read_knob` `{track, device, param, bars}` does the same for any bars. The beat chat checked takes this way by hand in real Live. Plugin knobs are refused there, because they show their setting late.
- **Read-back check:** each reading is compared with what the take meant to leave there (1 % of the knob's range). Mismatches come back as `read_back_mismatch` with a `warning`; `read_back_ok` is true when all match. Exactly at `from_bar` (after bar 1) the old and new settings meet, so that one reading isn't compared; bar `from_bar + 0.1` is read instead.
- **Real Live, 0.9.4:** a take from bar 1 still left an old point covering the first tenth of a beat. Live writes a take's first value a moment late, so recording can't reach the very start of the song: delete such a point by hand. The flat-take nudge and `read_knob` worked.
- **Version check:** `live_status` compares the Remote Script's version with the MCP server's and adds `version_warning` when they differ. On 2026-11-12, Live had started before an install, kept the old script, and every new tool answered "unknown action".
- **Playbooks:** `.claude/skills/second-chair/playbooks/` (session-start, sound-design, mixing, arrangement, recording). These are the beat chat's lessons from two days of real use as step-by-step rules. `studio_guide` serves them with `playbook`.
- **`play_range`** `{from_bar, to_bar, melodyne_track?}` (MCP: `live_play_bars`): plays the Arrangement once over the bars and puts the loop and play position back. With `melodyne_track`, it first checks Melodyne is device 0 on that track and the track has clips there. This is for Melodyne's Transfer: Live 12 has no ARA, so Melodyne must hear the part played. The bridge can't press Transfer inside the plugin window; the user does.
- **`bounce_track`** `{track, from_bar, to_bar, name?, channel?}`: `Song.create_audio_track` right after the source, with input = the source track (`"<n>-<name>"`, channel Post FX by default) and monitoring Off. Other armed tracks are disarmed for the take. It plays from a bar early, punches Arrangement Record in and out, then puts everything back. It prints Melodyne edits and effects, and it's the bridge's way to bounce (Live has no render call for scripts). Not revertible (live_undo).
- **Not checked in real Live yet:** read-back timing (two ticks after a jump), `version_warning`, `play_range`, `bounce_track` (route names, Monitor Off, the take landing as one clip), Melodyne Transfer with `play_range`.
- **Can't be done:** Live 12's own modulation (the per-clip modulation envelopes in the Arrangement) has no script access. Macro mappings can't be made from a script either.
- Fake Live: gestures recorded per knob, and the tests check a points + LFO take, the speed limit, a Session LFO and a plugin knob.

## Recorded automation on the Arrangement (bridge 0.9.3)

The user's top request on 2026-11-12: volume builds and fades on the timeline. Live gives scripts no way to draw on a track's Arrangement automation lane, and clip envelopes are Session-only (0.9.1). So **`record_automation`** records it, the way a controller knob does:

1. It refuses if Live is playing, and saves the state: Arrangement Record, the Arrangement Loop, Automation Arm (`Song.session_automation_record`), Back to Arrangement, the play position, and which tracks are armed.
2. It disarms armed tracks (so the take records nothing else), turns the loop off and Automation Arm on, sets the knob to the start, and plays from one bar before `from_bar`.
3. At `from_bar` it punches in (`record_mode = True`) and calls `DeviceParameter.begin_gesture()`. Every tick it sets the knob along a straight line by song time. At `to_bar` it sets the end value, calls `end_gesture()`, and punches out.
4. It stops and puts everything back, even if the take fails. If the user stops Live part way, the result says only part was recorded.

- It replaces any automation already in those bars. Live plays out loud during the take. At most about 4.5 minutes per call (`MAX_RECORD_SECONDS`).
- Undo: `live_undo` straight away (Live's own undo). `live_revert` can't take a recording back.
- **Guesses to check in real Live:** that Live records a script's gesture as automation (that's what `begin_gesture` is documented for); that `session_automation_record` is the Automation Arm Live 12 uses for the Arrangement; and how smooth the line comes out at one point per display tick (about 10 a second).
- The fake Live now has a clock (song time moves while playing) and records gestures while Record and Automation Arm are on.

## Devices, meters, racks and clip edits (bridge 0.9.2)

From a beat session's issue list (2026-11-12).

- **Racks:** any device argument takes a path, `"808 Rack > chain > Device"`. The chain can be left out when the rack has one. `get_device_params` on a rack lists its chains and their devices. This works for reading and setting knobs, moving, deleting and automating. Uses `RackDevice.chains` and `Chain.devices`.
- **`move_device`** `{track, device, position | before | after}`: `Song.move_device(device, owner, position)` within the same track or chain. Revertible.
- **`delete_device`** `{track, device, name}`: only when the user asks; the name must match. Not revertible with live_revert (live_undo).
- **`get_levels`** `{track?, seconds?}`: watches `Track.output_meter_level` / `_left` / `_right` for every track and Main (`Song.master_track`) and reports the peak, 0-1. Up to bridge 0.10.0 the bridge's own `about` read that value on the volume fader's scale, which is wrong by about 9 dB at typical levels, and asking for a return track or Main by number failed (IndexError), though Main was in the full list. Bridge 0.10.1 fixes both: the full list has regular tracks, return tracks and Main (`kind`: track, return, main), and any of them can be asked for by number. Live's meter value is a straight line in dB (`76 x value - 70`: 0 is -70 dB, 0.921 is 0 dB, 1 is +6 dB), measured in Live 12.4 with a sine at 14 levels from -62 to +4 dB against Second Chair Ears and Live's own peak readout. Bridge and server both return `peak_db`, `about` and a word: silent, low (under -18 dB), healthy, hot (above -3 dB), near the top (0 dB or over). The server (0.10.1) does the sum again from `peak`, so the dB is right with an older bridge too. For gain staging without reading meter colours.
- **`copy_clip`** `{track, slot, to_track, to_slot}`: `ClipSlot.duplicate_clip_to` into an empty slot. Revertible.
- **`move_arrangement_clip`** / **`delete_arrangement_clip`** (MCP: `live_arrangement_clip`): the clip is named by its name and start bar, and both must match. Live has no move for scripts, so a move is `duplicate_clip_to_arrangement` at the new bar, then `Track.delete_clip` on the old one. It never covers clips, and it's revertible. Delete is not revertible with live_revert (live_undo). Trim and split: no script API.
- **`test/try_tool.ts`** takes `@file.json` or `-` (stdin), since PowerShell 5.1 splits JSON with spaces.
- **Not built:** `tools/list_changed`. The tool list is code in `server.ts`, so a running server can't gain new tools without restarting its process. Still: new chat, or try_tool.
- **Not checked in real Live yet:** all of 0.9.2, especially `move_device` positions within the same chain, `Chain.delete_device`, `duplicate_clip_to_arrangement` with an Arrangement clip as the source, and the meter scale.

## Loads that land on the wrong track, and Arrangement automation (bridge 0.9.1)

Found in a beat session in real Live on 2026-11-12.

- **A load went to the wrong track.** `load_device` for track 8 put Utility on track 0 (the selected track), twice, and then reported "Live didn't add anything". My guess at the cause: the bridge selected track 8 and loaded on the same tick, and in real Live the new selection can take a tick to apply. Selecting first and loading in a later call worked.
  - Now every browser load selects the track and waits until Live shows it selected (or refuses after a few ticks).
  - `load_device` also checks every other track. If something landed elsewhere, it deletes just those new devices and says so.
- **Live refuses automation in Arrangement clips.** `create_automation_envelope` on an Arrangement clip raised "Not a session clip or parameter belongs to another track." This happened for the mixer's Volume and for a device knob (Utility "Output" on MIDI clips), so it's the API's limit. So `live_automate` works only in Session clips (`slot`), and for Arrangement clips it now says to draw by hand, or to automate a Session clip and place it. Whether a Session clip's envelope comes along when it's placed with `place_clip` is untested.
- **Checked in real Live:** `get_arrangement` reads correctly, and fraction text ("2" on Auto Pan's LFO Synced) works.

## The Arrangement timeline and automation (bridge 0.9.0)

Asked for by the user on 2026-11-12 ("everything also fades and timeline operations", "parameter automations"), after the beat chat fell back to computer use while the user was working in Live.

- **`get_arrangement`** `{track?}`: each track's `Track.arrangement_clips` as `start_bar`, `end_bar`, `bars` (bars from 1), the last bar used, and the Arrangement Loop (`Song.loop`, `loop_start`, `loop_length`). The loop matters: on day 1 it made Arrangement Record wrap round and record over earlier bars.
- **`place_clip`** `{track, slot, bar, bars?, to_track?}`: `Track.duplicate_clip_to_arrangement(clip, time)`, repeated back to back to fill `bars`; the last copy may run past (the result says so). Refuses anywhere a clip already sits (Live itself would cover it). MIDI to MIDI tracks, audio to audio. Revertible (`Track.delete_clip`).
- **`duplicate_track`** `{track}`: `Song.duplicate_track`; the copy lands right after. Revertible while the copy's devices and clips are unchanged.
- **`rename_track`** / **`rename_scene`** (one MCP tool, `live_rename`). Revertible.
- **`automate`** `{track, device, param, from_bar, to_bar, start, end, slot?}`: a straight ramp written with `AutomationEnvelope.insert_step` (quarter-beat steps, at most 256 per clip). `start` / `end` are `{text}`, `{percent}` or `{value}`, as for `set_device_param`. Fades are this on the mixer's Volume.
  - **Live only lets scripts write automation into Session clips** (clip envelopes; 0.9.1 found Arrangement clips are refused). There is no script access to a track's own Arrangement automation lane.
  - Revertible when the clip had no envelope for that knob before (`clear_envelope`). Over an existing envelope it's logged as not revertible: use `live_undo` straight away.
  - **Guesses to check in real Live:** that Arrangement clip envelope time counts from the clip's start marker; that a mixer Volume envelope in an Arrangement clip acts on the track (in Live, an Arrangement clip's mixer envelopes may be modulation, which scales the track's volume rather than setting it); and what happens to a Session clip's envelope when it's placed on the Arrangement.
- **Not possible through Live's script API (checked in the Live 12 exe):** audio clip fade handles (no fade property), track delay, plugin sidechains (0.8.2), and rendering to a file (no export call).
- **Not checked in real Live yet:** all of 0.9.0.

## Note-length knobs and plugin sidechain text (bridge 0.8.2)

Found in a beat session on 2026-11-12: `text: "1/4"` on Echo's "L Synced" set 1/64.

- **Cause:** display text like "1/64", "1/4" and "1/1" was read as the number 1, so every step looked the same and the search took the lowest end.
- **Fix:** "a/b" now reads as a fraction. For a knob with whole-number steps and no named choices (Echo's synced times run -6 ... 0), the bridge first looks for the step whose text matches exactly.
- **Plugin sidechains:** `live_get_routing` and `live_set_routing` now say plainly that a VST/AU sidechain (Kickstart 2) can't be reached by scripts and must be set by hand; the tool text no longer names plugins. Seen again in real Live on 2026-11-12, on an existing and a freshly loaded Kickstart 2.
- **Echo's Link:** setting the left side through the API doesn't move the right side, even with Link on (seen in real Live). Set R Synced and R Sync Mode too.

## Transport buttons for recording into the Arrangement (bridge 0.8.1)

Asked for by the user on 2026-11-10: launched Session clips kept playing after Stop, so the next Arrangement take recorded them from bar 1.

- `stop_all_clips`: Live's `Song.stop_all_clips()` (Stop All Clips; quantized like the button).
- `back_to_arrangement`: sets `Song.back_to_arranger = False`, which is the Back to Arrangement button.
- `set_record {on}`: `Song.record_mode` (Arrangement Record).
- `jump_to_bar {bar}`: `Song.current_song_time = (bar - 1) * beats per bar`.
- Each returns `{is_playing, record, bar, session_overrides_arrangement}`. The MCP server folds them into `live_transport` (`stop_all_clips`, `back_to_arrangement`, `record_on`, `record_off`, `jump` with `bar`). Not in the revert list (like play and stop).
- **Not checked in real Live yet.**

## Sample chopping (bridge 0.8.0)

Asked for by the user on 2026-11-10 while chopping a vocal loop.

- **Where files come from.** Live's Splice integration saves downloads to `User Library\User Library\Samples\Splice\`. The MCP server's `live_load_sample` takes a full path, or a name or words from it, and looks in the User Library's `Samples` folder and `Documents\Samples` (`mcp/samplefiles.ts`; `SECOND_CHAIR_SAMPLE_DIRS` replaces the list). Or `from_clip` uses an audio clip's own file (`AudioClip.file_path`) and keeps the clip's transpose.
- **`load_sample`** `{track, file | from_clip: {track, slot}, mode?, slice_by?, sensitivity?, beat_division?, regions?, warp?, warp_mode?, transpose?, slice_playback?}`: on a MIDI track with no instrument, `Track.insert_device("Simpler")` (Live 12.3+), then `SimplerDevice.replace_sample(path)`, then the settings. Only audio file types, and the file must exist. One change in the revert list (the Simpler); the MCP server adds the new track and the arm and reports `revert_steps`.
- **`get_simpler` / `set_simpler`**: Live's `SimplerDevice.playback_mode` (classic, one-shot, slice), `slicing_playback_mode` (mono, poly, thru), and on its `Sample`: `slicing_style` (transient, beat, region, manual), `slicing_sensitivity` (0-1; the tool takes 0-100), `slicing_beat_division` (1/16 … 4 bars, a guess at Live's order), `slicing_region_count`, `warping`, `warp_mode`, plus the Transpose knob. Every setting is checked before any is applied. Revertible.
- **`set_audio_clip`** `{track, slot, transpose?, warp?, warp_mode?}`: an audio clip's `pitch_coarse`, `warping`, `warp_mode`. Revertible.
- **`delete_track`** `{track, name}`: only when the user asks for that track to go. The name must match, and a track with clips is refused. Not revertible by `live_revert` (it says to use `live_undo` straight away).
- Warp mode numbers: beats 0, tones 1, texture 2, re-pitch 3, complex 4, rex 5, complex pro 6.
- **Checked in real Live (12.4.16, 2026-11-10):** `get_simpler` reads a Simpler the beat chat set up (slice mode, transient slicing, 30 slices, warp off, -6 st). The 0.7.0 change list fills in real Live (`live_revert` preview lists the beat chat's clip writes, all revertible). The set name reads from the window title.
- **Not checked in real Live yet:** `replace_sample` from a script, the beat-division order, whether `slices` updates on the next tick, and whether Live inserts Simpler where asked.

## Taking back the bridge's own changes (bridge 0.7.0)

Asked for by the user on 2026-11-10: `live_undo` is Live's global undo, so after the user had edited the set it took back one of the user's own changes.

- Every action that changes the set adds one entry to the bridge's **change list** (in memory, newest last, at most 100; it starts empty when Live starts). An entry is made of parts, and each part can check itself:
  - `left`: still as the bridge left it, so it can be put back;
  - `back`: already back (by `live_undo`, or by hand), so there's nothing to do;
  - `changed`: someone changed it since, so the revert stops there and says what.
- What's on the list: tempo, scale, arm, a parameter's value, routing (source and channel, by name), a clip it wrote (deleted on revert, if it still holds the same number of notes), notes it added (removed by note id), devices it loaded (deleted, if their top-level settings are unchanged), a track it made (deleted, if it has no devices or clips by then), a drum kit and its track name.
- Not revertible here (the entry stops the revert and says how instead): an audition swap, and a pad sample swap.
- **`revert`** `{steps=1, preview=false, skip=false}`:
  - Reverts the newest `steps` entries, newest first, as one job. On a `changed` entry it stops; if that was the first, it's an error and nothing changed.
  - `preview` lists them with `can_revert`, `already_back` and `why_not`.
  - `skip` drops entries from the list without touching Live, for when the user wants to keep the change.
- `arm_track` now also returns `changed`, so the MCP server can count `revert_steps` for `live_load_sound`: the new track, the load, and the arm.
- Reverting a clip, device or track deletes it. That's the one place the bridge deletes anything, and only things it made itself, unchanged since.
- **Not checked in real Live yet:** `ClipSlot.delete_clip`, `Track.delete_device`, `Song.delete_track` and `Clip.remove_notes_by_id` from a script, and whether reading a parameter's value after a plugin moves is exact enough to compare.

## Which set is open, and new track numbers (bridge 0.6.1)

- **`live_status`** now has `set: {name, unsaved, untitled, warning?}`. Since bridge 0.11.0 the name and file come from Live's API (`Song.name`, `Song.file_path`; an empty path means a set that was never saved), and the window title only gives the `*`, because the API has no unsaved-changes flag. With an older bridge the MCP server reads everything from Live's window title (`mcp/liveset.ts`): on Windows "my-song* - Ableton Live 12 Suite", where `*` means unsaved changes. A set named "Untitled" gets a `warning`: it's probably an empty set Live opened instead of the user's song, so ask before changing anything. If the title can't be read, `set` is `{unknown: "..."}`. On the Mac it asks System Events for the window name (a guess until checked there). `SECOND_CHAIR_LIVE_TITLE` overrides the title for tests.
- **`create_midi_track`** (and `new_track` on the loading tools) now finds the new track by comparing the track list before and after. Real Live puts a track made with index -1 right after the selected track, not at the end, so 0.6.0 and earlier reported the wrong index. The fake does the same once the test sends the fake-only action `fake_after_selected`.
- **Checked in real Live (0.6.0, 2026-11-10):** track input/output routing reads correctly (Live calls the master "Main"). Kickstart 2 (VST3) has no sidechain the API can reach: `get_routing` refuses it. Plugin sidechains have to be set by hand.

## Routing, plugin knobs and auditions (bridge 0.6.0)

Shared with the Mac port. Asked for by the user on 2026-11-10 while building a beat: Kickstart 2 needed its sidechain set to the kick, a plugin knob was set to the wrong end, and trying sounds one by one took a chat round trip each.

- **`get_routing`** `{track, device?}` → `{track, track_name | device, routes: {<io>: {from, channel, choices, channel_choices}}}`.
  - No device: the track's `input` and `output`, from Live's `available_input_routing_types` / `input_routing_type` / `..._channels` / `input_routing_channel` (and the `output_` ones).
  - With a device: `sidechain` for devices that carry the routing themselves (Live's `CompressorDevice` has `available_input_routing_types` and the rest), and `audio input N` / `midi input N` for each of the device's `audio_inputs` / `midi_inputs` (`DeviceIO`: `available_routing_types`, `routing_type`, `available_routing_channels`, `routing_channel`). A plugin's sidechain bus was expected to show up as an audio input, but in real Live it doesn't (see 0.8.2). It refuses the mixer, and a device with nothing to route.
- **`set_routing`** `{track, device?, io?, source?, channel?}` → `{track, on, io, was: {from, channel}, now: {from, channel}, channel_choices, undo_steps}`.
  - For a device, `io` defaults to its sidechain, or its only audio input. For a track, `io` must be `input` or `output`.
  - `source` and `channel` match the names in Live's choosers: exact first (any case), then the one choice holding every word ("1 kick" finds "Drum Rack | 1 kick | Post FX"). More than one match is refused with the list.
  - It sets the source, gives Live a tick to refresh the channel list, then sets the channel. Each is one undo step.
- **`set_device_param` on plugins:** a plugin's `str_for_value` ignores the value it's given and returns the current display, so a text search ran off one end of the range. Now, when a knob shows the same text at its minimum and maximum, `text` is refused and the error says to use `percent` or `value`. For plugins (`class_name` contains "Plugin"), the action waits 4 ticks and re-reads `now`; if it still shows the old text, a `note` says so.
- **`load_device`** takes `replace_instrument: "<name>"` (used only by the audition): it hot-swaps the track's instrument for the item, but only if the instrument's name is exactly that. It sets `browser.hotswap_target` to the instrument, loads, waits for the old one to go, clears the target, and undoes the load if anything else on the track changed or Live added instead of replacing. Results now include `instrument`, the track's instrument name after the load.
- **Audition state** is in `~/SecondChair/audition.json` (`SECOND_CHAIR_STATE_DIR` moves it): the description, track, picks, position, the loaded instrument's name and the maybes. `keep` deletes it. If the user swapped the instrument by hand, the name no longer matches and the audition stops instead of replacing it.
- **Not checked in real Live yet:** whether a plugin's sidechain shows up in `audio_inputs`, the exact chooser names for Drum Rack chains, whether routing changes are undoable, and hot-swapping one instrument preset for another.

## Chord Coach link

- **Transport:** the device and the Remote Script talk OSC over UDP on 127.0.0.1 only.
  - Device → bridge on 9886: `/cc/note <pitch> <velocity>` for every note, and `/cc/hello` every 2 s.
  - Bridge → device on 9887: `/cc/show <label> <pitch>...` and `/cc/clear`.
- **No token on the UDP side:** it carries only note numbers and a label. MCP clients still go through the token on 9885.
- **Bridge actions:** `show_on_keys`, `clear_keys` and `get_played`. `ping` also reports whether Chord Coach was heard in the last 6 s.
- **Shared logic:** chord naming, symbols, voicing, ringing notes and the trail live in `mcp/chords.ts`, on top of Spur's code.
- **Behaviour** (from `vendor/spur/STRIP-NOTES.md`):
  - Released notes ring for 1.2 s, so an arpeggio reads as a chord.
  - Notes let go together (a block chord) stop ringing when the next note starts.
  - A chord joins the trail after 300 ms.
  - The last chord lingers for 8 s.
- **Octave:** the device follows the keyboard's octave buttons. A note above or below the drawn keys moves them by whole octaves, and the − and + buttons set the octave by hand. Right after an octave change, notes may sit an octave off until you play a key outside the old range, or tap − or +.
- **One device at a time:** only one Chord Coach can listen on 9887.
- **Building the device:** run `node chord-coach/build.ts`, then the installer with `--chord-coach`, after editing `chord-coach\chordcoach.js` or `chords.ts`. It writes the computed voicings and a chord-name table into the jsui (Max's jsui can't run TypeScript), rebuilds the `.amxd`, and copies both into the User Library. Then reload the device in Live.
- **New tools in an old session:** a session that loaded an older server can try them with `node test\try_tool.ts live_show_on_keys "{\"chord\":\"Dm7\"}"`.

## Second Chair Ears link (0.10.0)

- **Status:** checked in real Live on one PC. Its peak matched the peak Live shows on a sine, to 0.1 dB (see `ears/README.md`, "Checked in real Live").
- **Installing the device:** the installer with `--ears` copies it into the User Library (`Presets/Audio Effects/Max Audio Effect/Second Chair Ears`).
- **What:** an optional Max for Live audio effect (`ears/`) that measures the audio passing through it. `live_listen` reads its numbers: peak and RMS in dBFS, 8 coarse bands, and how old they are. See `ears/README.md`.
- **Transport:** device → bridge only, OSC over UDP on 127.0.0.1, port 9888: `/ears/levels <device id> <track|return|main> <index> <peak dB> <rms dB> <band dB> x 8`, about 4 times a second. No token, as with Chord Coach: it carries only numbers.
- **Bridge action:** `get_ears` (`track`, `seconds`). It refuses when no Ears device has reported in the last 3 s.
- **Many devices:** one per track is fine. Each reports under its own device id.
- **Where it measures:** at the device's place in the chain, before the track's fader.
- The fake has a stand-in Ears device, switched on and off with the fake-only action `fake_ears`.

## Test

```
python test\fake_live.py 120   # in one terminal
node test\mcp_client.ts       # in another, within 15 s (stops if it finds real Live, since it writes to the set)
node test\song_analyze.ts     # song_analyze on a made-up loop; needs no Live and no fake
```

- **While Live is open,** it holds port 9885. Set `SECOND_CHAIR_PORT=19885` in both terminals to run the fake on a spare port.
- The fake always uses spare UDP ports, so it never talks to the real Chord Coach.
- `mcp_client.ts` checks the browser, sound, pad-swap, plugin-knob, routing and audition tools and exits with 1 if any check fails. The fake has a stand-in VST3 (Kickstart 2, whose knobs only show their current setting a tick late, with a sidechain input), a Compressor with its own sidechain, and track routing. It reads Live's tags from `test/fixtures` (a tiny tag file in Live's format), not from the installed packs.

## Next steps

- **Steps 2 and 3:** done and verified in real Live on 2026-11-07. Dm7 lit on the device, a held C was named "C", and the octave follows the keyboard.
- **Step 4:** a skill holding the user's setup.
- **Step 5:** test HeyClicky's push-to-talk.

## Mute, solo and new scenes (0.9.9)

Asked for on 2026-11-14 by a music session that had to fall back to computer use for these.

- **`set_mute`** `{track, mute?, solo?}` (MCP: `live_mute_track`): a track's Mute and Solo buttons, on regular and return tracks. Main has neither. Solo set through the API doesn't unsolo other tracks, so the result lists `also_soloed`. Revertible.
- **`create_scene`** `{index?, count?}` (MCP: `live_create_scene`): adds 1 to 16 empty scenes, at the end by default. Returns the new scene numbers. Not revertible by `live_revert`; `live_undo` takes it back.
- **Fixed:** `live_audition` "next" and `live_swap_pad_sample` crashed with `NameError: name 's' is not defined` when Live did something unexpected with a load (it added a device where it should have replaced one). The undo was written with a name that didn't exist. They now undo the load and say what happened.
- **`delete_clip`** `{track, slot, name}` (MCP: `live_delete_clip`): deletes one Session clip. The user agreed to this on 2026-11-14, as a change to the "never deletes your clips" rule: only on the user's ask, the name must match, and a recording clip is refused. Not revertible by `live_revert`; `live_undo` brings it back.
- **Still open from the same session:** saving the set, exporting, and timeouts right after Live's Export dialog closes.
