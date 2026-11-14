// The installer for Second Chair, for Windows and Mac. No dependencies: it needs only Node 24.
// Start it with install.ps1 (Windows) or install.sh (Mac); both just check for Node and run this file.
//
//   node install.mjs                 install or update (safe to run again)
//   node install.mjs --check         change nothing; say what's set up and what isn't
//   node install.mjs --survey        change nothing; list what's on this computer (Live, plugins, folders) for the studio profile
//   node install.mjs --uninstall     take it out again (keeps the studio profile)
//
// Options: --dry-run (say what it would do), --user-library "<folder>" (if Live's User Library isn't found),
//          --no-claude-code, --no-claude-desktop, --no-skill, --chord-coach (also install the Chord Coach device).
//
// What it touches, and nothing else:
//   1. Live's User Library: Remote Scripts/SecondChair (the script that runs inside Live).
//   2. ~/SecondChair: the token (a random password shared by Live and the tools). It is never printed.
//   3. Claude Code's settings (~/.claude.json) and Claude desktop's (claude_desktop_config.json): one "second-chair" entry.
//      Each file is backed up next to itself first.
//   4. ~/.claude/skills/second-chair: the guide, as a skill. Plus dist/second-chair-skill.zip for uploading by hand.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const known = ["--check", "--survey", "--uninstall", "--dry-run", "--user-library", "--no-claude-code", "--no-claude-desktop", "--no-skill", "--chord-coach", "--help", "-h"];
const unknown = args.filter((a, i) => a.startsWith("-") ? !known.includes(a) : args[i - 1] !== "--user-library");
if (unknown.length || has("--help") || has("-h")) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(0, 11).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  if (unknown.length) console.log(`\nI don't know this option: ${unknown.join(" ")}`);
  process.exit(unknown.length ? 2 : 0);
}

const MODE = has("--check") ? "check" : has("--survey") ? "survey" : has("--uninstall") ? "uninstall" : "install";
const DRY = has("--dry-run");
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const REPO = import.meta.dirname;
// SECOND_CHAIR_INSTALL_HOME is for the installer's own test: it points everything at a pretend home folder.
const TEST_HOME = process.env.SECOND_CHAIR_INSTALL_HOME;
const HOME = TEST_HOME || os.homedir();
const APPDATA = WIN ? (TEST_HOME ? path.join(HOME, "AppData", "Roaming") : process.env.APPDATA || path.join(HOME, "AppData", "Roaming")) : null;
const LOCALAPPDATA = WIN ? (TEST_HOME ? path.join(HOME, "AppData", "Local") : process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local")) : null;

const SCRIPT_SRC = path.join(REPO, "live-bridge", "remote_script", "SecondChair");
const SERVER = path.join(REPO, "live-bridge", "mcp", "server.ts");
const SKILL_SRC = path.join(REPO, ".claude", "skills", "second-chair");
const SKILL_ZIP = path.join(REPO, "dist", "second-chair-skill.zip");
const NAME = "second-chair";
// Earlier betas used other names. An install over an old one moves the user's files and takes the old parts out.
const OLD = { script: "CelloBridge", name: "cello-live", home: "CelloBridge", skill: "music-studio" };

// ---- small helpers: every line the user sees says one thing, with a word in front, never a colour ----
let problems = 0;
const done = (t) => console.log(`  [done]  ${t}`);
const ok = (t) => console.log(`  [ok]    ${t}`);
const skip = (t) => console.log(`  [skip]  ${t}`);
const todo = (t) => { problems++; console.log(`  [TO DO] ${t}`); };
const head = (t) => console.log(`\n${t}`);
// Lines are written as things done ("Copied ..."); a dry run turns the verb into a plan ("copy ...").
const PLAN = { Copied: "copy", Kept: "keep", Made: "make", Moved: "move", Removed: "remove", added: "add", updated: "update", "took out": "take out" };
const would = (t) => console.log(`  [would] ${t.replace(/^(?:(.+?: )(added|updated|took out)|(Copied|Kept|Made|Removed))\b/, (m, label, v, lead) => lead ? PLAN[lead] : label + PLAN[v])}`);
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const bridgeVersion = (file) => read(file)?.match(/^VERSION = "([^"]+)"/m)?.[1] ?? null;

