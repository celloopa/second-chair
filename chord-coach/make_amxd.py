import json, struct, sys

out = sys.argv[1]
W = 900.0  # device width in px

def box(id_, cls, rect, text=None, nin=1, nout=1, **extra):
    b = {"id": id_, "maxclass": cls, "numinlets": nin, "numoutlets": nout, "patching_rect": rect}
    if nout:
        b["outlettype"] = [""] * nout
    if text is not None:
        b["text"] = text
    b.update(extra)
    return {"box": b}

def line(src, so, dst, di):
    return {"patchline": {"source": [src, so], "destination": [dst, di]}}

boxes = [
    box("obj-1", "newobj", [20.0, 20.0, 45.0, 22.0], "midiin", 1, 1),
    box("obj-2", "newobj", [20.0, 360.0, 55.0, 22.0], "midiout", 1, 0),
    box("obj-3", "newobj", [120.0, 60.0, 90.0, 22.0], "midiparse", 1, 8),
    box("obj-4", "newobj", [120.0, 95.0, 80.0, 22.0], "prepend note", 1, 1),
    box("obj-5", "jsui", [120.0, 140.0, W, 169.0], None, 1, 2,
        filename="chordcoach.js", parameter_enable=0,
        presentation=1, presentation_rect=[0.0, 0.0, W, 169.0]),
    box("obj-6", "newobj", [120.0, 325.0, 110.0, 22.0], "midiformat", 7, 1),
    box("obj-7", "newobj", [420.0, 20.0, 60.0, 22.0], "loadmess 1", 1, 1),
    box("obj-8", "newobj", [420.0, 50.0, 70.0, 22.0], "qmetro 60", 2, 1),
    box("obj-9", "newobj", [420.0, 80.0, 70.0, 22.0], "transport", 2, 9),
    box("obj-10", "newobj", [420.0, 110.0, 75.0, 22.0], "prepend bar", 1, 1),
    box("obj-11", "comment", [240.0, 20.0, 170.0, 20.0], "MIDI passes straight through", 1, 0),
    # CelloBridge link (loopback OSC): held notes and a heartbeat out, "show these notes" in
    box("obj-12", "newobj", [560.0, 325.0, 140.0, 22.0], "udpsend 127.0.0.1 9886", 1, 0),
    box("obj-13", "newobj", [560.0, 95.0, 100.0, 22.0], "udpreceive 9887", 1, 1),
    box("obj-14", "comment", [560.0, 70.0, 260.0, 20.0], "CelloBridge: /cc/show and /cc/clear in, /cc/note and /cc/hello out", 1, 0),
]
lines = [
    line("obj-1", 0, "obj-2", 0),   # pass-through
    line("obj-1", 0, "obj-3", 0),
    line("obj-3", 0, "obj-4", 0),
    line("obj-4", 0, "obj-5", 0),
    line("obj-5", 0, "obj-6", 0),   # chord preview
    line("obj-6", 0, "obj-2", 0),
    line("obj-7", 0, "obj-8", 0),
    line("obj-8", 0, "obj-9", 0),
    line("obj-9", 0, "obj-10", 0),
    line("obj-10", 0, "obj-5", 0),
    line("obj-5", 1, "obj-12", 0),  # notes and heartbeat to the bridge
    line("obj-13", 0, "obj-5", 0),  # show / clear from the bridge
]

patcher = {"patcher": {
    "fileversion": 1,
    "appversion": {"major": 9, "minor": 0, "revision": 0, "architecture": "x64", "modernui": 1},
    "classnamespace": "box",
    "rect": [100.0, 100.0, 960.0, 480.0],
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
    "description": "Shows the E Dorian interlude chords (or one Claude sends) on the MPK mini IV, guitar and bass, names what you play, and reports it to CelloBridge.",
    "digest": "",
    "tags": "",
    "style": "",
    "boxes": boxes,
    "lines": lines,
    "dependency_cache": [{"name": "chordcoach.js", "bootpath": "", "type": "TEXT", "implicit": 1}],
    "latency": 0,
    "is_mpe": 0,
    "minimum_live_version": "",
    "minimum_max_version": "",
    "platform_compatibility": 0,
    "autosave": 0,
}}

body = json.dumps(patcher, indent="\t").encode("utf-8") + b"\n\x00"
header = b"ampf" + struct.pack("<I", 4) + b"mmmm" + b"meta" + struct.pack("<I", 4) + b"\x00\x00\x00\x00" + b"ptch" + struct.pack("<I", len(body))
with open(out, "wb") as f:
    f.write(header + body)
print("wrote", out, len(header + body), "bytes")
