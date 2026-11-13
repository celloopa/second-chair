// Calls one cello-live tool through a fresh copy of the MCP server, so a session that loaded an older server
// can still try new tools. Usage: node live-bridge\test\try_tool.ts live_show_on_keys "{\"chord\":\"Dm7\"}"
// From PowerShell 5.1, JSON with spaces gets split: put it in a file and pass @file.json, or pipe it in and pass -.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const [name, ...rest] = process.argv.slice(2);
let json = rest.join(" ") || "{}";
if (json === "-") json = readFileSync(0, "utf8");
else if (json.startsWith("@")) json = readFileSync(json.slice(1), "utf8");
if (!name) { console.error("Usage: node try_tool.ts <tool_name> [json-arguments]"); process.exit(2); }
const server = spawn(process.execPath, [path.join(import.meta.dirname, "..", "mcp", "server.ts")], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const waiting = new Map<number, (m: any) => void>();
server.stdout.on("data", (c) => {
  buf += c; let nl;
  while ((nl = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1); waiting.get(m.id)?.(m); }
});
let id = 0;
const rpc = (method: string, params?: unknown) => new Promise<any>((res) => { const i = ++id; waiting.set(i, res); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "try_tool", version: "0" } });
const r = await rpc("tools/call", { name, arguments: JSON.parse(json) });
console.log(r.result?.isError ? "ERROR: " : "", r.result?.content?.[0]?.text ?? JSON.stringify(r.error));
server.stdin.end();
process.exitCode = r.result?.isError || r.error ? 1 : 0;