function act(what, fn) {
  if (DRY) return would(what);
  fn();
  done(what);
}

// ---- 1. Node ----
function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 24) return ok(`Node ${process.versions.node}`);
  todo(`Node ${process.versions.node} is too old. Install Node 24 or newer from https://nodejs.org (the LTS button), then run this again.`);
  if (MODE === "install") process.exit(1);
}

// ---- 2. Live's User Library ----
// Live writes where the User Library is into Library.cfg, per Live version. The newest Live 12 wins.
function liveVersions() {
  const base = WIN ? path.join(APPDATA, "Ableton") : path.join(HOME, "Library", "Preferences", "Ableton");
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => /^Live \d/.test(d)); } catch { /* Live never ran here */ }
  const num = (d) => d.replace(/^Live /, "").split(/[.\s]/).map((n) => parseInt(n, 10) || 0);
  dirs.sort((a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return 0; });
  // Windows keeps it in "Live x.y.z/Preferences"; the Mac keeps it directly in "Live x.y.z".
  return dirs.map((d) => ({ name: d, version: num(d), cfgs: [path.join(base, d, "Preferences", "Library.cfg"), path.join(base, d, "Library.cfg")] }));
}

function findUserLibrary() {
  const given = valueOf("--user-library");
  if (given) return { dir: path.resolve(given), how: "you gave it" };
  for (const v of liveVersions()) {
    const xml = v.cfgs.map(read).find(Boolean);
    const block = xml?.match(/<UserLibrary>[\s\S]*?<\/UserLibrary>/)?.[0];
    const name = block?.match(/<ProjectName Value="([^"]*)"/)?.[1];
    const base = block?.match(/<ProjectPath Value="([^"]*)"/)?.[1];
    if (name && base) {
      const dir = path.join(base.replace(/&amp;/g, "&"), name.replace(/&amp;/g, "&"));
      if (exists(dir)) return { dir, how: `from ${v.name}'s settings`, live: v };
    }
  }
  const guesses = WIN
    ? [path.join(HOME, "Documents", "Ableton", "User Library"), path.join(HOME, "OneDrive", "Documents", "Ableton", "User Library"), path.join(HOME, "Music", "Ableton", "User Library")]
    : [path.join(HOME, "Music", "Ableton", "User Library")];
  for (const dir of guesses) if (exists(dir)) return { dir, how: "the usual place" };
  return null;
}

// ---- 3. the token ----
const tokenHome = path.join(HOME, "SecondChair", "token");
const tokenSpots = (scriptDest) => WIN
  ? [tokenHome, path.join(APPDATA, "SecondChair", "token"), ...(scriptDest ? [path.join(scriptDest, "token")] : [])]
  : [tokenHome];
const readToken = (scriptDest) => { for (const p of [...tokenSpots(scriptDest), path.join(HOME, OLD.home, "token")]) { const t = read(p)?.trim(); if (t) return t; } return null; };

function writeToken(scriptDest) {
  let token = readToken(scriptDest);
  const fresh = !token;
  if (fresh) token = crypto.randomBytes(24).toString("hex");
  act(fresh ? `Made a new token in ${path.dirname(tokenHome)} (a password only this computer knows)` : "Kept the token you already had", () => {
    for (const p of tokenSpots(scriptDest)) {
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      fs.writeFileSync(p, token, { mode: 0o600 });
      if (!WIN) fs.chmodSync(p, 0o600);
    }
  });
}

