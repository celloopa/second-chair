// Picks sounds from Live's browser by a plain description ("a warm pad", "a dusty Rhodes", "a punchy 808 bass").
// The bridge only lists item paths (list_tree). This file ranks them, using three things Live gives us:
//  1. the item's name ("E-Piano Rusty.adg"),
//  2. its folder in the browser (Sounds > Piano & Keys),
//  3. Live's own tags ("Lofi & Vinyl", "Electric Piano"), read from the packs' XMP files on disk, because Live's
//     Python API doesn't expose tags.
// Pure functions plus a file reader; no Live needed, so it can be tested on its own.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------- words -> what to look for ----------

type Concept = {
  /** What the user said, as matched (e.g. "rhodes"). */
  said: string;
  /** "sound" = what kind of instrument; "character" = how it sounds; "word" = an unknown word, matched on names only. */
  kind: "sound" | "character" | "word";
  /** Browser folders that hold this kind of sound (any folder in the path, any case). */
  folders: string[];
  /** Live tags (the last part of "Sounds|Piano & Keys|Electric Piano" or "Character|Punchy"). */
  tags: string[];
  /** Name words that suggest it. A word of 4+ letters also matches the start of a longer word ("dust" -> "Dusty"). */
  names: string[];
  /** The folders also hold other kinds of sound (Piano & Keys holds organs and Rhodes), so a folder alone counts less. */
  loose: boolean;
};

type Entry = { words: string[]; kind: "sound" | "character"; folders?: string[]; tags?: string[]; names?: string[]; loose?: boolean };

