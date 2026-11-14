# Second Chair

Tools that let an AI agent help inside **Ableton Live 12** while the producer makes the music. This file is for agents working **in this repo**. A new user's agent starts with `ONBOARDING.md`.

The user's own facts (name, gear, folders, how they like to be taught) are **not in this repo**. They live in the studio profile, `~/SecondChair/my-studio.md`, which the `my_studio` tool reads and saves. Personal instructions for this checkout go in `CLAUDE.local.md`, which Git ignores.

## What's here

| Path | What |
|---|---|
| `ONBOARDING.md` | The setup an agent follows for a new user: survey, install, Live steps, studio profile, first session. |
| `README.md`, `docs/` | For the user: what it is, install, what you can ask for, what needs your hands, what's next. |
| `install.mjs` | The installer (`install.ps1` and `install.sh` run it). Modes: install, `--check`, `--survey`, `--dry-run`, `--uninstall`. |
| `live-bridge/` | **SecondChair**, a Live Remote Script on 127.0.0.1:9885 that needs a token. **second-chair**, an MCP server (Node 24, no dependencies). Read `live-bridge/README.md`. |
| `.claude/skills/second-chair/` | The guide and playbooks. The `studio_guide` tool serves the same text to other apps. |
| `chord-coach/` | An optional Max for Live device. Not part of the beta install. |
| `mac/` | An older Mac-only install script and a probe. The top-level installer replaces it. |
| `CONTRIBUTING.md`, `.github/` | How a user's agent reports a problem or sends a fix. |

## Working in Live through the bridge

- Call `live_status` first. Tracks, slots and scenes are numbered from 0.
- Writes only go into empty slots on MIDI tracks. `live_revert` takes back the tools' own changes.
- **Ask before changing the user's set** unless they asked for that change. Say what you changed.
- The ideas are the user's. Set up, check, explain and unstick; write music only when asked for that one thing.
- You can't hear the audio. Mark guesses as guesses.

## Working on the code

- Changing the Remote Script's code needs a **full Live restart**. Switching the Control Surface dropdown doesn't reload code.
- Test without Live: run `python live-bridge/test/fake_live.py 120`, then `node live-bridge/test/mcp_client.ts` (about a minute; it must exit 0). If Live is open, set `SECOND_CHAIR_PORT=19885` for both.
- Test the installer with `SECOND_CHAIR_INSTALL_HOME=<an empty folder>`, a pretend home folder.
- The rules a change must keep are in `CONTRIBUTING.md` ("Keep these rules").
- Never print or commit the token. Never put a user's own details in the repo.

## Style

- Plain, short sentences. Labels and order must carry meaning, never colour alone.
- Commit or push only when the user asks.
