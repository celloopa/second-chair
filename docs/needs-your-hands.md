# What the tools can't do: your hands, or computer use

The tools work through the door Ableton gives to scripts. Some parts of Live aren't behind that door at all. For those there are two ways:

1. **You do it by hand.** Claude tells you where to click and what to set, one step at a time. This is the normal way, and it's how you learn it.
2. **Claude does it with computer use.** Claude takes screenshots and moves your mouse and keyboard, like a person sitting at your computer.

This page lists what falls in that gap, and how computer use works.

## Seeing is not the same as computer use

"Look at my set" (`live_screenshot`) is part of these tools. It only takes a picture of Live's window. It doesn't click anything and doesn't need computer use. So Claude can always *see* a plugin window or a dialog and tell you what to press, even when it can't press it.

## Computer use: what it is and how to switch it on

- **What it is:** a feature of the Claude desktop app. With it, Claude can click, type and scroll in apps you allow. It's separate from this project.
- **Switching it on:** in the Claude desktop app's settings, turn on computer use. This is a guess at the exact place, because the app changes: look under Settings for "Computer use" or under Capabilities. The first time Claude wants to use an app, it asks you to allow that app (allow **Ableton Live**). On a Mac, the system also asks for Accessibility and Screen Recording permission for Claude.
- **If your Claude app doesn't have it,** everything on this page is simply "by hand".

### Rules for using it in Live

- **Hands off while it works.** It uses your real mouse and keyboard. If you move the mouse at the same time, clicks land in the wrong place.
- **Don't use it while you're working in Live.** Ask for it, take your hands off, and wait until Claude says it's done.
- **It's slow.** Each click needs a screenshot first. A job that takes you five seconds can take it a minute.
- **It can miss.** Live's controls are small. Claude should check with a screenshot after each step, and you should watch.
- **Save first.** Computer use isn't covered by "take that back". Only Live's own undo applies.
- **Say when.** The guide tells Claude to use computer use only when you say so. If it offers, you can always answer "I'll do it by hand, tell me how".

## The list

"Tools" means the second-chair tools. A guess is marked as a guess.

### Files and the set itself

| Job | Tools | By hand | Computer use |
|---|---|---|---|
| Save, Save As, Collect All and Save | No | Ctrl+S / Cmd+S | Yes |
| Open another set, or make a new one | No | File menu | Yes |
| **Export audio** (your bounce for mastering) | No | File > Export Audio/Video. Claude can tell you the settings. | Yes, but the export dialog has many small controls: check its settings in a screenshot before it runs |
| Freeze and Flatten a track | No. `live_bounce_track` prints a track to audio instead. | Right-click the track | Yes |

### Mixing

| Job | Tools | By hand | Computer use |
|---|---|---|---|
| Mute and Solo | No (Claude can see them) | Click the track's buttons | Yes |
| Group tracks (Ctrl+G / Cmd+G) | No. A bus track built from routing does the same for the sound. | Select tracks, Ctrl+G | Yes |
| **A plugin's sidechain input** (VST or AU, like Kickstart 2 or a third-party compressor) | No. Live's own Compressor, Gate and Auto Filter work with the tools. | The "Sidechain" chooser in the plugin's device box in Live | Yes |
| Track delay | No | The track's delay field (show it with the "D" button at the bottom right of the mixer) | Yes |
| Crossfader and cue volume | No | By hand | Yes |

### Inside a plugin's own window

| Job | Tools | By hand | Computer use |
|---|---|---|---|
| Any button or menu in a plugin window: presets, pages, meters | No | In the plugin | Yes, but plugin windows vary a lot, so it's the least reliable use |
| **iZotope Ozone's Master Assistant** and module choices | No. Knobs that Live shows in the device box can be set by percent. | In Ozone | Yes, with care |
| **Melodyne**: Transfer, and editing notes | No. `live_play_bars` plays the bars for the Transfer. | Press Transfer, edit the blobs | Transfer: yes. Note editing: not sensibly; that's a job for your ears and hands |
| Making more plugin knobs visible to Live | No | **Configure** on the device, then touch the knob in the plugin | Yes |

### The Arrangement

| Job | Tools | By hand | Computer use |
|---|---|---|---|
| Drawing, moving or deleting single automation points | No. The tools *record* ramps, curves and wobbles over a range of bars. | In the automation lane | Yes, roughly; fine drawing is hard for it |
| Clearing automation from a lane | No | Right-click the knob > Delete Automation | Yes |
| The per-clip modulation envelopes | No | In the clip's Envelopes tab | Yes |
| Fades and crossfades on audio clips | No | Drag the fade handles | Yes, roughly |
| Split, trim, consolidate, reverse, crop | No. Whole clips can be placed, moved and deleted. | Ctrl+E, Ctrl+J and the clip edges | Yes |
| Take lanes and comping | No | In the take lanes | Yes, roughly |
| Locators and time-signature changes | No (see what's next) | In the scrub area | Yes |
| The loop brace and punch points, as a setting of their own | Only as part of playing or bouncing a range | Drag the brace | Yes |

### Notes and clips

| Job | Tools | By hand | Computer use |
|---|---|---|---|
| Deleting or rewriting notes already in a clip | No. The tools only add notes, by design. | In the piano roll | Yes |
| Quantize, velocity edits, Live's MIDI Tools | No | In the clip view | Yes |
| Deleting a Session clip | No, by design | Select it, Delete | Yes |
| Clip gain, clip colour, clip rename | No (see what's next) | In the clip view | Yes |

### Devices

| Job | Tools | By hand | Computer use |
|---|---|---|---|
| Mapping macros, and MIDI or key mapping | No | Map mode | Yes |
| Saving a preset or a rack to your library | No | The device's save button | Yes |
| Hot-swapping a preset inside a device | No. A new sound can be loaded onto an empty track. | The device's swap button | Yes |
| Grouping devices into a rack | No | Ctrl+G on the devices | Yes |

### Live's settings

| Job | Tools | By hand | Computer use |
|---|---|---|---|
| Audio device, buffer size, sample rate | No | Settings > Audio | Possible, but do this one yourself: a wrong click here can cut your sound |
| Control Surface rows, MIDI ports | No | Settings > Link, Tempo & MIDI | Same: do it yourself |
| Adding a folder to Places | No | Drag the folder into the browser | Yes |

## What never needs either

So this list doesn't mislead: reading the set, levels, knobs on Live's devices and visible plugin knobs, loading devices and sounds, routing and Compressor sidechains, return tracks and buses, recorded automation, placing clips on the timeline, bouncing a track, and measuring a bounce all work through the tools alone. See [what-you-can-do.md](what-you-can-do.md).
