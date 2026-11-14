# Playbook: sound design

Use for "find me a sound", "build a chain on the vocal", "make the 808 grittier", "add movement", loading devices and turning knobs.

## Loading

1. Pick the right tool:
   - A sound by description: `live_find_sound` (show the numbered shortlist), then `live_load_sound`, or `live_audition` to try them one by one on the keys.
   - A Live device: `live_load_device` with `name`. A plugin: add `tree: "plugins"`.
   - A sample to chop: `live_load_sample`.
2. **Check the result:** `devices` must show the new device **on the track you asked for**, at the end of the chain. If the bridge says it landed on another track and took it back off, try again once; if it happens again, ask the user not to click in Live for a moment.
3. Say where it went: "Saturator is now last on Vox Slices (track 7)."

## Turning knobs

1. **Read first:** `live_get_device` gives the exact knob names and current settings. Names change between versions (Utility's level knob is "Output" in Live 12.4, not "Gain").
2. **Set with text** in the knob's own units: `"-6 dB"`, `"35 %"`, `"1.2 kHz"`, `"1/4"`. For synced rates (LFO Synced, delay times), **always text**: their raw values run in odd orders.
3. **Plugins (VST/AU):** use `percent` or `value`. Their text only shows the current setting. The result re-reads `now` a moment later; check it.
4. **Inside racks:** name the path, `"808 Rack > Saturator"`. `live_get_device` on a rack lists its chains.
5. **Check `now`** in the result and say it: "Drive: 20 % → 40 %."
6. **Echo:** with Link on, the bridge only moves the side you set. Set L and R both.

## Building a chain (a starting order, not a rule)

Source → shape → movement → space → glue:
- **Shape:** EQ Eight (low cut first), Saturator or Amp for grit.
- **Movement:** Auto Filter, Auto Pan, Chorus, LFO.
- **Space:** Echo, Reverb (or sends to a shared return).
- **Glue:** Compressor or Glue Compressor; Utility last for level and width.

Explain each step in one line ("the low cut clears mud under the vocal"). Let the user A/B by switching the device off and on (its Device On button), and ask how it sounds: you can't hear it.

## Moving and deleting

- `live_move_device` with `before` / `after` ("move Amp after Auto Filter"). Revertible.
- `live_delete_device` only when the user asks, with the exact name. For something the bridge just loaded, `live_revert` instead.