// ---- 3b. an older install under the old names ----
const oldHome = path.join(HOME, OLD.home), newHome = path.dirname(tokenHome);
const oldSkill = path.join(HOME, ".claude", "skills", OLD.skill);
const isOldSkill = () => /^name:\s*music-studio\s*$/m.test(read(path.join(oldSkill, "SKILL.md")) ?? "");
const oldEntry = (e) => !!e && Array.isArray(e.args) && e.args.some((a) => /live-bridge[\\/]mcp[\\/]server\.ts$/.test(String(a)));
const oldScript = (lib) => path.join(lib.dir, "Remote Scripts", OLD.script);

// Returns true when it found an older install, so the last lines can say what changes in Live.
function migrate(lib) {
  let found = false;
  if (exists(oldHome)) {
    found = true;
    act(`Moved your token and studio profile from ${oldHome} to ${newHome}`, () => {
      if (!exists(newHome)) return fs.renameSync(oldHome, newHome);
      for (const e of fs.readdirSync(oldHome)) if (!exists(path.join(newHome, e))) fs.renameSync(path.join(oldHome, e), path.join(newHome, e));
      fs.rmSync(oldHome, { recursive: true, force: true });
    });
  }
  const script = oldScript(lib);
  if (exists(script)) { found = true; act(`Removed the older script ${script}`, () => fs.rmSync(script, { recursive: true, force: true })); }
  if (WIN && exists(path.join(APPDATA, OLD.home))) act(`Removed the older token folder ${path.join(APPDATA, OLD.home)}`, () => fs.rmSync(path.join(APPDATA, OLD.home), { recursive: true, force: true }));
  if (isOldSkill()) act(`Removed the older skill ${oldSkill}`, () => fs.rmSync(oldSkill, { recursive: true, force: true }));
  return found;
}

// ---- 4. Claude ----
// Node's own path can be a versioned one behind a link (Homebrew: .../Cellar/node/26.1.0/bin/node), which
// breaks at the next upgrade. Prefer the folder on PATH that leads to this same node (/opt/homebrew/bin/node).
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const sameNode = (p) => !!p && path.isAbsolute(p) && real(p) === real(process.execPath);
const nodeExe = (() => {
  const exe = WIN ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, exe);
    if (sameNode(p)) return p;
  }
  return process.execPath;
})();
// An entry that already starts this same node keeps its own spelling, so a rerun changes nothing.
const entry = (old) => ({ command: sameNode(old?.command) ? old.command : nodeExe, args: [SERVER] });
const dropOld = (j) => { if (oldEntry(j.mcpServers?.[OLD.name])) delete j.mcpServers[OLD.name]; };
const pointsHere = (e) => !!e && Array.isArray(e.args) && e.args.some((a) => path.resolve(String(a)) === SERVER);

function editJson(file, label, change) {
  const text = read(file);
  let json = {};
  if (text?.trim()) {
    try { json = JSON.parse(text); } catch { return todo(`${label}: ${file} isn't valid JSON, so I left it alone. Add the server by hand (see the README, "Add it by hand").`); }
  }
  const before = JSON.stringify(json), had = !!json.mcpServers?.[NAME];
  change(json);
  if (JSON.stringify(json) === before) return ok(`${label}: already set up`);
  act(`${label}: ${MODE === "uninstall" ? "took out" : had ? "updated" : "added"} "${NAME}" in ${file}`, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (text !== null) fs.copyFileSync(file, `${file}.before-second-chair-${stamp()}`);
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  });
}

const claudeCodeFile = path.join(HOME, ".claude.json");
const usesClaudeCode = () => exists(claudeCodeFile) || exists(path.join(HOME, ".claude"));

function desktopConfigs() {
  const found = [];
  const add = (p) => { if (!found.includes(p)) found.push(p); };
  if (MAC) {
    const dir = path.join(HOME, "Library", "Application Support", "Claude");
    if (exists(dir)) add(path.join(dir, "claude_desktop_config.json"));
  } else if (WIN) {
    const classic = path.join(APPDATA, "Claude");
    if (exists(classic)) add(path.join(classic, "claude_desktop_config.json"));
    // The Microsoft Store build keeps its data under Local\Claude-Data\claude_<id>.
    try { for (const d of fs.readdirSync(path.join(LOCALAPPDATA, "Claude-Data"))) if (/^claude_/i.test(d)) add(path.join(LOCALAPPDATA, "Claude-Data", d, "claude_desktop_config.json")); } catch { /* not installed that way */ }
  } else {
    const dir = path.join(HOME, ".config", "Claude");
    if (exists(dir)) add(path.join(dir, "claude_desktop_config.json"));
  }
  return found;
}

