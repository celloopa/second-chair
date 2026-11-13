# Set up the Music Studio assistant

**This file is for your AI agent.** Give it to an agent that can run commands on your computer (Claude Code, the Code tab of the Claude desktop app, or Codex) and say: *"Follow ONBOARDING.md and set this up with me."*

The agent looks at what's on your computer, installs the tools, walks you through the two clicks in Ableton Live, writes down your studio (gear, plugins, folders, how you like to be taught), and runs a first check with you.

---

## Agent: ground rules

Follow these as written.

- **Work in the phases below, in order.** At the end of each phase, tell the user in a few plain lines what you did and what you found, then go on. Stop and wait only where a phase says **Stop**.
- **Each phase can be picked up again.** If you're starting in a new chat, run the check in phase 1 and continue at the first phase that isn't done.
- **Ask before you change anything** outside this folder. The only things this setup changes are listed in the README ("What the installer does"). Show the dry run first.
- **Don't guess facts about the user.** Read them off the computer with the survey, or ask. Mark a guess as a guess.
- **Ask your questions together,** in one or two short rounds, not one at a time and not as a long form.
- **Never print, read out or paste the token** (`CelloBridge/token`). You never need to open it.
- **Don't install anything else** (Node, Git, plugins, packages) without the user's yes. Tell them what and why.
- **Plain, short sentences.** Don't rely on colour to make a point.
- **You can't click in Live.** The user does the steps in Live; you tell them where, one step at a time.

## Phase 0: get the folder

1. If you're already inside this repo, skip to phase 1.
2. Ask where it should live. It must be a folder that stays put, such as `Documents/music-studio` or `~/music-studio`, because the AI app starts the tools from it.
3. Clone it there: `git clone https://github.com/celloopa/music-studio-beta`. The repo is private, so this needs the user's GitHub sign-in (`gh auth login` if they have the GitHub CLI). If cloning fails, tell them how to download it as a ZIP from the repo page.

## Phase 1: look before you touch

Both commands change nothing.

1. Check Node: `node --version`. It must be 24 or newer. If it's missing or older, tell the user to install the LTS version from https://nodejs.org and open a new terminal. **Stop** until that's done.
2. Run the survey. Windows: `powershell -ExecutionPolicy Bypass -File install.ps1 --survey`. Mac: `sh install.sh --survey`.
   - It lists the system, Ableton Live's edition and versions, the User Library, the folders under Places in Live's browser, and every plugin Live has scanned.
   - It ends with what it can't read from files. Those are your questions for phase 4.
3. Run the check, the same command with `--check`. It ends with `READY` or `NOT READY` and a list of what's left.
4. Tell the user what you found, in a short list. If Live is older than 12.3, or isn't installed, say so and **stop**: the tools need Live 12.3 or newer.

Keep the survey's output. You need it in phase 4.

## Phase 2: install

1. Run the installer with `--dry-run` and show the user the lines that start with `[would]`.
2. **Stop.** Ask: "OK to install?" Mention that each settings file it edits gets a backup copy next to it.
3. On yes, run the installer with no options.
   - If it can't find Live's User Library, ask the user to open Live, go to Settings > Library, and read you the "Location of User Library". Run again with `--user-library "<that folder>"`.
   - If the user doesn't use one of the Claude apps, that part is skipped by itself. For Codex or another MCP app, use the one-line command in the README ("Add it to Claude by hand").
4. Read the installer's output. Deal with every line that starts with `[TO DO]`.

## Phase 3: the steps only the user can do

Give these one at a time, and wait for "done" after each.

**In Ableton Live**

1. Quit Live fully if it's open, then open it again. Live only loads the script when it starts.
2. Go to **Settings > Link, Tempo & MIDI**. Under **Control Surface**, pick **CelloBridge** in an empty row. Leave that row's Input and Output on **None**.
3. Look at the bar at the bottom of Live. It says "CelloBridge ... ready".

Then run the check again. Under "Inside Live" it should say Live is answering. If it doesn't, use the table in the README ("If something goes wrong").

**In the AI app**

