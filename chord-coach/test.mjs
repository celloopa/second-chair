// Runs chordcoach.js outside Max, with stand-ins for Max's drawing and timers. It checks the chords of a few keys,
// the guitar shapes, the bass map, following Live's key, and that every key, mode and instrument draws without an error.
// It can't check how the device looks or sounds in Live.
//
//   node chord-coach/test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const src = fs.readFileSync(path.join(import.meta.dirname, "chordcoach.js"), "utf8");
let failed = 0;
const eq = (what, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { failed++; console.log(`!! ${what}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); } };

const drawn = [];
const mgraphics = new Proxy({ size: [900, 169], text_measure: (s) => [String(s).length * 6, 10], show_text: (s) => drawn.push(String(s)), redraw() {}, init() {} },
  { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
function Task() { this.repeat = () => {}; this.cancel = () => {}; this.schedule = () => {}; }
const live = { root_note: 4, scale_name: "Dorian" };
function LiveAPI(cb, p) { this.cb = cb; this.get = (k) => [live[k]]; }
const out = [];
const box = { mgraphics, Task, LiveAPI, outlet: (...a) => out.push(a), arrayfromargs: (a) => Array.from(a), messagename: "", Math, Date, isNaN, String, Array };
vm.createContext(box);
vm.runInContext(src, box);
const run = (code) => vm.runInContext(code, box);
const names = () => run("CH.map(function (c) { return c.nm; })");
const romans = () => run("CH.map(function (c) { return c.roman; })");

// ---- chords of a key ----
run("key(0); mode('major')");
eq("C major triads", names(), ["C", "Dm", "Em", "F", "G", "Am", "Bdim"]);
eq("C major romans", romans(), ["I", "ii", "iii", "IV", "V", "vi", "vii°"]);
run("sevenths = 1; buildChords()");
eq("C major 7ths", names(), ["Cmaj7", "Dm7", "Em7", "Fmaj7", "G7", "Am7", "Bm7b5"]);
run("sevenths = 0; key(4); mode('dorian')");
eq("E Dorian triads", names(), ["Em", "F#m", "G", "A", "Bm", "C#dim", "D"]);
eq("E Dorian romans", romans(), ["i", "ii", "bIII", "IV", "v", "vi°", "bVII"]);
run("key(5); mode('major')");
eq("F major uses flats", names(), ["F", "Gm", "Am", "Bb", "C", "Dm", "Edim"]);
run("key(3); mode('minor')");
eq("Eb minor spelling", names(), ["Ebm", "Fdim", "Gb", "Abm", "Bbm", "Cb", "Db"]);
run("key(9); mode('harmonic minor')");
eq("A harmonic minor", names(), ["Am", "Bdim", "Caug", "Dm", "E", "F", "G#dim"]);
run("key(7); mode('mixolydian')");
eq("G Mixolydian", names(), ["G", "Am", "Bdim", "C", "Dm", "Em", "F"]);
eq("the keyboard voicing starts on the root and fits the 25 keys", run("CH.every(function (c) { return c.keys[0] % 12 === c.root && c.keys[c.keys.length - 1] <= 72 && c.keys[0] >= 48; })"), true);

// ---- guitar shapes: known open chords, and every chord of every key gets a valid shape ----
const shape = (r, m, i, sev = 0) => run(`sevenths = ${sev}; key(${r}); mode('${m}'); guitarShape(CH[${i}])`);
eq("E minor open shape", shape(4, "minor", 0), [0, 2, 2, 0, 0, 0]);
eq("C major open shape", shape(0, "major", 0), [-1, 3, 2, 0, 1, 0]);
eq("G major open shape", shape(7, "major", 0), [3, 2, 0, 0, 0, 3]);
eq("A minor open shape", shape(9, "minor", 0), [-1, 0, 2, 2, 1, 0]);
eq("D major open shape", shape(2, "major", 0), [-1, -1, 0, 2, 3, 2]);
const TUNE = [40, 45, 50, 55, 59, 64];
let shapesChecked = 0, noShape = [];
for (let r = 0; r < 12; r++) for (const m of run("MODES.map(function (m) { return m.id; })")) for (const sev of [0, 1]) for (let i = 0; i < 7; i++) {
  const g = shape(r, m, i, sev), c = run(`CH[${i}]`);
  if (!g) { noShape.push(`${c.nm}`); continue; }
  shapesChecked++;
  const sounding = g.map((f, s) => (f < 0 ? null : (TUNE[s] + f) % 12)).filter((x) => x !== null);
  const fretted = g.filter((f) => f > 0);
  const bad = sounding[0] !== c.root || sounding.some((p) => !c.pcs.includes(p)) || !sounding.includes(c.pcs[1])
    || (fretted.length && Math.max(...fretted) - Math.min(...fretted) > 3) || /\d,-1,.*\d/.test(g.slice(g.findIndex((f) => f >= 0)).join(","));
  if (bad) { failed++; console.log(`!! bad guitar shape for ${c.nm}: ${g}`); }
}
if (noShape.length) { failed++; console.log(`!! no guitar shape for: ${[...new Set(noShape)].join(" ")}`); }

// ---- every key, mode, chord size and instrument draws; the mode panel names the mode's own note ----
for (let r = 0; r < 12; r++) for (let m = 0; m < run("MODES.length"); m++) for (const sev of [0, 1]) for (let inst = 0; inst < 3; inst++) {
  run(`sevenths = ${sev}; keyRoot = ${r}; modeIx = ${m}; progIx = 0; instrument = ${inst}; shown = null; buildChords()`);
  for (let i = 0; i < 7; i++) { try { run(`cur = ${i}; paint()`); } catch (e) { failed++; console.log(`!! paint failed: key ${r} mode ${m} inst ${inst} chord ${i}: ${e.message}`); } }
}
drawn.length = 0;
run("sevenths = 0; instrument = 2; key(4); mode('dorian'); cur = 0; paint()");
if (!drawn.some((s) => s.includes("Its sound: C#, the raised 6th"))) { failed++; console.log("!! E Dorian should name C# as its sound"); }
if (!drawn.some((s) => s.includes("Start on the root: E string, open"))) { failed++; console.log("!! the bass panel should say where the root is"); }
if (!drawn.some((s) => s === "Em   A   Em   A")) { failed++; console.log("!! E Dorian's first progression should be Em A Em A"); }

// ---- clicks: the instrument tabs, the mode stepper, the 7ths toggle, the progression ----
const click = (act, extra = "") => run(`paint(); (function () { for (var i = 0; i < hits.length; i++) if (hits[i].act === '${act}' ${extra}) { onclick(hits[i].x + 2, hits[i].y + 2); return; } throw new Error('no ${act} button'); })()`);
click("inst", "&& hits[i].i === 1"); eq("the Guitar tab", run("instrument"), 1);
click("modeup"); eq("the mode stepper", run("MODES[modeIx].id"), "phrygian");
click("keyup"); eq("the key stepper", run("keyRoot"), 5);
click("sevenths"); eq("the 7ths toggle", names()[0], "Fm7");
click("prog"); eq("the progression button picks the next one", run("progIx"), 1);
click("chord", "&& hits[i].i === 3"); eq("a chord button", run("cur"), 3);
if (!out.some((a) => a[0] === 0 && a[2] === 90)) { failed++; console.log("!! clicking a chord should play it"); }

// ---- following Live's key, the bars, a played chord and a chord shown by the bridge ----
run("followLive = 1; bang()");
eq("follows Live's key on load", run("keyName()"), "E Dorian");
live.root_note = 2; live.scale_name = "Minor"; run("readLiveKey()");
eq("follows a change of Live's key", run("keyName()"), "D Minor");
live.scale_name = "Whole Tone"; run("readLiveKey()");
eq("a scale it doesn't know leaves a note and keeps the mode", [run("liveNote"), run("MODES[modeIx].id")], ["Live's scale (Whole Tone) isn't one of these modes", "minor"]);
run("sevenths = 0; key(4); mode('dorian'); follow = 1; lastBar = -1; bar(2)");
eq("follows the progression by bar", run("CH[cur].nm"), "A");
run("follow = 0; advance = 1; cur = 0; note(52, 90); note(55, 90); note(59, 90)");
eq("a played chord is matched", run("matched"), true);
eq("and named", run("soundingName()"), "Em");
run("note(52, 0); note(55, 0); note(59, 0)");
eq("letting go moves to the next chord of the progression", run("CH[cur].nm"), "A");
run("show('Dm7', 50, 53, 57, 60); instrument = 1; paint(); instrument = 2; paint(); instrument = 0; paint()");
eq("a chord from the bridge is shown with its lowest note as the root", run("target().root"), 2);

console.log(failed ? `\n${failed} Chord Coach check(s) failed.` : `Chord Coach checks passed (${shapesChecked} guitar shapes).`);
process.exit(failed ? 1 : 0);
