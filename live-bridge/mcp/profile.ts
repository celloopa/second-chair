// The user's studio profile ("my studio"): who they are, how they like to be taught, and what's in their studio.
// One Markdown file per user and machine, outside the repo, so the tools and the guide stay the same for everyone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const profilePath = () => process.env.SECOND_CHAIR_STUDIO_FILE || path.join(os.homedir(), "SecondChair", "my-studio.md");

export function readProfile(): string | null {
  try { const t = fs.readFileSync(profilePath(), "utf8").trim(); return t || null; } catch { return null; }
}

/** The name from a line like "- **Name:** Sam" or "Name: Sam". Letters, spaces, - and ' only, at most 30 characters. */
export function profileName(text = readProfile()): string | null {
  const m = text?.match(/^\s*(?:[-*]\s*)?\**\s*name\s*:?\**\s*:?\s*(.+)$/im);
  const name = m?.[1].replace(/[*_`]/g, "").trim();
  return name && /^[\p{L}][\p{L} '\-]{0,29}$/u.test(name) ? name : null;
}

/** Puts the user's name into text written for "the user". Without a profile name, the text stays as it is. */
export function personalize(text: string, name = profileName()): string {
  if (!name) return text;
  return text.replace(/\b[Tt]he user's\b/g, `${name}'s`).replace(/\b[Tt]he user\b/g, name);
}

export const QUESTIONS = `# My studio

- **Name:** (what should the assistant call you?)

## About me

- (How much do you know about producing, and about Ableton Live? Any other DAWs?)
- (How do you like to be taught: step by step, or just the answer? Anything to avoid?)
- (Anything about how you see or hear that the assistant should know, such as colour blindness?)
- (What do you mostly want help with: writing, sound design, recording, mixing, mastering?)
- (Should the assistant ever suggest musical ideas, or only when you ask?)

## Gear and folders

- **Controller or keyboard:** (model, and which MIDI port Live uses)
- **Audio interface and inputs:** (model; what's plugged into input 1, input 2)
- **Instruments and mics:**
- **Sample folders:** (full paths; each must also be under Places in Live's browser)
- **Plugins you use most:** (synths, effects, mastering)
- **Live:** (edition and version; where your projects are saved)

## Fixes that are about this machine

- (Anything that has gone wrong before and how you fixed it)
`;

// The plugin guide ("my plugins"): one line per plugin the user owns, saying what it is and what it's good for.
// It sits next to the profile in its own file, because it can be long and is only needed for plugin questions.
export const pluginsPath = () => process.env.SECOND_CHAIR_PLUGINS_FILE || path.join(path.dirname(profilePath()), "my-plugins.md");

export function readPlugins(): string | null {
  try { const t = fs.readFileSync(pluginsPath(), "utf8").trim(); return t || null; } catch { return null; }
}

export const PLUGIN_OUTLINE = `# My plugins

One line per plugin Live has scanned. "(unconfirmed)" means the assistant wrote the line from what it knows about
the plugin, and the user hasn't checked it yet.

## Instruments

- **Plugin name** (VST3): what it is, in one sentence. Good for: two or three jobs. (unconfirmed)

## Effects

- **Plugin name** (VST3): what it is. Good for: ... (unconfirmed)

## Mixing and mastering

- **Plugin name** (VST3): what it is. Good for: ... (unconfirmed)

## Not sure what these are

- Plugin name (VST3)
`;

/** The headings and lines of the plugin guide that hold any of the words, so a question about one job reads a few lines. */
export function findPlugins(text: string, words: string): string {
  const want = words.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  const out: string[] = [];
  let heading = "";
  for (const line of text.split("\n")) {
    if (/^#{1,6} /.test(line)) { heading = line; continue; }
    if (!line.trim() || !want.some((w) => line.toLowerCase().includes(w) || heading.toLowerCase().includes(w))) continue;
    if (heading && out[out.length - 1] !== heading && !out.includes(heading)) out.push("", heading, "");
    out.push(line);
  }
  return out.join("\n").trim();
}

export function writePlugins(text: string): string {
  const clean = String(text).replace(/\r\n/g, "\n").trim();
  if (clean.length < 20) throw new Error("That's too short to be a plugin guide.");
  if (clean.length > 150_000) throw new Error("A plugin guide is at most 150,000 characters.");
  const file = pluginsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file.replace(/\.md$/, "") + ".previous.md"); // one step back
  fs.writeFileSync(file, clean + "\n", "utf8");
  return file;
}

export function writeProfile(text: string): string {
  const clean = String(text).replace(/\r\n/g, "\n").trim();
  if (clean.length < 20) throw new Error("That's too short to be a studio profile.");
  if (clean.length > 40_000) throw new Error("A studio profile is at most 40,000 characters.");
  const file = profilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file.replace(/\.md$/, "") + ".previous.md"); // one step back
  fs.writeFileSync(file, clean + "\n", "utf8");
  return file;
}
