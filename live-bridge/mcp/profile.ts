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