The tools load when the app starts, so the user has to restart it once:

1. Tell the user: quit the app fully and open it again (on Windows, also quit it from the tray icon near the clock). Then start a new chat **in this folder** and say: *"Continue the Music Studio setup."*
2. Tell them this chat ends there, and that the new chat picks up from the check.
3. **Stop.**

In the new chat: run the check. If it says `READY`, and you can see tools whose names start with `live_`, go on to phase 4. If you can't see the tools, say so and use the README's fixes; don't work around it.

**On a Mac, one more**

"Look at my set" takes a picture of Live's window. The first time, macOS asks for **Screen Recording** permission for the AI app (System Settings > Privacy & Security > Screen Recording). Tell the user to allow it, then quit and reopen the app.

## Phase 4: the studio profile

The profile is one Markdown file on the user's computer, `CelloBridge/my-studio.md` in their home folder. The tools read it at the start of every session, so the assistant knows the user's name, gear and plugins without asking again.

1. Call `my_studio` with no arguments. If a profile is already there, show it and ask what to change. If not, it returns the outline to fill in.
2. Fill in what the survey already told you. Don't ask about these:
   - Live's edition and version, and the User Library
   - the sample folders under Places
   - the full plugin list
3. Ask the rest together, in one or two rounds. The survey's last section lists them: name, experience, how they like to be taught, what they want help with, whether to suggest musical ideas, controller, audio interface and inputs, instruments and mics, the plugins they use most, and anything about how they see or hear.
4. If no sample folders are under Places, ask where the samples are, and tell the user how to add the folder: drag it from Explorer or Finder into the left side of Live's browser, under Places. The tools can only load from folders that are there. You can't do this step for them.
5. With Live open, call `live_status` and add what you can see: the tracks' input names often name the audio interface. Mark anything you inferred as "(seen in Live, not confirmed)".
6. Write the profile in the outline's shape. Keep the `- **Name:** ...` line: the tools take the user's name from it. List the plugins in groups (instruments, effects, mixing and mastering), with a note on the ones the user said they use most.
7. **Stop.** Show the whole profile and ask: "Save this?" On yes, save it with `my_studio` (pass the whole text). Saving keeps the previous version next to it.

If the `my_studio` tool isn't available in your app, write the same text to `CelloBridge/my-studio.md` in the user's home folder, after the same "Save this?".

## Phase 5: permissions, so it isn't in the way

Explain these, and let the user choose:

- **Tool prompts.** The app asks before it first uses each tool. Tools that only read (`live_status`, `live_get_levels`, `live_get_track`, `live_get_device`, `my_studio`, `studio_guide`, `audio_analyze`, the `theory_` tools) are safe to "always allow". Tools that change the set are worth seeing each time at first.
- **Seeing Live.** `live_screenshot` captures Live's own windows only, never the rest of the screen.
- **Computer use** (the app clicking for the user) is optional and off unless they turn it on. `docs/needs-your-hands.md` says what it's for and its rules.
- **The skill** is optional: the tools carry the same guide. The installer made `dist/music-studio-skill.zip` for uploading in the Claude desktop app (Settings > Capabilities > Skills).

## Phase 6: first session

1. Ask the user to open a song they know well.
2. Call `live_status` and say what's in the set: tracks, returns, Main.
3. Read the guide once: the `music-studio` skill if your app loaded it, or the `studio_guide` tool.
4. Offer the first things to try from the README ("First things to try"), and let the user pick. Don't start changing the set on your own.
5. Tell them the three guides in `docs/`: what they can ask for, what needs their hands, and what's not proven yet.
6. Tell them how to report a problem: they say "report a problem with the Music Studio assistant", and you follow `CONTRIBUTING.md`. You show them the text before anything is posted.

## Done means

- The check ends with `READY`.
- `my_studio` returns a profile with the user's name in it.
- `live_status` returns the user's set.
- The user knows where the guides are and how to report a problem.

Say so in three lines, and stop.

## Later: updating

Get the new version (`git pull` in this folder), run the installer again, and read its last lines: it says whether Live needs a restart. The token and the studio profile are kept.