function registerClaude() {
  if (has("--no-claude-code")) skip("Claude Code: you asked me to leave it alone");
  else if (!usesClaudeCode()) skip("Claude Code: not found on this computer (that's fine if you use the Claude desktop app)");
  else editJson(claudeCodeFile, "Claude Code", (j) => { j.mcpServers ??= {}; dropOld(j); j.mcpServers[NAME] = { type: "stdio", ...entry(j.mcpServers[NAME]), env: j.mcpServers[NAME]?.env ?? {} }; });

  if (has("--no-claude-desktop")) return skip("Claude desktop app: you asked me to leave it alone");
  const files = desktopConfigs();
  if (!files.length) return skip("Claude desktop app: not found on this computer. If you install it later, run this installer again.");
  for (const f of files) editJson(f, "Claude desktop app", (j) => { j.mcpServers ??= {}; dropOld(j); j.mcpServers[NAME] = { ...(j.mcpServers[NAME] ?? {}), ...entry(j.mcpServers[NAME]) }; });
  // Other agents are a one-line command for the user; this installer only edits Claude's files.
  if (exists(path.join(HOME, ".codex"))) skip(`Codex: I don't edit its settings. To add the tools, run:  codex mcp add ${NAME} -- node "${SERVER}"`);
}

function unregisterClaude() {
  const drop = (j) => { if (j.mcpServers && pointsHere(j.mcpServers[NAME])) delete j.mcpServers[NAME]; dropOld(j); };
  if (exists(claudeCodeFile)) editJson(claudeCodeFile, "Claude Code", drop);
  for (const f of desktopConfigs()) if (exists(f)) editJson(f, "Claude desktop app", drop);
}

// ---- 5. the skill ----
const skillDest = path.join(HOME, ".claude", "skills", "second-chair");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === "__pycache__" || e.name.endsWith(".pyc") || e.name === "token") continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function installSkill() {
  if (has("--no-skill")) return skip("The skill: you asked me to leave it out");
  if (usesClaudeCode()) act(`Copied the second-chair skill to ${skillDest} (Claude Code loads it by itself)`, () => { fs.rmSync(skillDest, { recursive: true, force: true }); copyDir(SKILL_SRC, skillDest); });
  else skip("The skill for Claude Code: Claude Code isn't on this computer");
  // A zip for the Claude desktop app's chat, where skills are uploaded by hand. The folder must be the zip's top level.
  if (DRY) return would(`make ${SKILL_ZIP} for uploading to the Claude app`);
  try {
    fs.mkdirSync(path.dirname(SKILL_ZIP), { recursive: true });
    fs.writeFileSync(SKILL_ZIP, zip(SKILL_SRC, "second-chair"));
    done(`Made ${SKILL_ZIP} (upload it in the Claude app: see "B. CLAUDE" below)`);
  } catch (e) {
    skip(`Couldn't make the skill zip (${String(e.message).split("\n")[0]}). You don't need it: the studio_guide tool gives Claude the same guide.`);
  }
}

// A plain zip file, written here so it needs no other program and always uses "/" in its paths.
function zip(dir, top) {
  const files = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) e.isDirectory() ? walk(path.join(d, e.name), `${rel}/${e.name}`) : files.push({ name: `${rel}/${e.name}`, data: fs.readFileSync(path.join(d, e.name)) }); };
  walk(dir, top);
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), packed = zlib.deflateRawSync(f.data), crc = zlib.crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); // 1980-01-01, so the same files always give the same zip
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(f.data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, name, packed); central.push(cen, name);
    offset += 30 + name.length + packed.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

