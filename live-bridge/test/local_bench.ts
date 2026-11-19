// Benchmark a local model on Second Chair's real tools, with fake Live (offline-mode research, section 5).
//   node live-bridge/test/local_bench.ts --oracle                 check the harness itself (a scripted, perfect model)
//   node live-bridge/test/local_bench.ts                          LM Studio at http://127.0.0.1:1234/v1, its loaded model
//   node live-bridge/test/local_bench.ts --endpoint http://127.0.0.1:11434/v1 --model qwen3.5:9b     (Ollama)
//   node live-bridge/test/local_bench.ts --part knowledge          74 multiple-choice and 8 open questions, no tools
//   node live-bridge/test/local_bench.ts --mock-wrong              a careless stand-in (sets the tempo every time): all must fail
// More: --part tools|knowledge|all (default tools), --nudge-empty (ask once more after an empty answer),
//       --word-rule (as a client would: asks that the word rule in mcp/profiles.ts catches are handed on without the
//       model; those runs are marked routed_by "word-rule" and are not the model's own answers),
//       --port 29885, --profile offline|all (default offline), --runs 3, --groups A,B,C, --only A1,C2, --max-calls 8, --out <dir>,
//       --temperature 0.2, --source local|cloud (who produced the answers; default local).
// It starts fake_live.py on port 19885 and the server (SECOND_CHAIR_TOOLS=<profile>) itself; the real Live is never
// touched (test mode). Every request gets the same guards the report asks for: at most --max-calls tool calls, stop on
// the same call twice in a row, and the server refuses unknown or missing arguments in the offline profile.
// Output, in --out (default ~/SecondChair/bench/<time>-<model>):
//   runs.jsonl: one line per ask and run, ready for later training: messages (system, user, assistant, tool), the tool
//               list's names, the checks and pass/fail, timings, and source/model, so answers from Claude (the
//               baseline) can always be kept out of a training set (Anthropic's terms; see the research report).
//   summary.json and a printed table: pass rate per group (an ask passes only when all its runs pass), wrong changes
//   (must be 0), right hand-ons, calls per ask, time to the first answer.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// ---------- options ----------
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const flag = (k: string) => argv.includes(`--${k}`);
const MOCK_WRONG = flag("mock-wrong");
const ORACLE = flag("oracle") || MOCK_WRONG;
const NUDGE = flag("nudge-empty");
const WORD_RULE = flag("word-rule");
const { wordRule } = await import("../mcp/profiles.ts");
const PART = (opt("part", "tools") ?? "tools") as "tools" | "knowledge" | "all";
const ENDPOINT = (opt("endpoint", "http://127.0.0.1:1234/v1") ?? "").replace(/\/+$/, "");
const PROFILE = opt("profile", "offline") as "offline" | "all";
const RUNS = ORACLE ? 1 : Number(opt("runs", "3"));
const MAX_CALLS = Number(opt("max-calls", "8"));
const TEMPERATURE = Number(opt("temperature", "0.2"));
const SOURCE = opt("source", MOCK_WRONG ? "mock-wrong" : ORACLE ? "oracle" : "local");
const GROUPS = opt("groups")?.split(",").map((g) => g.trim().toUpperCase());
const ONLY = opt("only")?.split(",").map((g) => g.trim().toUpperCase());
const PORT = Number(opt("port", "29885")); // its own port (and UDP +1..+3), so it never clashes with the normal test runs on 19885
const HERE = import.meta.dirname;

type Check = { tool?: string[]; first_tool?: string; args?: { name: string; match: Record<string, string> }; reply?: string;
  state?: { tempo?: number; playing?: boolean; track_count?: number; muted?: [number, boolean]; armed?: [number, boolean]; track_name?: [number, string] };
  hand_on?: boolean; no_change?: boolean };
type Ask = { id: string; group: string; ask: string; setup?: string; offline: Check; all?: Check; oracle: { name: string; arguments: Record<string, unknown> }[] };
const ASKS: Ask[] = JSON.parse(fs.readFileSync(path.join(HERE, "bench_asks.json"), "utf8")).asks
  .filter((a: Ask) => (!GROUPS || GROUPS.includes(a.group)) && (!ONLY || ONLY.includes(a.id)));

