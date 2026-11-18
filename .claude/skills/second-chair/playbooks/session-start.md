# Playbook: session start

Use at the start of a music session, after a gap (the user was away, Live was restarted), and whenever a tool answers "unknown action" or can't reach Live.

## Steps

0. **Read the user's studio profile** with `my_studio`, once per session. If there isn't one, it gives the questions to ask; ask them when there's a natural moment, not before the user's first request.
1. **Call `live_status`.** Read four things before any write:
   - `version_warning`: Live is running an older Remote Script than this server. New tools will answer "unknown action". Ask the user to **save (Ctrl+S), fully quit Live** (check it's gone from the taskbar; a Live that was already open when the bridge was installed keeps the old script) and open it again.
   - `set.warning` / `set.untitled`: Live opened an empty Untitled set, not the song. Ask the user to open it: File > Open Recent Set. Change nothing in an Untitled set (except in demo mode).
   - `set.unsaved`: fine, but offer `live_save` (or Ctrl+S) before a big change (a recording take, a delete).
   - `dialog.open`: Live is waiting on a message box. Tell the user what it says (`dialog.text`) and let them answer it in Live. Nothing presses its buttons. `dialog.log` lists the boxes Live logged since it started; the log doesn't say when one closed.
   - `session.tracks`: numbered from 0. Live's own numbers start at 1, so index 4 is "track 5" to the user. Use names when you talk to the user.
2. **Say what you see in one or two lines:** the set, the tempo, the key, and what you'll do first.
3. **If Live can't be reached:** tell the user in one line. Live must be open with SecondChair in Settings > Link, Tempo & MIDI > Control Surface. Machine-specific fixes are in the user's studio profile (`my_studio`).

## New tools after a bridge update

- A running chat keeps the tool list it started with. After an install, new tools need a **new chat**.
- Until then, call a new tool through `node live-bridge\test\try_tool.ts <tool> @args.json`. From PowerShell, put the JSON in a file (spaces in JSON break the command line). From bash, single quotes work.

## Rules that hold all session

- **Ask before changing the set,** unless the user asked for that change. After every change, say what changed, where (track name, bar), and how to undo it (`live_revert`, or `live_undo` straight away for the few that say so).
- **Check after every write.** Read the result (`now`, `devices`, `placed`, `read_back`). If it isn't what was asked, say so before going on.
- **One write at a time on one device.** Parallel calls on the same device can report a stale "was".
- **No computer use while the user is working in Live.** The view moves and clicks land in the wrong place. The bridge covers nearly everything; for the rest, teach the user the clicks.
- **Never by colour alone:** name the knob, give its position and its number.
- **Mentor, not ghostwriter:** set up, check, explain. Musical ideas only when the user asks for that one thing (or demo mode).