// What a beginner might say -> Live's folders, tags and naming. Words are lower case; phrases may have spaces.
const VOCAB: Entry[] = [
  // --- kinds of sound ---
  { words: ["pad", "pads"], kind: "sound", folders: ["Pad"], tags: ["Pad"], names: ["pad"] },
  { words: ["rhodes", "electric piano", "e piano", "epiano", "ep", "wurli", "wurlitzer", "wurly", "suitcase", "tines"], kind: "sound",
    folders: ["Piano & Keys"], tags: ["Electric Piano"], names: ["rhodes", "rhodish", "roads", "e piano", "electric piano", "suitcase", "wurli", "wurly", "tines", "mki", "mkii"], loose: true },
  { words: ["piano", "grand", "upright"], kind: "sound", folders: ["Piano & Keys"], tags: ["Piano"], names: ["piano", "grand", "upright"], loose: true },
  { words: ["keys"], kind: "sound", folders: ["Piano & Keys", "Synth Keys"], tags: ["Piano & Keys", "Synth Keys", "Electric Piano", "Piano"], names: ["keys", "piano"] },
  { words: ["organ", "hammond", "drawbar", "drawbars"], kind: "sound", folders: ["Piano & Keys"], tags: ["Organ"], names: ["organ", "drawbar", "drawbs", "tonewheel"], loose: true },
  { words: ["clav", "clavinet"], kind: "sound", folders: ["Piano & Keys"], tags: ["Clav"], names: ["clav"], loose: true },
  { words: ["808", "808s"], kind: "sound", folders: ["Bass"], tags: ["808 Bass"], names: ["808"], loose: true },
  { words: ["bass", "bassline"], kind: "sound", folders: ["Bass"], tags: ["Bass", "Synth Bass", "808 Bass", "Electric Bass", "Upright Bass"], names: ["bass"] },
  { words: ["lead", "leads"], kind: "sound", folders: ["Synth Lead"], tags: ["Lead"], names: ["lead"] },
  { words: ["pluck", "plucks", "plucked", "plucky"], kind: "sound", folders: ["Guitar & Plucked"], tags: ["Synth Plucked", "Misc Plucked"], names: ["pluck"] },
  { words: ["guitar", "guitars"], kind: "sound", folders: ["Guitar & Plucked"], tags: ["Electric Guitar", "Acoustic Guitar", "Classical Guitar"], names: ["guitar", "gtr"] },
  { words: ["harp"], kind: "sound", folders: ["Guitar & Plucked"], tags: ["Harp"], names: ["harp"], loose: true },
  { words: ["strings", "string", "violin", "cello", "orchestra", "orchestral"], kind: "sound", folders: ["Strings"],
    tags: ["String Ensemble", "Synth Strings", "Misc Strings", "Violin", "Cello"], names: ["string", "violin", "cello", "orchestra"] },
  { words: ["brass", "horn", "horns", "trumpet", "trombone"], kind: "sound", folders: ["Brass"], tags: ["Brass Ensemble", "Synth Brass", "French Horn", "Misc Brass"], names: ["brass", "horn", "trumpet"] },
  { words: ["choir", "voice", "voices", "vocal", "vocals", "vox"], kind: "sound", folders: ["Voices"],
    tags: ["Choir", "Solo Voice", "Synth Voice", "Vocal FX"], names: ["choir", "vox", "vocal", "voice", "ooh", "aah"] },
  { words: ["bell", "bells", "mallet", "mallets", "marimba", "vibes", "vibraphone", "glockenspiel", "glock", "xylophone"], kind: "sound", folders: ["Mallets"],
    tags: ["Bell Chromatic", "Synth Mallets", "Marimba", "Vibraphone", "Glockenspiel", "Xylophone", "Misc Mallets"], names: ["bell", "mallet", "marimba", "vibe", "glock", "xylo", "kalimba"] },
  { words: ["flute", "flutes", "sax", "saxophone", "woodwind", "woodwinds", "wind", "winds"], kind: "sound", folders: ["Winds"],
    tags: ["Flute", "Sax", "Misc Woodwind", "Synth Woodwind", "Woodwind Ensemble"], names: ["flute", "sax", "wind", "clarinet", "oboe"] },
  { words: ["arp", "arpeggio", "arpeggiated", "sequence", "sequenced"], kind: "sound", folders: ["Synth Rhythmic"], tags: ["Arpeggiated", "Rhythmic"], names: ["arp", "seq", "sequence"] },
  { words: ["drone", "drones", "texture", "textures", "atmosphere", "atmospheric", "ambient", "soundscape"], kind: "sound", folders: ["Ambient & Evolving"],
    tags: ["Atmosphere", "Textural", "Evolving"], names: ["drone", "ambient", "atmos", "texture", "scape"] },
  { words: ["fx", "effect", "riser", "risers", "sweep", "whoosh", "noise"], kind: "sound", folders: ["Effects"], tags: ["Sound FX"], names: ["riser", "sweep", "fx", "noise", "whoosh"] },
  { words: ["synth", "synths"], kind: "sound", folders: ["Synth Keys", "Synth Lead", "Synth Misc", "Synth Rhythmic"], tags: ["Synthetic", "Synth Keys"], names: ["synth"], loose: true },
  { words: ["chord", "chords", "stab", "stabs"], kind: "sound", folders: [], tags: ["Chord", "Stab"], names: ["chord", "stab"] },

  // --- how it sounds ---
  { words: ["warm", "warmer", "cozy"], kind: "character", tags: ["Analog", "Soft"], names: ["warm", "mellow", "soft", "analog", "smooth", "lush", "velvet", "round", "tube", "cozy"] },
  { words: ["dusty", "dust", "lofi", "lo fi", "vintage", "old", "retro", "vinyl", "tape", "worn", "crusty", "cassette", "nostalgic"], kind: "character",
    tags: ["Lofi & Vinyl"], names: ["dust", "lofi", "lo fi", "vinyl", "tape", "old", "vintage", "rusty", "dirty", "worn", "retro", "cassette", "crackle", "rcrd", "record"] },
  { words: ["punchy", "punch", "hard", "tight", "knocking", "hitting"], kind: "character", tags: ["Punchy", "Snappy"], names: ["punch", "hard", "tight", "knock", "hit"] },
  { words: ["bright", "shiny", "crisp", "sparkly", "glassy"], kind: "character", tags: ["Bright"], names: ["bright", "shine", "shiny", "crisp", "glass", "sparkl"] },
  { words: ["dark", "deep", "moody", "murky", "brooding"], kind: "character", tags: ["Dark"], names: ["dark", "deep", "moody", "night", "murk", "shadow"] },
  { words: ["soft", "gentle", "mellow", "smooth", "calm"], kind: "character", tags: ["Soft"], names: ["soft", "mellow", "gentle", "smooth", "calm"] },
  { words: ["evolving", "moving", "morphing", "changing", "swelling"], kind: "character", tags: ["Evolving", "Modulated"], names: ["evolv", "moving", "motion", "morph", "swell"] },
  { words: ["distorted", "gritty", "dirty", "grungy", "aggressive", "fuzzy", "crunchy", "angry", "nasty"], kind: "character", tags: ["Distorted"],
    names: ["dist", "grit", "dirty", "fuzz", "crunch", "angry", "rough", "grung", "drive", "nasty"] },
  { words: ["analog", "analogue"], kind: "character", tags: ["Analog"], names: ["analog"] },
  { words: ["digital", "fm"], kind: "character", tags: ["Digital"], names: ["digital", "fm", "digi"] },
  { words: ["big", "wide", "huge", "spacious", "airy", "dreamy", "floating", "lush"], kind: "character", tags: ["Spacious", "Cinematic"],
    names: ["wide", "big", "space", "air", "dream", "huge", "float", "lush"] },
  { words: ["cinematic", "epic", "film", "movie"], kind: "character", tags: ["Cinematic"], names: ["cinema", "movie", "epic", "film"] },
  { words: ["acoustic", "natural", "real"], kind: "character", tags: ["Acoustic"], names: ["acoustic", "natural"] },
  { words: ["simple", "basic", "clean", "pure", "plain"], kind: "character", tags: ["Basic"], names: ["basic", "clean", "simple", "pure"] },
  { words: ["detuned", "wobbly", "warbly", "wonky"], kind: "character", tags: [], names: ["detune", "wobbl", "warbl", "wonk"] },
  { words: ["short", "staccato", "percussive"], kind: "character", tags: ["Percussive", "Stab"], names: ["short", "stab", "perc"] },
  { words: ["sub", "subby", "low end"], kind: "character", tags: ["Sub"], names: ["sub"] },
];

