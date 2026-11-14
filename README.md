# Second Chair

**An MCP server for Ableton Live that teaches while you produce.**

Second Chair puts your AI agent inside your Live set. You ask in plain words. It reads the set, sets things up, checks your levels and loudness, writes automation, and explains each step so you can do it yourself next time.

In an orchestra, the second chair sits beside the lead player and backs them up. You lead.

**Private beta, version 0.9.8. Please don't share it yet.**

## What you can ask

With a song open in Live:

- "What's in my set?"
- "Play it and check my levels."
- "Look at the devices on my vocal track and explain what each one is doing."
- "Set up a reverb on a return track and send the vocals to it."
- "Find me a warm pad."
- "Fade the pad in from bar 9 to bar 17."
- "Take that back."

The full list, by job, is in [docs/what-you-can-do.md](docs/what-you-can-do.md).

## Where it stops

- **The ideas are yours.** It sets up, checks, explains and unsticks. It writes a chord, a bassline or a drum pattern only when you ask for that one thing.
- **It never makes sound with AI.** It can write MIDI notes into a clip when you ask, and you can edit every note.
- **It can't hear.** How something sounds is your call. For loudness and tone it measures a file you export.
- **Some jobs stay with you.** Live gives scripts no way to export a song, for one. The list is in [docs/needs-your-hands.md](docs/needs-your-hands.md).

## Install

Paste this to an agent that can run commands (Claude Code, the Code tab of the Claude app, or Codex):

> Set up Second Chair for me. Clone https://github.com/celloopa/music-studio-beta into a folder that can stay, then read ONBOARDING.md in it and follow it with me.

Your agent then does five things, and asks before it changes anything:

1. **Looks first.** A survey that changes nothing: your system, your Live edition and version, your User Library, the sample folders in Live's browser, and every plugin Live has scanned.
2. **Installs,** after showing you what it would change.
3. **Walks you through two clicks in Live** and one restart of your AI app.
4. **Writes your studio profile.** It fills in what the survey found and asks you the rest in one or two rounds: your name, your gear, how you like to be taught. You see the profile before it's saved.
5. **Runs a first check with you** in a song you know.

The restart in step 3 ends that chat. Start a new one in the same folder and say "Continue the Second Chair setup".

