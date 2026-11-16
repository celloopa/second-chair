// Second Chair Ears - the js inside the Second Chair Ears Max for Live audio effect.
// It collects level readings from the patch, works out which track the device sits on, and reports about
// 4 times a second to the SecondChair Remote Script. It never changes the audio or the Live set.
// Inputs:  "bang" from live.thisdevice (the Live API is ready),
//          "pk <0|1> <linear peak>" from peakamp~ (left, right),
//          "rms <0|1> <linear rms>" and "band <0-7> <linear rms>" from average~ and snapshot~.
// Outlet:  "/ears/levels <device id> <track|return|main> <index> <peak dB> <rms dB> <band dB> x 8"
//          to the bridge (udpsend 127.0.0.1 9888).
// Old-style JavaScript only (Max's js engine): var, function, no arrows or template strings.

autowatch = 1;
inlets = 1;
outlets = 1;

var BANDS = 8;
var FLOOR_DB = -120;
var SEND_MS = 250;
var WHERE_MS = 2000; // look up the track again this often, so moving the device or reordering tracks is noticed

var peaks = [0, 0];
var rmss = [0, 0];
var bands = [0, 0, 0, 0, 0, 0, 0, 0];
var ready = false;
var devId = 0;
var kind = "";
var index = -1;
var sinceWhere = WHERE_MS;

function toDb(x) {
  if (!(x > 0.000001)) return FLOOR_DB;
  return Math.round(200 * Math.log(x) / Math.LN10) / 10; // 20 * log10, to one decimal
}

// "live_set tracks 2 devices 0", "live_set return_tracks 0 devices 1 chains 0 devices 2", "live_set master_track devices 0"
function where() {
  kind = ""; index = -1;
  try {
    var api = new LiveAPI("this_device");
    devId = parseInt(api.id, 10) || 0;
    var path = String(api.unquotedpath);
    var m = /^live_set (tracks|return_tracks) (\d+) /.exec(path);
    if (m) { kind = m[1] === "tracks" ? "track" : "return"; index = parseInt(m[2], 10); }
    else if (/^live_set master_track /.test(path)) { kind = "main"; index = 0; }
  } catch (e) { /* not ready yet: try again on the next round */ }
}

function send() {
  if (!ready) return;
  sinceWhere += SEND_MS;
  if (sinceWhere >= WHERE_MS) { sinceWhere = 0; where(); }
  if (!kind) return;
  var msg = ["/ears/levels", devId, kind, index,
    toDb(Math.max(peaks[0], peaks[1])),
    toDb(Math.sqrt((rmss[0] * rmss[0] + rmss[1] * rmss[1]) / 2))];
  for (var i = 0; i < BANDS; i++) msg.push(toDb(bands[i]));
  outlet(0, msg);
}
var sender = new Task(send, this);
sender.interval = SEND_MS;

// ---- messages from the patch ----
function bang() { ready = true; sinceWhere = WHERE_MS; sender.repeat(); }
function pk(ch, v) { if (ch === 0 || ch === 1) peaks[ch] = Math.abs(v); }
function rms(ch, v) { if (ch === 0 || ch === 1) rmss[ch] = Math.abs(v); }
function band(i, v) { if (i >= 0 && i < BANDS) bands[i] = Math.abs(v); }
function notifydeleted() { sender.cancel(); }