const STOP = new Set(("a an the some sound sounds preset presets patch instrument like with that for me please kind of something really very bit " +
  "little give find get load want need and or to in on my one can you i would nice good kinda sort type style ish").split(" "));

/** Lower case, letters and digits only, single spaces. "E-Piano Rhodish.adg" -> "e piano rhodish adg". */
const norm = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
/** An item's name without its file extension. */
export const displayName = (p: string) => (p.split("/").pop() ?? p).replace(/\.(adg|adv|amxd|aupreset|fxp|vstpreset|wav|aif|aiff|flac|mp3)$/i, "").trim();

/** Turns a description into concepts. Two-word phrases ("electric piano", "lo fi") are matched before single words. */
export function understand(description: string): Concept[] {
  const words = norm(description).split(" ").filter(Boolean);
  const byWord = new Map<string, Entry>();
  for (const e of VOCAB) for (const w of e.words) byWord.set(w, e);
  const out: Concept[] = [];
  const seen = new Set<Entry>();
  for (let i = 0; i < words.length; i++) {
    const two = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : "";
    let said = "", e: Entry | undefined;
    if (two && byWord.has(two)) { said = two; e = byWord.get(two); i++; }
    else if (byWord.has(words[i])) { said = words[i]; e = byWord.get(words[i]); }
    else if (words[i].endsWith("s") && byWord.has(words[i].slice(0, -1))) { said = words[i]; e = byWord.get(words[i].slice(0, -1)); }
    if (e) {
      if (seen.has(e)) continue;
      seen.add(e);
      out.push({ said, kind: e.kind, folders: e.folders ?? [], tags: e.tags ?? [], names: [...new Set([said, ...(e.names ?? [])])], loose: !!e.loose });
    } else if (!STOP.has(words[i]) && words[i].length > 1) {
      out.push({ said: words[i], kind: "word", folders: [], tags: [], names: [words[i]], loose: false });
    }
  }
  return out;
}

// ---------- Live's tags, from the XMP files in each pack's "Ableton Folder Info" folder ----------

export type TagIndex = { files: number; byName: Map<string, { dir: string; tags: string[] }[]> };

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");

