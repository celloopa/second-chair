# Builds "Second Chair Ears.amxd", a Max for Live AUDIO EFFECT, without opening Max.
# Same method as chord-coach/make_amxd.py: write the patcher as JSON and wrap it in the .amxd header.
#
#   python ears/make_amxd.py "ears/Second Chair Ears.amxd"
#
# The patch passes audio straight through and measures a copy of it:
#   peak (left, right), RMS (left, right) and RMS in 8 octave bands of the mono sum.
# ears.js turns those into dB and sends them to the SecondChair Remote Script on UDP 9888.
import json, struct, sys

out = sys.argv[1] if len(sys.argv) > 1 else "Second Chair Ears.amxd"
W = 230.0            # device width in px
PORT = 9888          # must match EARS_PORT in the Remote Script
REPORT_MS = 250      # how often each reading is taken
RMS_SAMPLES = 12000  # average~ window: about a quarter second at 44.1 or 48 kHz
BAND_HZ = [63, 125, 250, 500, 1000, 2000, 4000, 8000]  # must match EARS_BANDS in mcp/server.ts
BAND_Q = 1.4         # about an octave wide, so the bands overlap a little

boxes, lines = [], []
count = [0]

def box(cls, rect, text=None, nin=1, nout=1, outs=None, **extra):
    count[0] += 1
    id_ = "obj-%d" % count[0]
    b = {"id": id_, "maxclass": cls, "numinlets": nin, "numoutlets": nout, "patching_rect": rect}
    if nout:
        b["outlettype"] = outs or [""] * nout
    if text is not None:
        b["text"] = text
    b.update(extra)
    boxes.append({"box": b})
    return id_

def obj(text, x, y, nin=1, nout=1, outs=None):
    return box("newobj", [x, y, 8.0 + 6.5 * len(text), 22.0], text, nin, nout, outs)

def line(src, so, dst, di=0):
    lines.append({"patchline": {"source": [src, so], "destination": [dst, di]}})

def reading(src, outlet, x, y, label):
    """signal -> RMS over a window -> a float every REPORT_MS -> "<label> <value>" into the js."""
    avg = obj("average~ %d rms" % RMS_SAMPLES, x, y, 1, 1, ["signal"])
    snap = obj("snapshot~ %d" % REPORT_MS, x, y + 30, 2, 1, ["float"])
    pre = obj("prepend %s" % label, x, y + 60)
    line(src, outlet, avg); line(avg, 0, snap); line(snap, 0, pre); line(pre, 0, JS)

audio_in = obj("plugin~", 20, 20, 2, 2, ["signal", "signal"])
audio_out = obj("plugout~", 20, 520, 2, 2, ["signal", "signal"])
line(audio_in, 0, audio_out, 0)  # pass-through, untouched
line(audio_in, 1, audio_out, 1)

JS = box("newobj", [20.0, 440.0, 60.0, 22.0], "js ears.js", 1, 1, saved_object_attributes={"filename": "ears.js", "parameter_enable": 0})
send = obj("udpsend 127.0.0.1 %d" % PORT, 20, 475, 1, 0)
line(JS, 0, send)

ready = obj("live.thisdevice", 20, 400, 1, 3, ["bang", "int", "int"])
line(ready, 0, JS)  # the Live API can only be used after this bang

for ch in (0, 1):
    peak = obj("peakamp~ %d" % REPORT_MS, 150 + 130 * ch, 60, 2, 1, ["float"])
    pre = obj("prepend pk %d" % ch, 150 + 130 * ch, 90)
    line(audio_in, ch, peak); line(peak, 0, pre); line(pre, 0, JS)
    reading(audio_in, ch, 420 + 150 * ch, 60, "rms %d" % ch)

mix = obj("+~", 150, 180, 2, 1, ["signal"])
half = obj("*~ 0.5", 150, 210, 2, 1, ["signal"])
line(audio_in, 0, mix, 0); line(audio_in, 1, mix, 1); line(mix, 0, half)
n = len(BAND_HZ)
bank = obj("fffb~ %d %d 2. %s" % (n, BAND_HZ[0], BAND_Q), 150, 250, 1, n, ["signal"] * n)
line(half, 0, bank)
for i in range(n):
    reading(bank, i, 150 + 150 * i, 290, "band %d" % i)

box("comment", [150.0, 20.0, 600.0, 20.0],
    "Second Chair Ears: audio passes straight through. A copy is measured and /ears/levels goes to SecondChair on UDP %d." % PORT, 1, 0)
box("comment", [20.0, 560.0, W - 16.0, 20.0], "Second Chair Ears", 1, 0,
    fontsize=13.0, presentation=1, presentation_rect=[8.0, 8.0, W - 16.0, 22.0])
box("comment", [20.0, 585.0, W - 16.0, 60.0],
    "Listening. Reports this track's level and tone to Second Chair. The sound is not changed.", 1, 0,
    linecount=3, presentation=1, presentation_linecount=3, presentation_rect=[8.0, 36.0, W - 16.0, 60.0])

patcher = {"patcher": {
    "fileversion": 1,
    "appversion": {"major": 9, "minor": 0, "revision": 0, "architecture": "x64", "modernui": 1},
    "classnamespace": "box",
    "rect": [100.0, 100.0, 1400.0, 720.0],
    "openrect": [0.0, 0.0, W, 169.0],
    "bglocked": 0,
    "openinpresentation": 1,
    "default_fontsize": 10.0,
    "default_fontface": 0,
    "default_fontname": "Arial Bold",
    "gridonopen": 1,
    "gridsize": [8.0, 8.0],
    "gridsnaponopen": 1,
    "objectsnaponopen": 1,
    "statusbarvisible": 2,
    "toolbarvisible": 1,
    "devicewidth": W,
    "description": "Measures the audio passing through (peak, RMS and 8 bands) and reports it to SecondChair. The sound is not changed.",
    "digest": "",
    "tags": "",
    "style": "",
    "boxes": boxes,
    "lines": lines,
    "dependency_cache": [{"name": "ears.js", "bootpath": "", "type": "TEXT", "implicit": 1}],
    "latency": 0,
    "is_mpe": 0,
    "minimum_live_version": "",
    "minimum_max_version": "",
    "platform_compatibility": 0,
    "autosave": 0,
}}

body = json.dumps(patcher, indent="\t").encode("utf-8") + b"\n\x00"
# "aaaa" marks an audio effect (Chord Coach uses "mmmm", a MIDI effect).
header = b"ampf" + struct.pack("<I", 4) + b"aaaa" + b"meta" + struct.pack("<I", 4) + b"\x00\x00\x00\x00" + b"ptch" + struct.pack("<I", len(body))
with open(out, "wb") as f:
    f.write(header + body)
print("wrote", out, len(header + body), "bytes,", len(boxes), "boxes,", len(lines), "cords")
