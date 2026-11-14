// Read-only check of the SecondChair socket: sends `ping` and `get_session` over 127.0.0.1:9885 with the token
// from ~/SecondChair/token (same lookup as second-chair: APPDATA || HOME). Never prints the token.
// Usage: node mac/probe.ts
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const PORT = Number(process.env.SECOND_CHAIR_PORT || 9885);
const token = fs.readFileSync(path.join(process.env.APPDATA || process.env.HOME || ".", "SecondChair", "token"), "utf8").trim();

function call(id: number, action: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: PORT });
    let buf = "";
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error(`${action}: timed out`)); });
    sock.on("connect", () => sock.write(JSON.stringify({ id, token, action, params: {} }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) { sock.destroy(); resolve(JSON.parse(buf.slice(0, nl))); }
    });
    sock.on("error", reject);
  });
}

const ping = await call(1, "ping");
console.log("ping ->", JSON.stringify(ping));
const s = await call(2, "get_session");
if (!s.ok) { console.log("get_session ->", JSON.stringify(s)); process.exit(1); }
const r = s.result;
console.log("get_session -> ok:", s.ok, "| tempo", r.tempo, "| signature", r.signature.join("/"),
  "| tracks", r.tracks.length, `(${r.tracks.map((t: any) => `${t.index}:${t.name}[${t.kind}]`).join(", ")})`,
  "| scenes", r.scenes.length, "| playing", r.is_playing);