/** Reads one XMP file's items: file path -> tags. Keeps Sounds and Character tags (their last part) and MPE. */
export function parseXmp(text: string, into: TagIndex) {
  const chunks = text.split("<ablFR:filePath>");
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    const end = c.indexOf("</ablFR:filePath>");
    if (end < 0) continue;
    const file = unxml(c.slice(0, end));
    const kwEnd = c.indexOf("</ablFR:keywords>");
    const kw = kwEnd < 0 ? "" : c.slice(end, kwEnd);
    const tags = new Set<string>();
    for (const m of kw.matchAll(/<rdf:li>([^<]*)<\/rdf:li>/g)) {
      const parts = unxml(m[1]).split("|");
      if (parts[0] === "Sounds" || parts[0] === "Character") for (const p of parts.slice(1)) tags.add(p);
      else if (parts[0] === "Type" && parts[1] === "MPE Enabled") tags.add("MPE");
    }
    if (!tags.size) continue;
    const base = (file.split("/").pop() ?? file).toLowerCase();
    const list = into.byName.get(base) ?? [];
    list.push({ dir: file.toLowerCase(), tags: [...tags] });
    into.byName.set(base, list);
  }
}

/** Folders that may hold "Ableton Folder Info/*.xmp": Live's Core Library, each Factory Pack, the User Library.
 *  SECOND_CHAIR_ABLETON_LIBRARIES (folders split by ; on Windows or : on Mac) replaces the guesses. */
export function tagFolders(): string[] {
  const env = process.env.SECOND_CHAIR_ABLETON_LIBRARIES;
  if (env !== undefined) return env.split(path.delimiter).filter(Boolean);
  const out: string[] = [];
  const list = (d: string) => { try { return fs.readdirSync(d); } catch { return []; } };
  const music = path.join(os.homedir(), "Music", "Ableton");
  // Windows: C:\ProgramData\Ableton\Live 12 Suite\Resources\Core Library
  const pd = process.env.ProgramData || "C:\\ProgramData";
  for (const v of list(path.join(pd, "Ableton"))) if (/^Live 1\d/i.test(v)) out.push(path.join(pd, "Ableton", v, "Resources", "Core Library"));
  // Mac: /Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library
  for (const v of list("/Applications")) if (/^Ableton Live 1\d.*\.app$/i.test(v)) out.push(path.join("/Applications", v, "Contents", "App-Resources", "Core Library"));
  for (const p of list(path.join(music, "Factory Packs"))) out.push(path.join(music, "Factory Packs", p));
  out.push(path.join(music, "User Library", "User Library"), path.join(music, "User Library"));
  return out;
}

let cachedTags: TagIndex | null = null;
export function loadTags(refresh = false): TagIndex {
  if (cachedTags && !refresh) return cachedTags;
  const idx: TagIndex = { files: 0, byName: new Map() };
  for (const root of tagFolders()) {
    const info = path.join(root, "Ableton Folder Info");
    let names: string[] = [];
    try { names = fs.readdirSync(info).filter((n) => n.toLowerCase().endsWith(".xmp")); } catch { continue; }
    for (const n of names) {
      try { parseXmp(fs.readFileSync(path.join(info, n), "utf8"), idx); idx.files++; } catch { /* skip an unreadable file */ }
    }
  }
  cachedTags = idx;
  return idx;
}

/** Live's tags for one browser item, matched by file name. When packs share a file name, the one whose disk folder
 *  contains the browser folder wins; otherwise their tags are merged. */
export function tagsFor(browserPath: string, idx: TagIndex): string[] {
  const parts = browserPath.split("/");
  const hits = idx.byName.get((parts.at(-1) ?? "").toLowerCase());
  if (!hits?.length) return [];
  if (hits.length === 1) return hits[0].tags;
  const folder = (parts.at(-2) ?? "").toLowerCase();
  const near = folder ? hits.filter((h) => h.dir.includes(`/${folder}/`)) : [];
  return [...new Set((near.length ? near : hits).flatMap((h) => h.tags))];
}

// ---------- ranking ----------

export type Candidate = { tree: string; path: string };
export type Pick = { pick: number; name: string; path: string; tree: string; folder: string; kind: string; tags: string[]; why: string[]; score: number };