// ---- Chord Coach (optional; needs Max for Live) ----
function installChordCoach(lib) {
  const src = path.join(REPO, "chord-coach");
  const dest = path.join(lib, "Presets", "MIDI Effects", "Max MIDI Effect", "Chord Coach");
  if (!exists(path.join(src, "Chord Coach.amxd"))) return skip("Chord Coach: its files aren't in this copy");
  act(`Copied Chord Coach to ${dest}`, () => { fs.mkdirSync(dest, { recursive: true }); for (const f of ["Chord Coach.amxd", "chordcoach.js"]) fs.copyFileSync(path.join(src, f), path.join(dest, f)); });
}

// ---- is Live answering? ----
function ping(token, ms = 1500) {
  const port = Number(process.env.SECOND_CHAIR_PORT) || 9885;
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    let buf = "";
    const end = (r) => { sock.destroy(); resolve(r); };
    sock.setTimeout(ms, () => end({ up: false }));
    sock.on("error", () => end({ up: false }));
    sock.on("connect", () => sock.write(JSON.stringify({ id: 1, token, action: "ping", params: {} }) + "\n"));
    sock.on("data", (d) => { buf += d; if (buf.includes("\n")) { try { end({ up: true, reply: JSON.parse(buf.split("\n")[0]) }); } catch { end({ up: true, reply: null }); } } });
  });
}

// ---- the three modes ----
async function install() {
  console.log(`Installing Second Chair${DRY ? " (dry run: nothing is changed)" : ""}`);
  head("1. This computer");
  checkNode();
  if (!WIN && !MAC) todo("This is neither Windows nor a Mac. Ableton Live doesn't run here, so only the theory tools will work.");
  const lib = findUserLibrary();
  if (!lib) {
    todo(`I couldn't find Live's User Library. Open Live once, look at Settings > Library > "Location of User Library", then run this again with:  --user-library "<that folder>"`);
    process.exit(1);
  }
  ok(`Live's User Library: ${lib.dir} (${lib.how})`);
  if (lib.live && (lib.live.version[0] < 12 || (lib.live.version[0] === 12 && (lib.live.version[1] ?? 0) < 3))) todo(`${lib.live.name} is older than Live 12.3. The tools need 12.3 or newer; some will refuse to work.`);

  head("2. Inside Live");
  const moved = migrate(lib);
  const dest = path.join(lib.dir, "Remote Scripts", "SecondChair");
  const was = bridgeVersion(path.join(dest, "__init__.py")), now = bridgeVersion(path.join(SCRIPT_SRC, "__init__.py"));
  act(`Copied the SecondChair script ${now} to ${dest}${was && was !== now ? ` (it was ${was})` : ""}`, () => { copyDir(SCRIPT_SRC, dest); fs.rmSync(path.join(dest, "__pycache__"), { recursive: true, force: true }); });
  writeToken(dest);
  if (has("--chord-coach")) installChordCoach(lib.dir);

  head("3. In Claude");
  registerClaude();
  installSkill();

  const live = await ping(readToken(dest) ?? "");
  const running = live.up && live.reply?.ok ? live.reply.result?.bridge : null;
  console.log(`
${DRY ? "Dry run: nothing was changed. After a real install, these are the steps for you:" : "Done. Three things are left for you:"}

  A. LIVE.  ${running === now ? `Live already runs SecondChair ${now}. Nothing to do.` : running ? `Live is running the older script (${running}). Quit Live fully and open it again.` : `Quit Live fully if it's open, and open it again. Then:
       Settings > Link, Tempo & MIDI > Control Surface: ${moved ? `the row that said "${OLD.script}" is now empty. Pick "SecondChair" there.` : 'in an empty row pick "SecondChair".'}
       Leave its Input and Output on "None". The bar at the bottom of Live says "SecondChair ${now} ready".`}

  B. CLAUDE.  Quit Claude fully and open it again (on Windows, also from the tray icon near the clock).
       Claude Code, and the Code tab of the desktop app: nothing else. The tools and the skill load by themselves.
       The desktop app's chat: the tools show under the "+" / tools button as "${NAME}". Allow them when Claude asks.
       The skill is optional there (the tools carry the same guide). To add it: Settings > Capabilities > Skills >
       upload ${SKILL_ZIP}

  C. SAY HELLO.  Open a song in Live and ask Claude:  "Check my Live connection and tell me what's in my set."
       The first time, Claude asks you a few questions about your studio and saves the answers on this computer.

  Check the setup any time:  ${WIN ? "powershell -ExecutionPolicy Bypass -File install.ps1 --check" : "sh install.sh --check"}
  Don't move this folder: Claude starts the tools from here. If you do move it, run the installer again.
  What you can ask for: docs/what-you-can-do.md
${problems ? `\n  ${problems} line(s) above say TO DO. Sort those out first.` : ""}`);
}

