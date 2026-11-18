// Message boxes Live wrote to its Log.txt since it last started ("info: Message Box: <text>"). This works even
// before the Second Chair script loads (a crash-recovery question at startup, for example). The log never says
// when a box closes, so these are history: whether one is open now comes from Live's API (Remote Script 0.11.0+).
import fs from "node:fs";
import { liveLog } from "./menu.ts";

export type LogBox = { at: string; seconds_ago: number | null; text: string };

const TAIL = 2 << 20; // read at most the last 2 MB
let lastSeen = ""; // the newest box's timestamp at the last look

function readTail(file: string): string {
  const size = fs.statSync(file).size;
  const n = Math.min(size, TAIL);
  const fd = fs.openSync(file, "r");
  try { const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); return buf.toString("utf8"); } finally { fs.closeSync(fd); }
}

function secondsAgo(at: string): number | null {
  const t = new Date(at.slice(0, 23)).getTime(); // Live writes local time with microseconds; Date wants milliseconds
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
}

/** Message boxes since Live last started (newest last, at most `max`), and which of them are new since the last call. */
export function logMessageBoxes(max = 5): { since_live_started: LogBox[]; new_since_last_look: LogBox[] } {
  const file = liveLog();
  if (!file) return { since_live_started: [], new_since_last_look: [] };
  let text: string;
  try { text = readTail(file); } catch { return { since_live_started: [], new_since_last_look: [] }; }
  const lines = text.split(/\r?\n/);
  let from = 0;
  lines.forEach((l, i) => { if (/: info: Started: Live /.test(l)) from = i; });
  const boxes: LogBox[] = [];
  for (const l of lines.slice(from)) {
    const m = /^(\S+?):\s+\w+:\s+Message Box:\s*(.*)$/.exec(l);
    if (m) boxes.push({ at: m[1], seconds_ago: secondsAgo(m[1]), text: m[2].slice(0, 400) });
  }
  const fresh = boxes.filter((b) => b.at > lastSeen);
  if (boxes.length) lastSeen = boxes[boxes.length - 1].at;
  return { since_live_started: boxes.slice(-max), new_since_last_look: fresh.slice(-max) };
}