function nameHit(nameWords: string[], nameFlat: string, term: string): boolean {
  const t = norm(term);
  if (!t) return false;
  if (t.includes(" ")) return ` ${nameFlat} `.includes(` ${t} `);
  return nameWords.some((w) => w === t || (t.length >= 4 && w.startsWith(t)));
}

/** Scores every candidate against the description and returns the best few, with plain reasons. */
export function rankSounds(description: string, items: Candidate[], idx: TagIndex, limit = 5, concepts = understand(description)) {
  const wantsMpe = concepts.some((c) => c.said === "mpe");
  const scored: (Pick & { tie: number })[] = [];
  for (const it of items) {
    const name = displayName(it.path);
    const flat = norm(name);
    const words = flat.split(" ");
    const folders = it.path.split("/").slice(0, -1);
    const tags = tagsFor(it.path, idx);
    const tagLow = tags.map((t) => t.toLowerCase());
    let score = 0;
    let soundHit = false;
    const why: string[] = [];
    for (const c of concepts) {
      const r: string[] = [];
      let best = 0, sources = 0;
      const own = nameHit(words, flat, c.said);
      const syn = !own && c.names.find((n) => nameHit(words, flat, n));
      if (own) { best = Math.max(best, 3); sources++; r.push(`name says "${c.said}"`); }
      else if (syn) { best = Math.max(best, 2); sources++; r.push(`name has "${syn}"`); }
      const f = folders.find((x) => c.folders.some((cf) => cf.toLowerCase() === x.toLowerCase()));
      if (f) { best = Math.max(best, c.loose ? 1 : 2.5); sources++; r.push(`in the ${f} folder`); }
      const t = c.tags.filter((x) => tagLow.includes(x.toLowerCase()));
      if (t.length) { best = Math.max(best, 2.5); sources++; r.push(`Live tags it ${t.join(", ")}`); }
      if (!best) continue;
      const pts = (best + (sources > 1 ? 0.5 * (sources - 1) : 0)) * (c.kind === "sound" ? 1.5 : 1);
      if (c.kind === "sound") soundHit = true;
      score += pts;
      why.push(`${c.said}: ${r.join("; ")}`);
    }
    if (!score) continue;
    // A described kind of sound ("pad") that this item isn't counts against it, so a "warm bass" isn't a warm pad.
    if (!soundHit && concepts.some((c) => c.kind === "sound")) score *= 0.4;
    if (!wantsMpe && (tags.includes("MPE") || /^mpe\b/i.test(name))) { score -= 1; why.push("made for MPE controllers; the MPK plays it without the extra expression"); }
    const ext = (it.path.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
    const kind = ext === "adg" ? "rack (an instrument with its own effects and macro knobs)" : ext === "adv" ? "preset for one Live instrument" : ext || "item";
    scored.push({ pick: 0, name, path: it.path, tree: it.tree, folder: folders.join(" > ") || "(top)", kind, tags: tags.filter((t) => t !== "MPE"),
      why, score: Math.round(score * 10) / 10, tie: words.length });
  }
  scored.sort((a, b) => b.score - a.score || a.tie - b.tie || a.name.localeCompare(b.name));
  // One per name: "Noisy Pad.adg" and "Noisy Pad.adv" would read as the same choice.
  const seen = new Set<string>();
  const out: Pick[] = [];
  for (const s of scored) {
    const k = s.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const { tie: _tie, ...p } = s;
    out.push({ ...p, pick: out.length + 1 });
    if (out.length >= limit) break;
  }
  return { concepts, picks: out, matched: scored.length };
}

/** How the description was read, in plain words, for the tool's answer. */
export function explain(concepts: Concept[]): string[] {
  return concepts.map((c) => {
    if (c.kind === "word") return `"${c.said}": looked for it in names`;
    const where = [c.folders.length ? `folders ${c.folders.join(", ")}` : "", c.tags.length ? `Live's tags ${c.tags.slice(0, 4).join(", ")}` : "",
      `names like ${c.names.slice(0, 4).join(", ")}`].filter(Boolean).join("; ");
    return `"${c.said}" (${c.kind === "sound" ? "kind of sound" : "how it sounds"}): ${where}`;
  });
}