async function check() {
  console.log("Checking the setup (nothing is changed)");
  head("This computer");
  checkNode();
  const lib = findUserLibrary();
  if (!lib) todo('Live\'s User Library: not found. Run the installer with --user-library "<folder>".');
  else ok(`Live's User Library: ${lib.dir} (${lib.how})`);

  head("Inside Live");
  if (exists(oldHome) || (lib && exists(oldScript(lib)))) todo(`An older install under the name ${OLD.script} is still here. Run the installer: it moves your token and studio profile to ${newHome} and takes the old parts out.`);
  const dest = lib && path.join(lib.dir, "Remote Scripts", "SecondChair");
  const now = bridgeVersion(path.join(SCRIPT_SRC, "__init__.py"));
  const inst = dest && bridgeVersion(path.join(dest, "__init__.py"));
  if (!inst) todo("The SecondChair script isn't in Live's User Library. Run the installer.");
  else if (inst !== now) todo(`The script in Live's User Library is ${inst}; this folder has ${now}. Run the installer, then restart Live.`);
  else ok(`The SecondChair script ${inst} is in Live's User Library`);
  const token = readToken(dest);
  if (!token) todo("No token. Run the installer.");
  else ok("The token exists");
  if (token) {
    const live = await ping(token);
    if (!live.up) todo('Live isn\'t answering. Is Live open, with "SecondChair" picked under Settings > Link, Tempo & MIDI > Control Surface?');
    else if (!live.reply?.ok) todo("Live answered but refused the token. Run the installer, then restart Live.");
    else if (live.reply.result?.bridge !== now) todo(`Live runs SecondChair ${live.reply.result?.bridge}, but ${now} is installed. Quit Live fully and open it again.`);
    else ok(`Live ${live.reply.result.live} is answering, with SecondChair ${live.reply.result.bridge}`);
  }

  head("In Claude");
  const code = (() => { try { return JSON.parse(read(claudeCodeFile) ?? "{}").mcpServers?.[NAME]; } catch { return null; } })();
  if (!usesClaudeCode()) skip("Claude Code: not on this computer");
  else if (pointsHere(code)) ok("Claude Code starts the tools from this folder");
  else if (code) todo("Claude Code has a second-chair entry that points at another folder. Run the installer to point it here.");
  else todo("Claude Code doesn't know the tools yet. Run the installer.");
  const desks = desktopConfigs();
  if (!desks.length) skip("Claude desktop app: not on this computer");
  for (const f of desks) {
    let e = null; try { e = JSON.parse(read(f) ?? "{}").mcpServers?.[NAME]; } catch { /* reported below */ }
    if (pointsHere(e)) ok("The Claude desktop app starts the tools from this folder");
    else todo(`The Claude desktop app doesn't know the tools yet (${f}). Run the installer.`);
  }
  if (usesClaudeCode()) {
    const mine = read(path.join(skillDest, "SKILL.md")), fresh = read(path.join(SKILL_SRC, "SKILL.md"));
    if (mine === null) skip("The second-chair skill isn't copied for Claude Code. That's optional: the tools carry the same guide. The installer adds it.");
    else if (mine !== fresh) todo("The second-chair skill for Claude Code is older than this folder's. Run the installer to refresh it.");
    else ok("The second-chair skill is installed for Claude Code");
  }
  const profile = process.env.SECOND_CHAIR_STUDIO_FILE || path.join(HOME, "SecondChair", "my-studio.md");
  (exists(profile) ? ok : skip)(exists(profile) ? `Your studio profile: ${profile}` : "No studio profile yet. Claude asks you the questions the first time.");
  console.log(problems ? `\nNOT READY: ${problems} thing(s) to do, marked TO DO above. (Exit code 1.)` : "\nREADY: everything is set up. (Exit code 0.)");
  process.exitCode = problems ? 1 : 0;
}