// ---------- fake Live and the server ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "second-chair-bench-"));
const STUDIO = path.join(TMP, "my-studio.md");
fs.writeFileSync(STUDIO, "# My studio\n\n- Name: Sam\n- Ableton Live 12 Suite on Windows\n- Controller: a 25-key keyboard\n- Learning: plain words, one step at a time\n");
fs.writeFileSync(path.join(TMP, "menu.json"), JSON.stringify({ window: false }));
const kids: ChildProcess[] = [];
// On Windows `python` can be a launcher that starts the real Python as a child, so kill the whole tree (seen: a
// leftover fake_live kept the Ears UDP ports and broke the next test run).
const killTree = (k: ChildProcess) => { try { if (process.platform === "win32" && k.pid) spawnSync("taskkill", ["/PID", String(k.pid), "/T", "/F"], { stdio: "ignore" }); else k.kill(); } catch { /* gone */ } };
const cleanup = () => { for (const k of kids) killTree(k); };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

async function waitPort(port: number, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = await new Promise<boolean>((res) => { const s = net.createConnection({ host: "127.0.0.1", port }, () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
let fake: ChildProcess | null = null;
async function startFake() {
  if (fake) { killTree(fake); await new Promise((r) => setTimeout(r, 600)); }
  fake = spawn(process.platform === "win32" ? "python" : "python3", [path.join(HERE, "fake_live.py"), "3600"], { env: { ...process.env, SECOND_CHAIR_PORT: String(PORT) }, stdio: "ignore" });
  kids.push(fake);
  if (!(await waitPort(PORT, 15000))) throw new Error("fake_live.py didn't start on port " + PORT);
}
const server = spawn(process.execPath, [path.join(HERE, "..", "mcp", "server.ts")], { stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, SECOND_CHAIR_TOOLS: PROFILE, SECOND_CHAIR_PORT: String(PORT), SECOND_CHAIR_LIVE_TITLE: "my-song - Ableton Live 12 Suite",
    SECOND_CHAIR_LIVE_MENU: path.join(TMP, "menu.json"), SECOND_CHAIR_STATE_DIR: path.join(TMP, "state"), SECOND_CHAIR_STUDIO_FILE: STUDIO,
    SECOND_CHAIR_PLUGINS_FILE: path.join(TMP, "my-plugins.md"), SECOND_CHAIR_SAMPLE_DIRS: TMP, SECOND_CHAIR_ABLETON_LIBRARIES: path.join(HERE, "fixtures") } });
kids.push(server);
let buf = ""; const waiting = new Map<number, (m: any) => void>(); let rpcId = 0;
server.stdout!.on("data", (c) => { buf += c; let nl; while ((nl = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1); waiting.get(m.id)?.(m); } });
const rpc = (method: string, params?: unknown) => new Promise<any>((res) => { const i = ++rpcId; waiting.set(i, res); server.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
async function callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const m = await rpc("tools/call", { name, arguments: args });
  if (m.error) return { text: m.error.message, isError: true };
  return { text: (m.result.content ?? []).map((c: any) => c.text ?? `[${c.type}]`).join("\n"), isError: !!m.result.isError };
}

// ---------- state, for the checks ----------
type State = { tempo: number; playing: boolean; tracks: { name: string; mute: boolean; armed: boolean }[] };
async function state(): Promise<State> {
  // fake Live can drop one connection now and then (seen: "Bridge connection closed"); read again before giving up
  let r = { text: "", isError: true };
  for (let i = 0; i < 4; i++) { r = await callTool("live_status", {}); if (!r.isError && r.text.trim().startsWith("{")) break; await new Promise((res) => setTimeout(res, 500)); }
  if (!r.text.trim().startsWith("{")) throw new Error("reading the fake set failed: " + r.text.slice(0, 120));
  const s = JSON.parse(r.text).session;
  return { tempo: s.tempo, playing: !!s.is_playing, tracks: s.tracks.filter((t: any) => t.kind !== "return" && t.kind !== "main").map((t: any) => ({ name: t.name, mute: !!t.mute, armed: !!t.armed })) };
}
const sameSet = (a: State, b: State) => a.tempo === b.tempo && JSON.stringify(a.tracks) === JSON.stringify(b.tracks);

// ---------- the model ----------
type Msg = { role: string; content?: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string };
let MODEL = opt("model") ?? "";
async function chat(messages: Msg[], tools: any[]): Promise<Msg> {
  const r = await fetch(`${ENDPOINT}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", temperature: TEMPERATURE, max_tokens: 1200 }) });
  if (!r.ok) throw new Error(`${ENDPOINT} answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json() as any;
  return j.choices?.[0]?.message ?? { role: "assistant", content: "" };
}
/** The scripted perfect model: the ask's oracle calls, one per turn, then an answer made of the tool results. */
function oracleModel(ask: Ask) {
  let i = 0;
  return async (messages: Msg[]): Promise<Msg> => {
    if (i < ask.oracle.length) { const c = ask.oracle[i++]; return { role: "assistant", content: null, tool_calls: [{ id: `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }] }; }
    const results = messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
    return { role: "assistant", content: `Done. ${results}` };
  };
}
const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
/** A careless stand-in (from the research chat's harness): sets the tempo on every ask, then says it's done. Every ask
 *  must fail; with --profile all, the ones that forbid changes must count as wrong changes. */
function carelessModel() {
  let i = 0;
  return async (): Promise<Msg> => i++ === 0
    ? { role: "assistant", content: null, tool_calls: [{ id: "w0", type: "function", function: { name: "live_set_tempo", arguments: "{\"bpm\":77}" } }] }
    : { role: "assistant", content: "Done!" };
}

// ---------- one ask ----------
type Call = { name: string; args: Record<string, unknown>; isError: boolean; malformed?: boolean };
async function runAsk(ask: Ask, tools: any[], system: string) {
  const checks = (PROFILE === "all" ? ask.all ?? ask.offline : ask.offline);
  if (ask.setup === "playing") await callTool("live_transport", { action: "play" });
  const before = await state();
  const messages: Msg[] = [{ role: "system", content: system }, { role: "user", content: ask.ask }];
  const model = MOCK_WRONG ? carelessModel() : ORACLE ? oracleModel(ask) : (m: Msg[]) => chat(m, tools);
  const calls: Call[] = []; const t0 = Date.now(); let firstMs: number | null = null; let reply = ""; let stopped: string | null = null;
  let empty = false, nudged = false, routedBy = "model";
  // The word rule (a client's first step): a clear change request goes straight to hand_to_stronger_model.
  const rule = WORD_RULE && !MOCK_WRONG ? wordRule(ask.ask) : null;
  if (rule) {
    routedBy = "word-rule";
    const r = await callTool("hand_to_stronger_model", { request: ask.ask, reason: rule });
    calls.push({ name: "hand_to_stronger_model", args: { request: ask.ask, reason: rule }, isError: r.isError });
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: "rule0", type: "function", function: { name: "hand_to_stronger_model", arguments: JSON.stringify({ request: ask.ask, reason: rule }) } }] },
      { role: "tool", tool_call_id: "rule0", name: "hand_to_stronger_model", content: r.text });
    reply = "(word rule) This needs the full Second Chair; your request is saved for when you're online.";
    firstMs = Date.now() - t0;
  }
  for (let turn = 0; !rule && turn < MAX_CALLS + 2; turn++) {
    const msg = await model(messages);
    if (firstMs === null) firstMs = Date.now() - t0;
    const tcs = msg.tool_calls ?? [];
    messages.push({ role: "assistant", content: msg.content ?? null, ...(tcs.length ? { tool_calls: tcs } : {}) });
    if (!tcs.length) {
      reply = stripThinking(String(msg.content ?? ""));
      // Qwen sometimes works the answer out in its thinking and then stops with nothing to say (the research chat saw it).
      if (!reply) {
        empty = true;
        if (NUDGE && !nudged) { nudged = true; messages.push({ role: "user", content: "You didn't write an answer. Please answer now, in a sentence or two." }); continue; }
      }
      break;
    }
    for (const tc of tcs) {
      let args: Record<string, unknown> = {}; let malformed = false;
      try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { malformed = true; }
      const last = calls[calls.length - 1];
      if (last && last.name === tc.function.name && JSON.stringify(last.args) === JSON.stringify(args)) stopped = "the same call twice in a row";
      if (calls.length >= MAX_CALLS) stopped = `more than ${MAX_CALLS} tool calls`;
      if (stopped) break;
      const r = malformed ? { text: "The arguments weren't valid JSON. Nothing was done.", isError: true } : await callTool(tc.function.name, args);
      calls.push({ name: tc.function.name, args, isError: r.isError, malformed });
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: r.text.slice(0, 6000) });
    }
    if (stopped) break;
  }
  const ms = Date.now() - t0;
  const after = await state();

  // the checks
  const fails: string[] = [];
  const names = calls.map((c) => c.name);
  if (checks.tool && !names.some((n) => checks.tool!.includes(n))) fails.push(`no call to ${checks.tool.join(" or ")}`);
  if (checks.first_tool && names[0] !== checks.first_tool) fails.push(`first call ${names[0] ?? "none"}, not ${checks.first_tool}`);
  if (checks.args) {
    const ok = calls.some((c) => c.name === checks.args!.name && !c.isError && Object.entries(checks.args!.match).every(([k, re]) => new RegExp(re, "i").test(String(c.args[k] ?? ""))));
    if (!ok) fails.push(`${checks.args.name} not called with ${JSON.stringify(checks.args.match)}`);
  }
  if (checks.reply && !new RegExp(checks.reply, "i").test(reply)) fails.push(`answer doesn't match /${checks.reply}/`);
  if (checks.hand_on && !names.includes("hand_to_stronger_model")) fails.push("didn't hand on");
  const st = checks.state;
  if (st?.tempo !== undefined && after.tempo !== st.tempo) fails.push(`tempo ${after.tempo}, not ${st.tempo}`);
  if (st?.playing !== undefined && after.playing !== st.playing) fails.push(`playing ${after.playing}, not ${st.playing}`);
  if (st?.track_count !== undefined && after.tracks.length !== st.track_count) fails.push(`${after.tracks.length} tracks, not ${st.track_count}`);
  if (st?.muted && after.tracks[st.muted[0]]?.mute !== st.muted[1]) fails.push(`track ${st.muted[0]} mute isn't ${st.muted[1]}`);
  if (st?.armed && after.tracks[st.armed[0]]?.armed !== st.armed[1]) fails.push(`track ${st.armed[0]} arm isn't ${st.armed[1]}`);
  if (st?.track_name && after.tracks[st.track_name[0]]?.name !== st.track_name[1]) fails.push(`track ${st.track_name[0]} isn't named ${st.track_name[1]}`);
  const changed = !sameSet(before, after);
  const wrongChange = changed && (checks.no_change || (!st && !["C"].includes(ask.group)));
  if (wrongChange) fails.push("the set changed when it shouldn't");
  if (stopped) fails.push(`stopped: ${stopped}`);
  if (!reply && !stopped) fails.push("no answer");

  // put the set back for the next ask
  if (after.playing) await callTool("live_transport", { action: "stop_all_clips" }).then(() => callTool("live_transport", { action: "stop" }));
  if (changed) await startFake();
  return { pass: fails.length === 0, fails, calls, reply, messages, ms, firstMs, wrongChange, refused: calls.filter((c) => c.isError).length, empty, nudged, routedBy };
}

// ---------- main ----------
await startFake();
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "second-chair-bench", version: "1" } });
const listed = (await rpc("tools/list")).result.tools as any[];
const tools = listed.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
const system = (await callTool("studio_guide", {})).text;
if (!ORACLE && !MODEL) {
  try { const r = await fetch(`${ENDPOINT}/models`); const j = await r.json() as any; MODEL = j.data?.[0]?.id ?? ""; }
  catch (e) { console.log(`No model server at ${ENDPOINT} (${(e as Error).message}). Start LM Studio's server (Developer tab, or "lms server start") or Ollama, load a model, or run with --oracle to check the harness.`); cleanup(); process.exit(2); }
  if (!MODEL) { console.log(`${ENDPOINT} has no model loaded. Load one in LM Studio (or pass --model).`); cleanup(); process.exit(2); }
}
const label = MOCK_WRONG ? "mock-wrong" : ORACLE ? "oracle" : MODEL;
const OUT = opt("out") ?? path.join(os.homedir(), "SecondChair", "bench", `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${label.replace(/[^\w.-]+/g, "_")}`);
fs.mkdirSync(OUT, { recursive: true });
const jsonl = path.join(OUT, "runs.jsonl");
const toolChars = JSON.stringify(tools).length;
if (WORD_RULE) console.log("Word rule on: asks it catches are handed on without the model.");
console.log(`Model: ${label}   endpoint: ${ORACLE ? "(scripted)" : ENDPOINT}   profile: ${PROFILE} (${tools.length} tools, about ${Math.round(toolChars / 3.8)} tokens)   asks: ${ASKS.length} x ${RUNS} runs`);

type Row = { id: string; group: string; passes: number; runs: number; wrong: number; empty: number; handOnRight: number; handOnWanted: number; calls: number[]; first: number[]; fails: string[] };
const rows: Row[] = [];
for (const ask of PART === "knowledge" ? [] : ASKS) {
  const row: Row = { id: ask.id, group: ask.group, passes: 0, runs: 0, wrong: 0, empty: 0, handOnRight: 0, handOnWanted: 0, calls: [], first: [], fails: [] };
  const checks = PROFILE === "all" ? ask.all ?? ask.offline : ask.offline;
  for (let run = 1; run <= RUNS; run++) {
    let r;
    try { r = await runAsk(ask, tools, system); }
    catch (e) { r = { pass: false, fails: [`error: ${(e as Error).message}`], calls: [], reply: "", messages: [], ms: 0, firstMs: null, wrongChange: false, refused: 0, empty: false, nudged: false, routedBy: "error" }; }
    row.runs++; if (r.pass) row.passes++; if (r.wrongChange) row.wrong++; if (r.empty) row.empty++;
    if (checks.hand_on) { row.handOnWanted++; if (r.calls.some((c: Call) => c.name === "hand_to_stronger_model")) row.handOnRight++; }
    row.calls.push(r.calls.length); if (r.firstMs !== null) row.first.push(r.firstMs);
    for (const f of r.fails) if (!row.fails.includes(f)) row.fails.push(f);
    fs.appendFileSync(jsonl, JSON.stringify({ at: new Date().toISOString(), source: SOURCE, model: label, endpoint: ORACLE ? null : ENDPOINT, profile: PROFILE,
      ask_id: ask.id, group: ask.group, run, pass: r.pass, fails: r.fails, wrong_change: r.wrongChange, refused_calls: r.refused,
      routed_by: r.routedBy, empty_answer: r.empty, nudged: r.nudged, ms: r.ms, first_ms: r.firstMs, tools: tools.map((t) => t.function.name), messages: r.messages }) + "\n");
  }
  rows.push(row);
  process.stdout.write(`${ask.id.padEnd(3)} ${row.passes === row.runs ? "pass" : "FAIL"} ${row.passes}/${row.runs}${row.fails.length ? "  " + row.fails.join("; ").slice(0, 150) : ""}\n`);
}

// ---------- knowledge questions (from the research chat's harness): no tools ----------
type Know = { choice: { id: string; area: string; q: string; options: string[]; answer: string }[]; open: { id: string; area: string; q: string; look_for: string[] }[] };
const knowledge: { choice: any[]; open: any[] } = { choice: [], open: [] };
if (PART !== "tools") {
  const K: Know = JSON.parse(fs.readFileSync(path.join(HERE, "bench_knowledge.json"), "utf8"));
  const kfile = path.join(OUT, "knowledge.jsonl");
  const letters = "ABCD";
  for (const q of K.choice) {
    let text = "", ms = 0, error = "";
    const t0 = Date.now();
    if (ORACLE) text = MOCK_WRONG ? "A" : q.answer;
    else try {
      const m = await chat([{ role: "system", content: "You are a music production tutor. Answer the multiple-choice question. Reply with one letter: A, B, C or D." },
        { role: "user", content: `${q.q}\n\n${q.options.map((o, i) => `${letters[i]}. ${o}`).join("\n")}\n\nReply with the letter only.` }], []);
      text = stripThinking(String(m.content ?? "")); ms = Date.now() - t0;
    } catch (e) { error = (e as Error).message; }
    const got = (text.match(/\b([ABCD])\b/) ?? [])[1] ?? "";
    const row = { id: q.id, area: q.area, want: q.answer, got, pass: got === q.answer, empty: !text, ms, error };
    knowledge.choice.push(row);
    fs.appendFileSync(kfile, JSON.stringify({ ...row, source: SOURCE, model: label, test_set_only: true, raw: text.slice(0, 300) }) + "\n");
  }
  for (const q of K.open) {
    let text = "", ms = 0, error = "";
    const t0 = Date.now();
    if (ORACLE) text = "(stand-in: no answer)";
    else try { const m = await chat([{ role: "system", content: system }, { role: "user", content: q.q }], []); text = stripThinking(String(m.content ?? "")); ms = Date.now() - t0; }
    catch (e) { error = (e as Error).message; }
    const points = q.look_for.filter((re) => new RegExp(re, "i").test(text)).length;
    const row = { id: q.id, area: q.area, q: q.q, points, of: q.look_for.length, ms, error, answer: text };
    knowledge.open.push(row);
    fs.appendFileSync(kfile, JSON.stringify({ ...row, source: SOURCE, model: label, test_set_only: true }) + "\n");
  }
  console.log("\nKnowledge (no tools; a test set, never training data)");
  for (const area of [...new Set(knowledge.choice.map((c) => c.area))]) {
    const cs = knowledge.choice.filter((c) => c.area === area);
    console.log(`${area.padEnd(13)} ${cs.filter((c) => c.pass).length}/${cs.length}`);
  }
  console.log(`Empty answers: ${knowledge.choice.filter((c) => c.empty).length}   open questions: ${knowledge.open.map((o) => `${o.id} ${o.points}/${o.of}`).join(", ")} (rough: points a good answer covers; a person should read them)`);
}

// ---------- summary ----------
const median = (xs: number[]) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;
const groups = [...new Set(rows.map((r) => r.group))].map((g) => {
  const rs = rows.filter((r) => r.group === g);
  return { group: g, asks: rs.length, passed: rs.filter((r) => r.passes === r.runs).length, rate: Math.round(100 * rs.filter((r) => r.passes === r.runs).length / rs.length) };
});
const wrong = rows.reduce((n, r) => n + r.wrong, 0);
const hw = rows.reduce((n, r) => n + r.handOnWanted, 0), hr = rows.reduce((n, r) => n + r.handOnRight, 0);
const summary = { model: label, source: SOURCE, profile: PROFILE, part: PART, runs_per_ask: RUNS, word_rule: WORD_RULE,
  empty_answers: rows.reduce((n, r) => n + r.empty, 0), nudge_empty: NUDGE,
  knowledge: knowledge.choice.length ? { choice_right: knowledge.choice.filter((c) => c.pass).length, choice_total: knowledge.choice.length,
    by_area: Object.fromEntries([...new Set(knowledge.choice.map((c) => c.area))].map((a) => [a, `${knowledge.choice.filter((c) => c.area === a && c.pass).length}/${knowledge.choice.filter((c) => c.area === a).length}`])),
    open_points: knowledge.open.map((o) => `${o.id} ${o.points}/${o.of}`) } : null, tools: tools.length, tool_tokens_about: Math.round(toolChars / 3.8), groups,
  wrong_changes: wrong, hand_on_right: hw ? `${hr}/${hw}` : "n/a", median_calls: median(rows.flatMap((r) => r.calls)),
  median_first_answer_ms: median(rows.flatMap((r) => r.first)), out: OUT,
  bar: "Balanced's local side needs: 95%+ on A, B and C, 0 wrong changes, 90%+ right hand-ons, a warm first answer within 5 s (research report, section 5)." };
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
console.log("\nGroup  passed");
for (const g of groups) console.log(`${g.group.padEnd(6)} ${g.passed}/${g.asks} (${g.rate}%)`);
if (rows.length) console.log(`Empty answers: ${summary.empty_answers}${NUDGE ? " (asked once more each time)" : ""}`);
console.log(`Wrong changes: ${wrong}   right hand-ons: ${summary.hand_on_right}   median calls: ${summary.median_calls}   median first answer: ${summary.median_first_answer_ms} ms`);
console.log(`Saved: ${OUT}`);
cleanup();
process.exit(0);
