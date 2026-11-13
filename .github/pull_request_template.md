<!-- See CONTRIBUTING.md. Never include the bridge token or private studio profile details. -->

## What was wrong

Fixes #

## What changed

## How it was tested

- [ ] Fake Live: `fake_live.py` + `mcp_client.ts`, every check passes
- [ ] Real Live (Live version: …, OS: …), on a new empty set, then `live_revert`
- [ ] Added a test check for this bug

## Not checked

## Rules kept

- [ ] No generated audio
- [ ] The Live script still only runs its fixed list of actions, on 127.0.0.1, with the token
- [ ] Node built-ins only, no npm packages
- [ ] Set changes can be taken back with `live_revert`
- [ ] Version numbers left for the maintainers