// ---- the survey: facts an agent can read off this computer, so it asks the user less ----
// It reads Live's own settings files and folder names. It never reads the token, a song, or audio.
function installedLives() {
  const found = [];
  try {
    if (WIN) for (const d of fs.readdirSync(path.join(process.env.ProgramData || "C:\\ProgramData", "Ableton"))) { if (/^Live \d/.test(d)) found.push(d); }
    else if (MAC) for (const d of fs.readdirSync("/Applications")) { const m = d.match(/^Ableton (Live .+)\.app$/); if (m) found.push(m[1]); }
  } catch { /* none */ }
  return found;
}

function places(v) {
  const xml = v?.cfgs.map(read).find(Boolean) ?? "";
  return [...xml.matchAll(/<UserFolderInfo\b[^>]*\bPath="([^"]*)"[^>]*>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}

function plugins(v) {
  const kind = (f) => ({ ".vst3": "VST3", ".dll": "VST2", ".vst": "VST2", ".component": "AU" })[path.extname(f).toLowerCase()];
  const out = new Map(); // name -> set of formats
  const add = (file) => { const k = kind(file); if (!k) return; const n = path.basename(file, path.extname(file)); out.set(n, (out.get(n) ?? new Set()).add(k)); };
  // 1. Live's own list of the plugins it scanned (the best source: it is what Live's browser shows).
  let how = null;
  for (const dir of v ? [path.join(v.dir, "Preferences"), v.dir] : []) {
    const db = read(path.join(dir, "PluginScanDb.txt"));
    if (!db) continue;
    for (const m of db.matchAll(/^\d+,"([^"]+)",[^\n]*$/gm)) add(m[1]);
    if (out.size) { how = `${v.name}'s own plugin scan`; break; }
  }
  // 2. Otherwise, the usual plugin folders (two levels, since makers use their own subfolders).
  if (!out.size) {
    const roots = WIN
      ? [path.join(process.env.CommonProgramFiles || "C:\\Program Files\\Common Files", "VST3"), "C:\\Program Files\\VSTPlugins", "C:\\Program Files\\Steinberg\\VSTPlugins"]
      : ["/Library/Audio/Plug-Ins", path.join(HOME, "Library", "Audio", "Plug-Ins")].flatMap((r) => ["VST3", "VST", "Components"].map((k) => path.join(r, k)));
    const walk = (d, depth) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (kind(e.name)) add(e.name); else if (e.isDirectory() && depth < 2) walk(path.join(d, e.name), depth + 1); } };
    for (const r of roots) walk(r, 0);
    if (out.size) how = "the usual plugin folders";
  }
  return { how, list: [...out].sort((a, b) => a[0].localeCompare(b[0])).map(([n, k]) => `${n} (${[...k].sort().join(", ")})`) };
}

