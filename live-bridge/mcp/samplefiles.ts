// Finds an audio file for live_load_sample by name, in the user's sample folders.
// Live's Splice integration saves downloads to User Library\Samples\Splice; the user's own samples are in Documents\Samples.
// SECOND_CHAIR_SAMPLE_DIRS (folders split by ; on Windows or : on the Mac) replaces the list.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const AUDIO = /\.(wav|aif|aiff|flac|mp3|ogg|m4a)$/i;
const MAX_DEPTH = 5;
const MAX_ENTRIES = 30000;

export function sampleDirs(): string[] {
  const env = process.env.SECOND_CHAIR_SAMPLE_DIRS;
  if (env !== undefined) return env.split(path.delimiter).filter(Boolean);
  const music = path.join(os.homedir(), "Music", "Ableton");
  return [path.join(music, "User Library", "User Library", "Samples"), path.join(music, "User Library", "Samples"),
    path.join(os.homedir(), "Documents", "Samples")].filter((d) => fs.existsSync(d));
}

/** A full path stays as it is (it must exist). A name, or words from it ("vocal loop mind"), is looked up in the sample folders. */
export function findAudioFile(wanted: string): string {
  const w = wanted.trim();
  if (path.isAbsolute(w)) {
    if (!fs.existsSync(w)) throw new Error(`There's no file at ${w}.`);
    return w;
  }
  const words = w.toLowerCase().replace(/\.(wav|aif|aiff|flac|mp3|ogg|m4a)$/i, "").split(/[\s_\-/\\]+/).filter(Boolean);
  const exact: string[] = [], partial: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || seen > MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!AUDIO.test(e.name)) continue;
      const name = e.name.toLowerCase();
      if (name === w.toLowerCase() || name.replace(AUDIO, "") === w.toLowerCase()) exact.push(p);
      else if (words.length && words.every((x) => name.includes(x))) partial.push(p);
    }
  };
  const dirs = sampleDirs();
  for (const d of dirs) walk(d, 0);
  const hits = exact.length ? exact : partial;
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`No audio file matching "${w}" in ${dirs.join("; ") || "the sample folders"}. Give its full path.`);
  throw new Error(`More than one file matches "${w}": ${hits.slice(0, 8).map((h) => path.basename(h)).join(", ")}. Say which (more words, or the full path).`);
}
