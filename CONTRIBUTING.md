# Reporting problems and sending fixes

This is for beta users and their AI agents. **Agents: follow it as written.**

There are two ways to help:

- **Report a problem or an idea** as a GitHub issue. We fix it.
- **Send a fix** as a pull request. We review every one.

## First: show the user, then post

- Draft the issue or pull request, show the user the full text, and post it only after they say yes.
- Everyone with access to this repo can read what you post.

## Never include

- **The bridge token,** the contents of any `SecondChair/token` file, or any `Authorization` or `X-SecondChair-Token` value.
- **Personal details from the studio profile** (`~/SecondChair/my-studio.md`), unless the user says it's OK.
- **The user's audio or song files** (`.als`, `.wav` and so on), or folder paths that show private names, unless the user says it's OK.

## Report a problem

1. **Gather the facts:**
   - From `live_status`: `bridge`, `live`, `studio_profile`, and any `version_warning`. Leave out the track list unless it matters.
   - The repo version: `git -C <repo> log -1 --oneline`.
   - The OS and its version, the agent app, and the model.
   - What the user asked, in their own words.
   - The tool you called, its arguments, and the exact error or wrong result. Copy it; don't paraphrase.
   - What should have happened.
   - Whether it happens again, and the steps, on a new empty set if you can.
2. **Look for it first:** `gh issue list --repo celloopa/music-studio-beta --state all --search "<a few words>"`. If it's already there, add a comment with your facts instead of a new issue.
3. **Post it:** `gh issue create --repo celloopa/music-studio-beta --title "<tool>: <what goes wrong>" --body-file <file>`. Shape the body like `.github/ISSUE_TEMPLATE/problem.md`.
   - Without `gh`, give the user the title and body to paste at https://github.com/celloopa/music-studio-beta/issues/new.
4. **For an idea or a request,** start the title with `Idea:`. Say what the user was trying to do and what they reached for that wasn't there. Shape the body like `.github/ISSUE_TEMPLATE/idea.md`.

## Send a fix

Small, focused fixes are best: one problem per pull request.

1. **Get the code:**
   - Run `gh repo fork celloopa/music-studio-beta --clone`, then make a branch: `git switch -c fix/<short-name>`.
   - If the user already has write access, a branch on this repo is fine instead of a fork.
2. **Know where things are:**

   | What | Where |
   |---|---|
   | The script inside Live (Python, runs in Live's own Python) | `live-bridge/remote_script/SecondChair/__init__.py` |
   | The tool server (TypeScript, run directly by Node 24) | `live-bridge/mcp/server.ts` and the other files in `live-bridge/mcp/` |
   | A stand-in for Live, for tests | `live-bridge/test/fake_live.py` |
   | The end-to-end test client | `live-bridge/test/mcp_client.ts` |
   | Tool reference and change notes | `live-bridge/README.md` |
   | The guide and playbooks | `.claude/skills/second-chair/` |

3. **Keep these rules.** A pull request that breaks one won't be merged.
   - **No generated audio,** in any form.
   - **The Live script only runs actions from its fixed list.** It never runs code a client sends. It listens on 127.0.0.1 only and checks the token on every request.
   - **The tool server uses Node built-ins only,** with no npm packages. It talks only to this computer.
   - **Tools that change the set** record what they did, so `live_revert` can take it back. They never overwrite the user's clips.
   - **Live's API is touchy.** On return tracks and Main, some properties raise `RuntimeError`, not `AttributeError`, so `getattr(x, name, default)` won't protect you. Wrap risky reads the way `_safe()` does.
   - **Tool text is plain and short,** and never relies on colour alone.
   - **Don't change version numbers** (`VERSION` in the script and the server, and `NEEDS_BRIDGE`). The maintainers set them when they merge.
4. **Test it:**
   - Run the fake Live in one terminal: `python3 live-bridge/test/fake_live.py 120` (on Windows, `python`). The number is how many seconds it stays up. The full test takes about a minute.
   - Right away, run the test client in another: `node live-bridge/test/mcp_client.ts`. It must exit with code 0 and print no lines that start with `!!`.
   - If Live is open, set `SECOND_CHAIR_PORT=19885` in both terminals so the fake doesn't clash with it.
   - If the fake can show the bug, add a check for it to `mcp_client.ts` (and to `fake_live.py` if the stand-in needs to act more like real Live).
   - **If you changed the Live script and the user agrees,** also try it in real Live on a new empty set, then take it back with `live_revert`. A change to the script needs a full Live restart to load.
5. **Open the pull request:** `gh pr create --repo celloopa/music-studio-beta --base main`. Fill in `.github/pull_request_template.md`:
   - what was wrong, with `Fixes #<issue>` if there is one
   - what you changed
   - how you tested it: fake or real Live, OS, Live version
   - what you didn't check

## What happens next

- **Issues:** we read each one, may ask questions there, and say on the issue when a fix ships.
- **Pull requests:** we review each one, and may ask for changes or rework it before merging.
- **After a fix ships,** run the "Update" steps in `README.md`.