function survey() {
  const vers = liveVersions().map((v) => ({ ...v, dir: path.dirname(v.cfgs[1]) }));
  const lib = findUserLibrary();
  const v = lib?.live ? vers.find((x) => x.name === lib.live.name) : vers[0];
  const line = (k, val) => console.log(`- **${k}:** ${val}`);
  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  console.log(`# What's on this computer (a survey for the studio profile)

Nothing was changed. This lists folder paths and plugin names read from Live's own settings files.
It never reads the token, a song or any audio. It stays on this computer unless you paste it somewhere.

## Computer
`);
  line("System", `${WIN ? "Windows" : MAC ? "macOS" : os.type()} ${os.release()} (${os.arch()})`);
  line("Node", `${process.versions.node}${Number(process.versions.node.split(".")[0]) >= 24 ? "" : " (too old: the tools need 24 or newer)"}`);
  line("Git", git.status === 0 ? git.stdout.trim().replace(/^git version /, "") : "not found (only needed to update with git pull, or to send fixes)");
  line("AI apps found", [usesClaudeCode() && "Claude Code", desktopConfigs().length && "Claude desktop app", exists(path.join(HOME, ".codex")) && "Codex"].filter(Boolean).join(", ") || "none of Claude Code, the Claude desktop app or Codex");

  console.log("\n## Ableton Live\n");
  line("Installed", installedLives().join(", ") || "not found in the usual place (ask the user which edition: Intro, Standard or Suite)");
  line("Versions that have run here", vers.map((x) => x.name).join(", ") || "none: Live hasn't been opened on this computer yet");
  line("User Library", lib ? `${lib.dir} (${lib.how})` : "not found");
  const pl = places(v);
  line("Folders under Places in Live's browser", pl.length ? "(listed below)" : "none added. Sample folders must be added there (drag the folder into Live's browser) before the tools can load from them.");
  for (const f of pl) console.log(`  - ${f}${exists(f) ? "" : " (missing on disk)"}`);

  const pg = plugins(v);
  console.log(`\n## Plugins${pg.how ? ` (${pg.list.length}, from ${pg.how})` : ""}\n`);
  if (!pg.list.length) console.log("- None found. Either there are none, or Live hasn't scanned them yet (Settings > Plug-Ins).");
  for (const n of pg.list.slice(0, 400)) console.log(`- ${n}`);
  if (pg.list.length > 400) console.log(`- ... and ${pg.list.length - 400} more`);

  console.log(`
## Not readable from files: ask the user

- Their name, and how they like to be taught.
- How much they know about producing and about Live; other DAWs they use.
- What they mostly want help with (for this beta: mixing and mastering).
- Whether the assistant should ever suggest musical ideas, or only when asked.
- Controller or keyboard (model, and which MIDI port Live uses).
- Audio interface (model; what's plugged into each input), instruments and mics.
- Which of the plugins above they reach for most, and for what.
- Where their sample folders are, if none are listed under Places above.
- Anything about how they see or hear that matters (for example colour blindness).

Setup state (what's installed, whether Live answers): run this installer with --check.`);
}

function uninstall() {
  console.log(`Taking Second Chair out${DRY ? " (dry run: nothing is changed)" : ""}`);
  const lib = findUserLibrary();
  const dest = lib && path.join(lib.dir, "Remote Scripts", "SecondChair");
  if (dest && exists(dest)) act(`Removed ${dest}`, () => fs.rmSync(dest, { recursive: true, force: true }));
  else skip("The script wasn't in Live's User Library");
  if (lib && exists(oldScript(lib))) act(`Removed the older script ${oldScript(lib)}`, () => fs.rmSync(oldScript(lib), { recursive: true, force: true }));
  unregisterClaude();
  if (exists(path.join(skillDest, "SKILL.md"))) act(`Removed ${skillDest}`, () => fs.rmSync(skillDest, { recursive: true, force: true }));
  for (const p of tokenSpots(null)) if (exists(p)) act(`Removed the token ${p}`, () => fs.rmSync(p, { force: true }));
  console.log(`
Done. In Live, set the SecondChair row under Settings > Link, Tempo & MIDI > Control Surface back to "None", then restart Live.
Your studio profile and notes in ${path.join(HOME, "SecondChair")} are kept. Delete that folder and this one yourself if you want them gone.`);
}

await (MODE === "check" ? check() : MODE === "survey" ? survey() : MODE === "uninstall" ? uninstall() : install());