To install it yourself, see [By hand](#by-hand).

## What you need

- **Windows 10 or 11, or a Mac.**
- **Ableton Live 12.3 or newer** (Standard or Suite). It's built and tested on Live 12.4.16.
- **An AI agent that can use local tools (MCP).** The installer sets up **Claude** (the Claude desktop app and Claude Code). Codex and other MCP apps take one command by hand (see "Add it to Claude by hand"). A paid plan is a good idea, since tool use adds up.
- **Node 24 or newer**, from https://nodejs.org (the LTS button). The tools run on it. Nothing else gets installed: no packages, no background service.

## How it works

Two parts, and one installer for both:

| Part | What it is | Where it runs |
|---|---|---|
| **SecondChair**, the script | A small script that Live loads as a "Control Surface". It carries out a fixed list of actions. | Inside Live |
| **second-chair**, the tools | 60 tools your agent can call, plus a guide (a "skill") that teaches it how to help a producer. | Next to your agent, on your computer |

Your **studio profile** is one file, `SecondChair/my-studio.md` in your home folder. It holds your name, your gear, your plugins and how you like to be taught, so the agent knows your setup in every session. You can read and edit it yourself.

## The rules it works by

These are built into the tools and the guide:

1. **It asks before changing your set**, unless you asked for that change. It says what it changed.
2. **It never overwrites or deletes your clips.** It writes only into empty slots. Deleting a track or a device takes your clear request and a name check.
3. **It can take back its own changes** (`live_revert`), without touching edits you made in between.
4. **The ideas are yours.** The one exception is **demo mode**: say "demo mode" and it drives, to show a friend what's possible, in a new empty set.

## Safety and privacy

- **Everything runs on your computer.** The script in Live listens only on this computer (127.0.0.1, port 9885). Nothing on your network or the internet can reach it.
- **Every request needs the token,** a random password that Live and the tools share. Without it, the script refuses.
- **The script runs a fixed list of actions.** It never runs code that's sent to it.
- **These tools send nothing anywhere.** The only thing that leaves your computer is what your agent itself sees: tool results (track names, device settings, measurements) and screenshots of Live's window if you ask it to look. With Claude, that goes to Anthropic as part of your chat, like anything else you type there.
- **Screenshots show only Live's own windows**, never the rest of your screen.
- **Your audio never leaves your computer.** Loudness and timing are measured locally, and the agent only gets the numbers.

## The guides

| Read this | For |
|---|---|
| [ONBOARDING.md](ONBOARDING.md) | Your agent: the whole setup, from survey to your studio profile |
| [docs/what-you-can-do.md](docs/what-you-can-do.md) | Everything you can ask for up to 0.9.8, by job, with things to say |
| [docs/needs-your-hands.md](docs/needs-your-hands.md) | What the tools can't do: what you do by hand, and what Claude can do with computer use switched on |
| [docs/whats-next.md](docs/whats-next.md) | What's unproven, what could be patched in, and what's planned |
| [live-bridge/README.md](live-bridge/README.md) | The technical notes: every tool and how it works inside |

## By hand

1. **Put this folder somewhere it can stay**, like `Documents\second-chair` or `~/second-chair`. Your agent starts the tools from this folder, so don't move it afterwards. (If you do, run the installer again.)
2. **Open a terminal in this folder.**
   - Windows: open the folder in Explorer, right-click an empty spot, choose **Open in Terminal**.
   - Mac: open Terminal, type `cd `, drag the folder onto the window, press Return.
3. **Run the installer.**

   Windows:

   ```bash
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```

   Mac:

   ```bash
   sh install.sh
   ```

The installer prints each thing it did, with a word in front: `[done]`, `[ok]`, `[skip]` or `[TO DO]`. It's safe to run again. It ends with three steps for you, which are also below.

### What the installer does

It touches four places and nothing else:

1. **Live's User Library.** It copies the script into `Remote Scripts/SecondChair`. It finds your User Library from Live's own settings, so a moved library works. If it can't find it, it tells you how to point at it (`--user-library "<folder>"`).
2. **A folder called `SecondChair` in your home folder.** It makes the token there. The token is never shown or sent anywhere.
3. **Claude's settings.** It adds one entry, `second-chair`, to Claude Code (`~/.claude.json`) and to the Claude desktop app (`claude_desktop_config.json`), whichever you have. It saves a copy of each file next to it first.
4. **The skill.** It copies the guide to `~/.claude/skills/second-chair` for Claude Code, and makes `dist/second-chair-skill.zip` for the desktop app's chat.

To see what it would do without changing anything, add `--dry-run`.

**Coming from an earlier beta** (the parts were called CelloBridge and cello-live)? Run the installer. It moves your token and studio profile to the `SecondChair` folder and takes the old parts out. Then pick **SecondChair** in Live's Control Surface row, as in step A.

### After the installer: three steps

**A. In Live**

1. Quit Live fully if it's open, and open it again. Live only reads the script when it starts.
2. Go to **Settings > Link, Tempo & MIDI**. Under **Control Surface**, pick **SecondChair** in an empty row. Leave its Input and Output on **None**.
3. The bar at the bottom of Live says **"SecondChair 0.9.8 ready"**.

**B. In Claude**

Quit Claude fully and open it again. On Windows, also quit it from the tray icon near the clock.

| Where you use Claude | The tools (MCP) | The skill |
|---|---|---|
| **Claude Code** (terminal), or the **Code tab** of the desktop app | Loaded by themselves. Type `/mcp` to see `second-chair` listed. | Loaded by itself, as `second-chair`. |
| **The desktop app's chat** | Listed as `second-chair` under the tools button by the message box, and in Settings > Developer. Claude asks before it first uses each tool: choose "Always allow" for the ones you're happy with. | Optional. Upload `dist/second-chair-skill.zip` under Settings > Capabilities > Skills. |

Menu names in the Claude app change now and then, so they may differ a little from these.

**The skill is optional.** The tools carry the same guide (a tool called `studio_guide`), and Claude is told to read it. With the skill, Claude has the guide from the first message.

**C. Say hello**

Open a song in Live and ask Claude:

> Check my Live connection and tell me what's in my set.

If your agent followed ONBOARDING.md, your studio profile is already written. If not, Claude asks you a few questions the first time: your name, how you like to be taught, your gear, your sample folders and plugins. It saves the answers in `SecondChair/my-studio.md` in your home folder.

### Check the setup

This changes nothing. It says what's set up and what's missing, in plain lines:

```bash
powershell -ExecutionPolicy Bypass -File install.ps1 --check
```

```bash
sh install.sh --check
```

It ends with `READY` or `NOT READY`.

### See what's on your computer

This also changes nothing. With `--survey` in place of `--check`, the installer lists your system, your Live edition and versions, your User Library, the folders under Places in Live's browser, and the plugins Live has scanned. Your agent uses it to fill in your studio profile. It reads folder and plugin names from Live's own settings files, never the token, a song or any audio.

### Add it to Claude by hand

Only if the installer couldn't. Replace `<folder>` with the full path of this folder.

Claude Code:

```bash
claude mcp add --scope user second-chair -- node "<folder>/live-bridge/mcp/server.ts"
```

Codex (the installer leaves Codex alone, and we haven't tested it yet):

```bash
codex mcp add second-chair -- node "<folder>/live-bridge/mcp/server.ts"
```

Any other MCP app: the command is `node` and its one argument is the full path of `live-bridge/mcp/server.ts`.

The Claude desktop app: Settings > Developer > Edit Config, then add this inside the file. If the file already has `"mcpServers"`, add only the `"second-chair"` part to it. On Windows, write each `\` in the path as `\\`.

```json
{
  "mcpServers": {
    "second-chair": {
      "command": "node",
      "args": ["<folder>/live-bridge/mcp/server.ts"]
    }
  }
}
```

### Update

Get the new version of this folder (`git pull`, or replace the folder's contents), run the installer again, and restart Live and Claude. If only the tools changed and the script in Live stayed the same, Claude tells you Live can stay open. Your token and studio profile are kept.

### Uninstall

```bash
powershell -ExecutionPolicy Bypass -File install.ps1 --uninstall
```

```bash
sh install.sh --uninstall
```

It removes the script, the token, the skill and the `second-chair` entries. It keeps your studio profile. Then set the SecondChair row in Live's Control Surface list back to None.

## First things to try

For mixing and mastering, with a song you know well:

1. **"What's in my set?"** Claude lists your tracks, returns and Main.
2. **"Play it and check my levels."** Each track and Main comes back as a word (low, healthy, hot) and a rough dB. No colours.
3. **"Look at the devices on my vocal track and explain what each one is doing."**
4. **"Set up a reverb on a return track and send the vocals to it."** Ask it to explain each step.
5. **"Take that back."** It undoes only its own changes.
6. Export your song as a WAV, then: **"Measure this file and compare it to this reference track"** (give both file paths).

There's much more in [docs/what-you-can-do.md](docs/what-you-can-do.md).

## If something goes wrong

Run the check first (above). Then:

| What you see | What to do |
|---|---|
| SecondChair is missing from Live's Control Surface list | Live was open during the install, or the script went to a different User Library. Quit Live fully and reopen. Check Settings > Library for the User Library's location, and run the installer with `--user-library "<that folder>"`. |
| Claude says it can't reach Live | Is Live open? Is SecondChair picked in a Control Surface row? The bar at the bottom of Live should have said "SecondChair 0.9.8 ready". |
| Claude says "unknown action" or warns about versions | Live is still running an older script. Quit Live fully and open it again. |
| Claude says "unauthorized" or the token is missing | Run the installer again, then restart Live. |
| Claude has no `second-chair` tools | Quit Claude fully (tray icon too on Windows) and reopen. Run the check. If needed, add it by hand (above). |
| A new tool is missing after an update | Start a new chat. A chat keeps the tool list it started with. |
| "Node isn't installed" or "too old" | Install Node 24 from https://nodejs.org and open a **new** terminal window. |
| Live hangs when it starts (rare) | A MIDI controller's port can do this. Unplug the controller, open Live, plug it back in. |
| On a Mac, "look at my set" fails | Give the Claude app Screen Recording permission: System Settings > Privacy & Security > Screen Recording. |

## Found a problem, or want something?

Let your agent report it. Paste this:

> Report a problem with Second Chair: <what happened>. Follow CONTRIBUTING.md in the repo.

Your agent shows you the text before it posts anything. It helps to include the output of the check, what you asked, and what it answered. The token never goes in a report.

## Left out of this beta

- **Voice control.** A voice front end is planned and comes later. For now you type to your agent.
- **Chord Coach**, a Max for Live device that shows chords on a keyboard. It needs Max for Live and is only installed when you add `--chord-coach`. Two tools (`live_show_on_keys`, `live_what_am_i_playing`) only work with it.
- **Other AI apps, proven.** It's built and tested with Claude. The tools speak MCP, so Codex and other MCP apps should work, but we haven't tested any for this beta.

Second Chair is an independent project. Ableton doesn't make or endorse it.
