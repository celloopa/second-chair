# SecondChair: an Ableton Live Remote Script that exposes a small, fixed set of
# actions over a loopback TCP socket, for the second-chair MCP server.
#
# Safety:
# - Listens on 127.0.0.1 only.
# - Every request must carry the token stored in %APPDATA%\SecondChair\token.
# - Only the actions in ACTIONS run. Nothing executes code sent by a client.
# - Nothing deletes tracks or clips; mistakes are reverted with the "undo" action
#   (Live's own undo).
#
# Protocol: one JSON object per line.
#   request:  {"id": 1, "token": "...", "action": "get_session", "params": {}}
#   response: {"id": 1, "ok": true, "result": {...}}  or  {"id": 1, "ok": false, "error": "..."}

from __future__ import absolute_import

import json
import math
import os
import queue
import random
import re
import socket
import struct
import threading
import time
import types
from collections import deque

import Live
from _Framework.ControlSurface import ControlSurface

VERSION = "0.9.8"
HOST = "127.0.0.1"
PORT = 9885
OSC_IN_PORT = 9886    # Chord Coach device -> bridge
OSC_OUT_PORT = 9887   # bridge -> Chord Coach device
DEVICE_ALIVE_MS = 6000
EVENT_WINDOW_MS = 30000
MAX_EVENTS = 256
MAX_SHOW_NOTES = 25
MAX_LABEL = 40
MAX_LINE = 1000000
MAX_NOTES = 4096

ACTIONS = (
    "ping", "get_session", "get_track", "get_clip_notes",
    "create_midi_clip", "add_notes", "set_tempo", "set_scale",
    "play", "stop", "fire_clip", "stop_track", "fire_scene",
    "arm_track", "create_midi_track", "select_track", "undo",
    "show_on_keys", "clear_keys", "get_played",
    "browse", "load_device", "build_drum_kit",
    "get_device_params", "set_device_param",
    "list_tree", "swap_pad_sample", "get_routing", "set_routing", "revert",
    "load_sample", "get_simpler", "set_simpler", "set_audio_clip", "delete_track",
    "stop_all_clips", "back_to_arrangement", "set_record", "jump_to_bar",
    "get_arrangement", "place_clip", "duplicate_track", "rename_track", "rename_scene", "automate",
    "move_device", "delete_device", "get_levels", "copy_clip", "move_arrangement_clip", "delete_arrangement_clip",
    "record_automation", "read_knob", "play_range", "bounce_track",
    "create_audio_track", "create_return_track", "set_monitoring",
    "audio_clip_info", "align_audio",
)
# Actions that take several of Live's display ticks (browser loads finish on a later tick) get longer to answer.
MONITOR_VALUES = {"in": 0, "auto": 1, "off": 2}  # Live's Track.monitoring_states
MONITOR_NAMES = {0: "in", 1: "auto", 2: "off"}
MAX_RECORD_SECONDS = 280.0
MIN_LFO_SECONDS = 0.8  # a recorded wobble needs about 8 display ticks per cycle to come out clean
CURVES = {"linear": lambda x: x, "ease_in": lambda x: x * x, "ease_out": lambda x: 1 - (1 - x) * (1 - x),
          "s": lambda x: x * x * (3 - 2 * x), "step": lambda x: 1.0 if x >= 1.0 else 0.0}
LFO_SHAPES = ("sine", "triangle", "square", "saw_up", "saw_down", "random")
ACTION_WAIT = {"get_levels": 9.0, "read_knob": 15.0, "play_range": MAX_RECORD_SECONDS + 30.0, "bounce_track": MAX_RECORD_SECONDS + 40.0, "record_automation": MAX_RECORD_SECONDS + 30.0, "load_sample": 18.0, "browse": 18.0, "list_tree": 18.0, "load_device": 18.0, "build_drum_kit": 45.0, "swap_pad_sample": 18.0}
DEFAULT_WAIT = 10.0


# ---- minimal OSC 1.0 (messages only): address, ",tags", then big-endian args, all padded to 4 bytes ----

def _osc_pad(b):
    return b + b"\0" * (4 - len(b) % 4)  # always at least one null, then pad to a multiple of 4


def osc_encode(address, args=()):
    tags = ","
    body = b""
    for a in args:
        if isinstance(a, bool):
            raise ValueError("OSC: booleans are not supported")
        if isinstance(a, int):
            tags += "i"
            body += struct.pack(">i", a)
        elif isinstance(a, float):
            tags += "f"
            body += struct.pack(">f", a)
        elif isinstance(a, str):
            tags += "s"
            body += _osc_pad(a.encode("utf-8"))
        else:
            raise ValueError("OSC: unsupported argument type %s" % type(a).__name__)
    return _osc_pad(address.encode("utf-8")) + _osc_pad(tags.encode("ascii")) + body


def _osc_read_str(data, pos):
    end = data.index(b"\0", pos)
    text = data[pos:end].decode("utf-8")
    return text, (end + 4) & ~3  # skip the null and the padding


def osc_decode(data):
    """Returns (address, [args]). Raises ValueError on anything malformed. A message with no type tag string has no args."""
    try:
        if not data or data[:1] != b"/":
            raise ValueError("OSC: address must start with /")
        address, pos = _osc_read_str(data, 0)
        if pos >= len(data) or data[pos:pos + 1] != b",":
            return address, []
        tags, pos = _osc_read_str(data, pos)
        args = []
        for t in tags[1:]:
            if t == "i":
                args.append(struct.unpack(">i", data[pos:pos + 4])[0])
                pos += 4
            elif t == "f":
                args.append(struct.unpack(">f", data[pos:pos + 4])[0])
                pos += 4
            elif t == "s":
                text, pos = _osc_read_str(data, pos)
                args.append(text)
            else:
                raise ValueError("OSC: unsupported type tag %r" % t)
        return address, args
    except ValueError:
        raise
    except Exception as e:
        raise ValueError("OSC: malformed message (%s)" % e)


# ---- browser helpers (plain functions; only called on Live's main thread) ----

# Tree names in the protocol -> Live's Browser attributes. "places" is the folders added under Places.
BROWSER_TREES = {
    "instruments": "instruments", "drums": "drums", "audio_effects": "audio_effects",
    "midi_effects": "midi_effects", "sounds": "sounds", "samples": "samples", "plugins": "plugins",
    "max_for_live": "max_for_live", "user_library": "user_library", "places": "user_folders",
}
TREE_KIND = {"instruments": "instrument", "drums": "instrument", "sounds": "instrument",
             "audio_effects": "audio_effect", "midi_effects": "midi_effect"}
DEVICE_SEARCH = ("audio_effects", "midi_effects", "instruments")
WALK_CHUNK = 400     # items looked at per tick while searching
MAX_VISIT = 30000    # stop a search after this many items
MAX_LIST = 5000      # most item paths list_tree returns in one answer
LOAD_TICKS = 30      # ticks (about 100 ms each) to wait for a load to appear
MAX_PADS = 16
FIRST_PAD = 36       # C1 in Live's naming; most pad controllers' first eight pads send 36-43
NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


class _Places(object):
    """Stands in for a tree root whose children are the Places folders."""
    name = "places"
    is_folder = True
    is_loadable = False

    def __init__(self, browser):
        self.children = list(getattr(browser, "user_folders", ()) or ())


def _children(item):
    try:
        return list(item.children)
    except Exception:
        return []


def _item_name(item):
    try:
        return str(item.name)
    except Exception:
        return ""


def _hidden(name):
    return not name or name.lower().endswith(".asd")  # Live's analysis files


def _is_folder(item):
    return bool(getattr(item, "is_folder", False)) or (bool(getattr(item, "is_device", False)) and bool(_children(item)))


def _loadable(item):
    return bool(getattr(item, "is_loadable", False))


def _split_path(path):
    if isinstance(path, (list, tuple)):
        parts = [str(p) for p in path]
    else:
        parts = str(path).replace("\\", "/").split("/")
    return [p.strip() for p in parts if p.strip()]


def _stem(name):
    n = name.strip().lower()
    base, dot, ext = n.rpartition(".")
    return base if dot and base and 1 <= len(ext) <= 5 and " " not in ext else n


def _same_name(a, b):
    return a.strip().lower() == b.strip().lower() or _stem(a) == _stem(b)


def _natural_key(name):
    key, num = [], ""
    for ch in name.lower():
        if ch.isdigit():
            num += ch
        else:
            if num:
                key.append((0, int(num), ""))
                num = ""
            key.append((1, 0, ch))
    if num:
        key.append((0, int(num), ""))
    return key


def _item_info(item, path):
    return {"name": path[-1], "path": "/".join(path), "loadable": _loadable(item),
            "folder": bool(getattr(item, "is_folder", False)), "device": bool(getattr(item, "is_device", False))}


def _safe(fn, default):
    """Live raises RuntimeError (not AttributeError) for clip properties on return tracks and Main,
    so getattr's default never applies there. Real Live 12.4.16 on the Mac, 2026-11-12."""
    try:
        return fn()
    except Exception:
        return default


def _slots(t):
    """A track's clip slots, or [] on return tracks and Main ("Main and Return Tracks have no Clips")."""
    return _safe(lambda: list(t.clip_slots), [])


def _arr(t):
    """A track's Arrangement clips, or [] on return tracks and Main."""
    return _safe(lambda: list(t.arrangement_clips or ()), [])


def _dev_name(d):
    try:
        return str(d.name)
    except Exception:
        return "a device"


def _is_instrument(d):
    if getattr(d, "can_have_drum_pads", False):
        return True
    try:
        return d.type == Live.Device.DeviceType.instrument
    except Exception:
        return False


def _instrument_of(track):
    for d in track.devices:
        if _is_instrument(d):
            return d
    return None


def _set_db(param, db):
    """Sets a volume to a level in dB (Live's volume value isn't linear in dB). Returns the text set, or None."""
    try:
        param.value = _set_by_text(param, "%g dB" % db)
        return _param_text(param)
    except Exception:
        return None


def _pick(things, wanted, name_of, what, where):
    """One item by name: an exact match (any case) first, then the only name that contains the words."""
    w = wanted.strip().lower()
    exact = [x for x in things if name_of(x).strip().lower() == w]
    if exact:
        return exact[0]
    words = w.split()
    part = [x for x in things if all(word in name_of(x).lower() for word in words)]
    if len(part) == 1:
        return part[0]
    names = ", ".join(name_of(x) for x in (part or things)[:40])
    if part:
        raise ValueError("%r matches more than one %s %s: %s" % (wanted, what, where, names))
    raise ValueError("no %s called %r %s. There are: %s" % (what, wanted, where, names))


def _number_of(text):
    """Reads a parameter's display text ("-6.0 dB", "30 %", "1.20 kHz", "250 ms", "1.5 s", "1/16") as one comparable
    number: kHz becomes Hz, seconds become ms, a note length like 1/16 becomes 0.0625. Returns None for text with
    no number ("Off", "Hall")."""
    t = str(text).strip().lower().replace(",", ".")
    if "inf" in t:
        return float("-inf") if "-" in t else float("inf")
    num, i = "", 0
    while i < len(t) and t[i] in " +":
        i += 1
    if i < len(t) and t[i] == "-":
        num, i = "-", i + 1
    while i < len(t) and (t[i].isdigit() or t[i] == "."):
        num += t[i]
        i += 1
    if num in ("", "-", ".", "-."):
        return None
    try:
        v = float(num)
    except ValueError:
        return None
    if i < len(t) and t[i] == "/":
        den, j = "", i + 1
        while j < len(t) and t[j].isdigit():
            den += t[j]
            j += 1
        if den and float(den) != 0:
            v, i = v / float(den), j
    unit = t[i:].strip()
    if unit.startswith("k"):
        v *= 1000.0
    elif unit == "s" or unit.startswith("s ") or unit == "sec":
        v *= 1000.0
    return v


def _param_text(p, value=None):
    try:
        return str(p.str_for_value(p.value if value is None else value))
    except Exception:
        try:
            return str(p)
        except Exception:
            return ""


def _param_info(i, p):
    info = {"index": i, "name": str(p.name), "value": float(p.value), "min": float(p.min), "max": float(p.max),
            "shown_as": _param_text(p)}
    if getattr(p, "is_quantized", False):
        items = [str(x) for x in (getattr(p, "value_items", ()) or ())]
        if items:
            info["choices"] = items
    if not getattr(p, "is_enabled", True):
        info["locked"] = True
    return info


def _set_by_text(p, target):
    """Finds the value whose display text reads target (a number with a unit, like "-6 dB" or "1.2 kHz") by
    searching the parameter's range. Display text is monotonic for Live's knobs; the direction is checked."""
    want = _number_of(target)
    if want is None:
        raise ValueError("couldn't read a number in %r" % target)
    lo, hi = float(p.min), float(p.max)
    at_lo, at_hi = _number_of(_param_text(p, lo)), _number_of(_param_text(p, hi))
    if at_lo is None or at_hi is None:
        raise ValueError("%s doesn't show a number, so give value or percent instead" % p.name)
    if lo != hi and _param_text(p, lo) == _param_text(p, hi):
        # Plugins (VST/AU) only show their current setting: str_for_value ignores the value it's given, so a search
        # would run off one end of the range. Refuse rather than set the wrong end.
        raise ValueError("%s only shows its current setting (plugin knobs work this way), so a text target can't be "
                         "matched. Read its range with live_get_device and give percent (0-100) or value instead" % p.name)
    rising = at_hi >= at_lo
    if want <= min(at_lo, at_hi):
        return lo if rising else hi
    if want >= max(at_lo, at_hi):
        return hi if rising else lo
    for _ in range(50):
        mid = (lo + hi) / 2.0
        got = _number_of(_param_text(p, mid))
        if got is None:
            break
        if (got < want) == rising:
            lo = mid
        else:
            hi = mid
    a, b = _number_of(_param_text(p, lo)), _number_of(_param_text(p, hi))
    return lo if a is not None and b is not None and abs(a - want) < abs(b - want) else hi


def _step_with_text(p, target):
    """For a knob with whole-number steps and no named choices (Echo's synced times show 1/64 ... 1/1 for -6 ... 0),
    the step whose display text reads exactly target, or None."""
    lo, hi = float(p.min), float(p.max)
    if lo != int(lo) or hi != int(hi) or not (0 < hi - lo <= 256):
        return None
    want = str(target).strip().lower().replace(" ", "")
    for v in range(int(lo), int(hi) + 1):
        if _param_text(p, float(v)).strip().lower().replace(" ", "") == want:
            return float(v)
    return None


def _is_plugin(d):
    """VST and AU plugins. Their parameters only show the current setting, and only a moment after it changes."""
    return "plugin" in str(getattr(d, "class_name", "")).lower()


def _rname(x):
    """A routing type's or channel's name as Live's choosers show it."""
    return str(getattr(x, "display_name", x))


def _choose_route(options, wanted, what):
    """One routing choice by name: exact (ignoring case) first, then the one choice that holds every word."""
    want = str(wanted).strip().lower()
    hit = [o for o in options if _rname(o).strip().lower() == want]
    if not hit:
        words = [w for w in want.replace("|", " ").split() if w]
        hit = [o for o in options if words and all(w in _rname(o).lower() for w in words)]
    if len(hit) == 1:
        return hit[0]
    names = ", ".join(_rname(o) for o in options[:60])
    if hit:
        raise ValueError("%r matches more than one %s: %s" % (wanted, what, ", ".join(_rname(o) for o in hit)))
    raise ValueError("no %s called %r. The choices are: %s" % (what, wanted, names or "none"))


# Routing endpoints: (attribute for the list of types, current type, list of channels, current channel).
TRACK_INPUT = ("available_input_routing_types", "input_routing_type", "available_input_routing_channels", "input_routing_channel")
TRACK_OUTPUT = ("available_output_routing_types", "output_routing_type", "available_output_routing_channels", "output_routing_channel")
DEVICE_IO = ("available_routing_types", "routing_type", "available_routing_channels", "routing_channel")


def _route_info(obj, attrs):
    types_a, type_a, chans_a, chan_a = attrs
    return {"from": _rname(getattr(obj, type_a)), "channel": _rname(getattr(obj, chan_a)),
            "choices": [_rname(x) for x in getattr(obj, types_a)],
            "channel_choices": [_rname(x) for x in getattr(obj, chans_a)]}


def _note_name(n):
    return "%s%d" % (NOTE_NAMES[n % 12], n // 12 - 2)  # Live's naming: 36 = C1, 60 = C3


def _note_from_name(text):
    """"D1" -> 38, "F#1" -> 42, "Bb0" -> 34 (Live's naming, 36 = C1). None if it isn't a note name."""
    t = text.strip()
    if len(t) < 2 or t[0].upper() not in "CDEFGAB":
        return None
    pc = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[t[0].upper()]
    rest = t[1:]
    if rest[:1] == "#":
        pc, rest = pc + 1, rest[1:]
    elif rest[:1] == "b":
        pc, rest = pc - 1, rest[1:]
    try:
        octave = int(rest)
    except ValueError:
        return None
    n = (octave + 2) * 12 + pc
    return n if 0 <= n <= 127 else None


def _simpler_file(simpler):
    try:
        smp = simpler.sample
        return str(smp.file_path) if smp is not None else ""
    except Exception:
        return ""


def _file_name(file_path):
    return file_path.replace("\\", "/").rsplit("/", 1)[-1]


# ---- the bridge's own change list, so live_revert can take back just the bridge's changes ----
#
# Live's undo is global: it takes back whatever happened last, the user's edits included. So each action that changes
# the set records what it did (one "change", made of one or more parts). Reverting looks at each part first:
#   "left"    - still as the bridge left it, so it can be put back;
#   "back"    - already back the way it was (live_undo, or the user put it back), so nothing to do;
#   "changed" - someone changed it since, so the revert stops and says what, without touching anything.
# The list lives in memory: it starts empty each time Live starts, and only covers this Live session.

MAX_JOURNAL = 100


def _gone(fn):
    """Runs fn; a Live object that was deleted raises, which counts as gone."""
    try:
        return fn(), False
    except Exception:
        return None, True


class _Attrs(object):
    """Plain properties: tempo, scale, a track's name or arm, a parameter's value."""
    def __init__(self, obj, label, changes, close=None):
        self.obj, self.label, self.changes, self.close = obj, label, changes, close  # changes: {attr: (old, new)}

    def _same(self, a, b):
        if self.close is not None and isinstance(a, (int, float)) and isinstance(b, (int, float)):
            return abs(float(a) - float(b)) <= self.close
        return a == b

    def state(self):
        now, gone = _gone(lambda: dict((k, getattr(self.obj, k)) for k in self.changes))
        if gone:
            return "back", "%s is gone" % self.label
        if all(self._same(now[k], new) for k, (old, new) in self.changes.items()):
            return "left", None
        if all(self._same(now[k], old) for k, (old, new) in self.changes.items()):
            return "back", None
        return "changed", "%s was changed since" % self.label

    def revert(self):
        for k, (old, new) in self.changes.items():
            setattr(self.obj, k, old)


class _Route(object):
    """A routing choice (source, then channel), compared by the names Live shows."""
    def __init__(self, obj, attrs, label, old, new):
        self.obj, self.attrs, self.label, self.old, self.new = obj, attrs, label, old, new  # old/new: (from, channel)

    def _now(self):
        types_a, type_a, chans_a, chan_a = self.attrs
        return (_rname(getattr(self.obj, type_a)), _rname(getattr(self.obj, chan_a)))

    def state(self):
        now, gone = _gone(self._now)
        if gone:
            return "back", "%s is gone" % self.label
        if now == self.new:
            return "left", None
        if now == self.old:
            return "back", None
        return "changed", "%s's routing was changed since (now %s, %s)" % (self.label, now[0], now[1] or "-")

    def revert(self):
        types_a, type_a, chans_a, chan_a = self.attrs
        if _rname(getattr(self.obj, type_a)) != self.old[0]:
            setattr(self.obj, type_a, _choose_route(list(getattr(self.obj, types_a)), self.old[0], "source"))
            yield  # Live refreshes the channel list for the source
        if self.old[1] and _rname(getattr(self.obj, chan_a)) != self.old[1]:
            setattr(self.obj, chan_a, _choose_route(list(getattr(self.obj, chans_a)), self.old[1], "channel"))


class _ClipMade(object):
    def __init__(self, slot, clip, label, notes):
        self.slot, self.clip, self.label, self.notes = slot, clip, label, notes

    def state(self):
        here, gone = _gone(lambda: self.slot.has_clip and self.slot.clip == self.clip)
        if gone or not here:
            return "back", None
        count, _ = _gone(lambda: len(_clip_notes(self.clip)))
        if count is not None and count != self.notes:
            return "changed", "%s has different notes now" % self.label
        return "left", None

    def revert(self):
        self.slot.delete_clip()


class _NotesAdded(object):
    def __init__(self, clip, label, added):
        self.clip, self.label, self.added = clip, label, added  # added: [(pitch, start, duration)]

    def _ids(self):
        notes = list(_clip_notes(self.clip))
        ids = []
        for (p, s, d) in self.added:
            hit = [n for n in notes if n.pitch == p and abs(n.start_time - s) < 1e-6 and abs(n.duration - d) < 1e-6
                   and getattr(n, "note_id", None) not in ids]
            if not hit:
                return None
            ids.append(getattr(hit[0], "note_id", None))
        return ids

    def state(self):
        ids, gone = _gone(self._ids)
        if gone:
            return "back", "%s is gone" % self.label
        if ids is None:
            return "changed", "some of the notes added to %s were moved or removed since" % self.label
        if None in ids or not hasattr(self.clip, "remove_notes_by_id"):
            return "changed", "this Live version can't remove single notes, so the notes added to %s stay" % self.label
        return "left", None

    def revert(self):
        self.clip.remove_notes_by_id(tuple(self._ids()))


class _DevicesAdded(object):
    def __init__(self, track, devices, label):
        self.track, self.devices, self.label = track, list(devices), label
        self.settings = [self._settings(d) for d in self.devices]

    def _settings(self, d):
        return tuple(round(float(p.value), 6) for p in d.parameters)

    def state(self):
        devs, gone = _gone(lambda: list(self.track.devices))
        if gone:
            return "back", "its track is gone"
        here = [d for d in self.devices if any(x == d for x in devs)]
        if not here:
            return "back", None
        if len(here) != len(self.devices):
            return "changed", "part of %s was removed since" % self.label
        if [self._settings(d) for d in self.devices] != self.settings:
            return "changed", "%s's settings were changed since" % self.label
        return "left", None

    def revert(self):
        devs = list(self.track.devices)
        for i in sorted([i for i, d in enumerate(devs) if any(d == x for x in self.devices)], reverse=True):
            self.track.delete_device(i)


class _TrackMade(object):
    def __init__(self, song, track, label):
        self.song, self.track, self.label = song, track, label

    def _index(self):
        for i, t in enumerate(self.song.tracks):
            if t == self.track:
                return i
        return None

    def state(self):
        i, gone = _gone(self._index)
        if gone or i is None:
            return "back", None
        if list(self.track.devices) or any(cs.has_clip for cs in _slots(self.track)):
            return "changed", "%s has devices or clips on it now" % self.label
        return "left", None

    def revert(self):
        self.song.delete_track(self._index())


class _ArrClipsMade(object):
    """Clips the bridge placed on a track's Arrangement timeline."""
    def __init__(self, track, clips, label):
        self.track, self.clips, self.label = track, list(clips), label
        self.spots = [(float(c.start_time), float(c.end_time)) for c in self.clips]

    def _here(self):
        now = list(self.track.arrangement_clips)
        return [(c, spot) for c, spot in zip(self.clips, self.spots) if any(x == c for x in now)]

    def state(self):
        here, gone = _gone(self._here)
        if gone:
            return "back", "its track is gone"
        if not here:
            return "back", None
        if len(here) != len(self.clips):
            return "changed", "part of %s was removed since" % self.label
        if any(abs(float(c.start_time) - a) > 1e-6 or abs(float(c.end_time) - b) > 1e-6 for c, (a, b) in here):
            return "changed", "%s was moved or resized since" % self.label
        return "left", None

    def revert(self):
        for c, _ in self._here():
            self.track.delete_clip(c)


class _TrackCopied(object):
    """A track the bridge duplicated: revertible while its devices and clips are as they were copied."""
    def __init__(self, song, track, label):
        self.song, self.track, self.label = song, track, label
        self.shape = self._shape()

    def _shape(self):
        t = self.track
        return (len(list(t.devices)), sum(1 for cs in _slots(t) if cs.has_clip), len(_arr(t)))

    def _index(self):
        for i, t in enumerate(self.song.tracks):
            if t == self.track:
                return i
        return None

    def state(self):
        i, gone = _gone(self._index)
        if gone or i is None:
            return "back", None
        if self._shape() != self.shape:
            return "changed", "%s has different devices or clips now" % self.label
        return "left", None

    def revert(self):
        self.song.delete_track(self._index())


class _EnvMade(object):
    """An automation envelope the bridge made in a clip."""
    def __init__(self, clip, param, label):
        self.clip, self.param, self.label = clip, param, label

    def state(self):
        env, gone = _gone(lambda: self.clip.automation_envelope(self.param))
        if gone or env is None:
            return "back", None
        return "left", None

    def revert(self):
        self.clip.clear_envelope(self.param)


class _DeviceMoved(object):
    """A device the bridge moved within one track or rack chain."""
    def __init__(self, song, owner, device, old, new, label):
        self.song, self.owner, self.device, self.old, self.new, self.label = song, owner, device, old, new, label

    def _at(self):
        for i, d in enumerate(self.owner.devices):
            if d == self.device:
                return i
        return None

    def state(self):
        at, gone = _gone(self._at)
        if gone or at is None:
            return "changed", "%s is gone or was moved somewhere else" % self.label
        if at == self.new:
            return "left", None
        if at == self.old:
            return "back", None
        return "changed", "%s was moved since" % self.label

    def revert(self):
        self.song.move_device(self.device, self.owner, self.old)


class _SlotClipMade(object):
    """A clip the bridge copied into an empty Session slot."""
    def __init__(self, slot, clip, label):
        self.slot, self.clip, self.label = slot, clip, label

    def state(self):
        here, gone = _gone(lambda: self.slot.has_clip and self.slot.clip == self.clip)
        if gone or not here:
            return "back", None
        return "left", None

    def revert(self):
        self.slot.delete_clip()


class _ArrClipMoved(object):
    """An Arrangement clip the bridge moved (Live has no move: it's a copy at the new spot, then the old one deleted)."""
    def __init__(self, src_track, dest_track, clip, old_start, label):
        self.src, self.dest, self.clip, self.old_start, self.label = src_track, dest_track, clip, old_start, label
        self.spot = (float(clip.start_time), float(clip.end_time))

    def state(self):
        here, gone = _gone(lambda: [c for c in self.dest.arrangement_clips if c == self.clip])
        if gone or not here:
            return "changed", "%s is gone since" % self.label
        c = here[0]
        if abs(float(c.start_time) - self.spot[0]) > 1e-6 or abs(float(c.end_time) - self.spot[1]) > 1e-6:
            return "changed", "%s was moved or resized since" % self.label
        length = self.spot[1] - self.spot[0]
        if any(x != self.clip and float(x.start_time) < self.old_start + length - 1e-6 and float(x.end_time) > self.old_start + 1e-6
               for x in self.src.arrangement_clips):
            return "changed", "something now sits where %s used to be" % self.label
        return "left", None

    def revert(self):
        self.src.duplicate_clip_to_arrangement(self.clip, self.old_start)
        self.dest.delete_clip(self.clip)


class _ReturnMade(object):
    """A return track the bridge made: revertible while it has no devices."""
    def __init__(self, song, track, label):
        self.song, self.track, self.label = song, track, label

    def _index(self):
        for i, t in enumerate(self.song.return_tracks):
            if t == self.track:
                return i
        return None

    def state(self):
        i, gone = _gone(self._index)
        if gone or i is None:
            return "back", None
        if list(self.track.devices):
            return "changed", "%s has devices on it now" % self.label
        return "left", None

    def revert(self):
        self.song.delete_return_track(self._index())


class _WarpAdded(object):
    """Warp markers the bridge added to an audio clip (and warp switched on, if it was off)."""
    def __init__(self, clip, beats, was_warping, label):
        self.clip, self.beats, self.was_warping, self.label = clip, list(beats), was_warping, label

    def _here(self):
        now = [float(m.beat_time) for m in self.clip.warp_markers]
        return [b for b in self.beats if any(abs(b - x) < 1e-4 for x in now)]

    def state(self):
        here, gone = _gone(self._here)
        if gone:
            return "back", "%s is gone" % self.label
        if not here:
            return "back", None
        if len(here) != len(self.beats):
            return "changed", "some of the warp markers added to %s were moved or removed since" % self.label
        return "left", None

    def revert(self):
        for b in sorted(self._here(), reverse=True):
            self.clip.remove_warp_marker(b)
        if not self.was_warping:
            self.clip.warping = False


class _Fixed(object):
    """A change the revert can't take back by itself (it says how instead)."""
    def __init__(self, label, how):
        self.label, self.how = label, how

    def state(self):
        return "changed", "%s can't be reverted here: %s" % (self.label, self.how)

    def revert(self):
        pass


def _clip_notes(clip):
    if hasattr(clip, "get_notes_extended"):
        return list(clip.get_notes_extended(0, 128, 0.0, clip.length))
    raise ValueError("this Live version can't list a clip's notes")


# ---- Simpler and audio clips (sample chopping) ----
# Live 12's SimplerDevice: playback_mode, slicing_playback_mode, replace_sample(path); its Sample: warping, warp_mode,
# slicing_style, slicing_sensitivity, slicing_beat_division, slicing_region_count, slices, file_path. The numbers
# below are the order of Live's own menus.

SIMPLER_MODES = ("classic", "one-shot", "slice")
SLICE_BY = ("transient", "beat", "region", "manual")
SLICE_PLAYBACK = ("mono", "poly", "thru")
WARP_MODES = {"beats": 0, "tones": 1, "texture": 2, "re-pitch": 3, "complex": 4, "rex": 5, "complex pro": 6}
BEAT_DIVISIONS = ("1/16", "1/16T", "1/8", "1/8T", "1/4", "1/4T", "1/2", "1/2T", "1 bar", "2 bars", "4 bars")
AUDIO_FILES = (".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg", ".m4a")


def _is_simpler(d):
    return hasattr(d, "playback_mode") and hasattr(d, "sample")


def _choice(options, wanted, what):
    """A menu choice by name (any case; "oneshot", "one shot" and "slicing" work too). Returns its index."""
    w = str(wanted).strip().lower().replace("_", " ")
    alias = {"one shot": "one-shot", "oneshot": "one-shot", "slicing": "slice", "slices": "slice", "repitch": "re-pitch",
             "re pitch": "re-pitch", "complexpro": "complex pro", "transients": "transient", "beats": "beat", "regions": "region"}
    names = list(options)
    for cand in (w, alias.get(w, w)):
        if cand in names:
            return names.index(cand)
    raise ValueError("%s can be: %s" % (what, ", ".join(names)))


def _warp_mode(wanted):
    w = str(wanted).strip().lower().replace("_", " ")
    w = {"repitch": "re-pitch", "re pitch": "re-pitch", "complexpro": "complex pro"}.get(w, w)
    if w not in WARP_MODES:
        raise ValueError("warp_mode can be: beats, tones, texture, re-pitch, complex, complex pro")
    return WARP_MODES[w]


def _warp_name(v):
    for k, n in WARP_MODES.items():
        if n == v:
            return k
    return str(v)


def _named(names, i):
    try:
        return names[int(i)]
    except Exception:
        return str(i)


def _transpose_param(simpler):
    for p in simpler.parameters:
        if str(p.name).strip().lower() in ("transpose", "transp"):
            return p
    return None


def _simpler_info(d):
    smp = getattr(d, "sample", None)
    out = {"mode": _named(SIMPLER_MODES, d.playback_mode)}
    if hasattr(d, "slicing_playback_mode"):
        out["slice_playback"] = _named(SLICE_PLAYBACK, d.slicing_playback_mode)
    tp = _transpose_param(d)
    if tp is not None:
        out["transpose"] = _param_text(tp)
    if smp is None:
        out["sample"] = None
        return out
    out["sample"] = _file_name(str(smp.file_path))
    out["file"] = str(smp.file_path)
    out["warp"] = bool(smp.warping)
    out["warp_mode"] = _warp_name(smp.warp_mode)
    out["slice_by"] = _named(SLICE_BY, smp.slicing_style)
    out["sensitivity"] = round(float(smp.slicing_sensitivity), 3)
    out["beat_division"] = _named(BEAT_DIVISIONS, smp.slicing_beat_division)
    out["regions"] = int(smp.slicing_region_count)
    try:
        out["slices"] = len(list(smp.slices))
    except Exception:
        pass
    return out


def _simpler_plan(d, mode=None, slice_by=None, sensitivity=None, beat_division=None, regions=None,
                  warp=None, warp_mode=None, transpose=None, slice_playback=None):
    """Checks every setting first, then returns [(object, attribute, new value, label)], so a bad one changes nothing."""
    smp = getattr(d, "sample", None)
    plan = []
    if mode is not None:
        plan.append((d, "playback_mode", _choice(SIMPLER_MODES, mode, "mode"), "mode"))
    if slice_playback is not None:
        plan.append((d, "slicing_playback_mode", _choice(SLICE_PLAYBACK, slice_playback, "slice_playback"), "slice playback"))
    sample_settings = [x for x in (slice_by, sensitivity, beat_division, regions, warp, warp_mode) if x is not None]
    if sample_settings and smp is None:
        raise ValueError("this Simpler has no sample yet")
    if slice_by is not None:
        plan.append((smp, "slicing_style", _choice(SLICE_BY, slice_by, "slice_by"), "slice by"))
    if sensitivity is not None:
        v = float(sensitivity)
        v = v / 100.0 if v > 1 else v
        if not (0 <= v <= 1):
            raise ValueError("sensitivity is 0-100 (percent)")
        plan.append((smp, "slicing_sensitivity", v, "sensitivity"))
    if beat_division is not None:
        names = [b.lower() for b in BEAT_DIVISIONS]
        w = str(beat_division).strip().lower().replace("bars", "bar").replace("bar", " bar").replace("  ", " ").strip()
        w = {"1 bar": "1 bar", "2 bar": "2 bars", "4 bar": "4 bars"}.get(w, w)
        if w not in names:
            raise ValueError("beat_division can be: %s" % ", ".join(BEAT_DIVISIONS))
        plan.append((smp, "slicing_beat_division", names.index(w), "beat division"))
    if regions is not None:
        n = int(regions)
        if not (2 <= n <= 64):
            raise ValueError("regions is 2-64")
        plan.append((smp, "slicing_region_count", n, "regions"))
    if warp is not None:
        plan.append((smp, "warping", bool(warp), "warp"))
    if warp_mode is not None:
        plan.append((smp, "warp_mode", _warp_mode(warp_mode), "warp mode"))
    if transpose is not None:
        tp = _transpose_param(d)
        if tp is None:
            raise ValueError("couldn't find this Simpler's Transpose knob")
        st = float(transpose)
        if not (float(tp.min) <= st <= float(tp.max)):
            raise ValueError("transpose is %g to %g semitones" % (float(tp.min), float(tp.max)))
        plan.append((tp, "value", float(round(st)), "transpose"))
    return plan


def create_instance(c_instance):
    return SecondChair(c_instance)


def _token_paths():
    # Live's embedded Python may not see %APPDATA%, so look in several places, the script's own folder first.
    here = os.path.dirname(os.path.abspath(__file__))
    paths = [os.path.join(here, "token")]
    for base in (os.environ.get("APPDATA"),
                 os.path.join(os.environ.get("USERPROFILE", ""), "AppData", "Roaming") if os.environ.get("USERPROFILE") else None,
                 os.path.join(os.path.expanduser("~"), "AppData", "Roaming"),
                 os.path.expanduser("~")):
        if base:
            paths.append(os.path.join(base, "SecondChair", "token"))
    return paths


def _read_token():
    for path in _token_paths():
        try:
            with open(path, "r") as f:
                tok = f.read().strip()
                if tok:
                    return tok
        except Exception:
            continue
    return None


class SecondChair(ControlSurface):

    def __init__(self, c_instance):
        ControlSurface.__init__(self, c_instance)
        self._requests = queue.Queue()
        self._jobs = deque()
        self._journal = deque(maxlen=MAX_JOURNAL)  # the bridge's own changes, newest last (see _Attrs and friends)
        self._running = True
        self._token = _read_token()
        self._sock = None
        self._osc_sock = None
        self._osc_out = None
        self._cc_lock = threading.Lock()
        self._events = deque()
        self._held = set()
        self._last_hello = None   # epoch ms of the last message from the device
        self._last_shown = None
        if not self._token:
            self.log_message("SecondChair: no token file, refusing all requests. Looked in: %s" % "; ".join(_token_paths()))
            self.show_message("SecondChair: token missing, run install.ps1")
        self._thread = threading.Thread(target=self._serve)
        self._thread.daemon = True
        self._thread.start()
        self._osc_thread = threading.Thread(target=self._osc_serve)
        self._osc_thread.daemon = True
        self._osc_thread.start()
        self.show_message("SecondChair %s ready" % VERSION)

    def disconnect(self):
        self._running = False
        try:
            if self._sock:
                self._sock.close()
        except Exception:
            pass
        for sock in (self._osc_sock, self._osc_out):
            try:
                if sock:
                    sock.close()
            except Exception:
                pass
        ControlSurface.disconnect(self)

    # ---- socket side (background threads, never touches Live objects) ----

    def _serve(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((HOST, PORT))
            s.listen(4)
            s.settimeout(1.0)
            self._sock = s
            self.log_message("SecondChair: listening on %s:%d" % (HOST, PORT))
        except Exception as e:
            self.log_message("SecondChair: could not listen: %s" % e)
            return
        while self._running:
            try:
                conn, _ = s.accept()
            except socket.timeout:
                continue
            except Exception:
                break
            t = threading.Thread(target=self._client, args=(conn,))
            t.daemon = True
            t.start()

    # ---- Chord Coach side: OSC over UDP, loopback only ----

    def _osc_serve(self):
        try:
            u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            u.bind((HOST, OSC_IN_PORT))
            u.settimeout(1.0)
            self._osc_sock = u
            self.log_message("SecondChair: Chord Coach OSC listening on %s:%d" % (HOST, OSC_IN_PORT))
        except Exception as e:
            self.log_message("SecondChair: could not listen for Chord Coach on UDP %d (%s); the TCP bridge still works" % (OSC_IN_PORT, e))
            return
        while self._running:
            try:
                data, addr = u.recvfrom(4096)
            except socket.timeout:
                continue
            except Exception:
                break
            if addr[0] != HOST:
                continue
            try:
                address, args = osc_decode(data)
                self._on_osc(address, args)
            except Exception:
                continue

    def _on_osc(self, address, args):
        now = int(time.time() * 1000)
        if address == "/cc/hello":
            with self._cc_lock:
                self._last_hello = now
        elif address == "/cc/note":
            if len(args) < 2 or not all(isinstance(a, (int, float)) for a in args[:2]):
                return
            pitch, vel = int(round(args[0])), int(round(args[1]))
            if not (0 <= pitch <= 127) or not (0 <= vel <= 127):
                return
            with self._cc_lock:
                self._last_hello = now  # a note is proof the device is alive
                self._events.append({"type": "on" if vel > 0 else "off", "note": pitch, "velocity": vel,
                                     "channel": 0, "timestamp": now})
                if vel > 0:
                    self._held.add(pitch)
                else:
                    self._held.discard(pitch)
                self._prune(now)

    def _prune(self, now):
        # caller holds _cc_lock
        while self._events and (now - self._events[0]["timestamp"] > EVENT_WINDOW_MS or len(self._events) > MAX_EVENTS):
            self._events.popleft()

    def _device_state(self):
        with self._cc_lock:
            seen = self._last_hello
        if seen is None:
            return "missing", None
        ago = max(0, int(time.time() * 1000) - seen)
        return ("connected" if ago <= DEVICE_ALIVE_MS else "missing"), ago

    def _osc_send(self, address, args=()):
        if self._osc_out is None:
            self._osc_out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._osc_out.sendto(osc_encode(address, args), (HOST, OSC_OUT_PORT))

    def _client(self, conn):
        conn.settimeout(60)
        buf = b""
        try:
            while self._running:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buf += chunk
                if len(buf) > MAX_LINE:
                    break
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    resp = self._handle_line(line)
                    conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _handle_line(self, line):
        try:
            req = json.loads(line.decode("utf-8"))
        except Exception:
            return {"ok": False, "error": "request was not valid JSON"}
        rid = req.get("id")
        if not self._token:
            self._token = _read_token()  # picks up a token added after Live started
        if not self._token or req.get("token") != self._token:
            return {"id": rid, "ok": False, "error": "unauthorized"}
        action = req.get("action")
        params = req.get("params") or {}
        if action not in ACTIONS or not isinstance(params, dict):
            return {"id": rid, "ok": False, "error": "unknown action: %s" % action}
        box = {"done": threading.Event()}
        self._requests.put((action, params, box))
        wait = ACTION_WAIT.get(action, DEFAULT_WAIT)
        if not box["done"].wait(wait):
            return {"id": rid, "ok": False, "error": "Live did not answer within %d seconds" % wait}
        out = dict(box.get("result") or {"ok": False, "error": "no result"})
        out["id"] = rid
        return out

    # ---- Live side (main thread) ----

    def update_display(self):
        ControlSurface.update_display(self)
        for _ in range(16):
            try:
                action, params, box = self._requests.get_nowait()
            except queue.Empty:
                break
            try:
                result = getattr(self, "_a_" + action)(**params)
            except Exception as e:
                box["result"] = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
                box["done"].set()
                continue
            if isinstance(result, types.GeneratorType):
                # A job: it runs a step per tick, so Live can finish a browser load in between.
                self._jobs.append((result, box, time.time() + ACTION_WAIT.get(action, DEFAULT_WAIT)))
                continue
            box["result"] = {"ok": True, "result": result}
            box["done"].set()
        self._step_job()

    def _step_job(self):
        # One job at a time, so two loads never fight over the selected track.
        if not self._jobs:
            return
        gen, box, deadline = self._jobs[0]
        try:
            if time.time() > deadline:
                gen.close()
                raise RuntimeError("this took too long and was stopped; check the track, and use live_undo if a part loaded")
            next(gen)
            return
        except StopIteration as stop:
            box["result"] = {"ok": True, "result": stop.value}
        except Exception as e:
            box["result"] = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
        self._jobs.popleft()
        box["done"].set()

    # helpers
    def _all_tracks(self):
        """Regular tracks, then the return tracks, then Main: one numbering for every tool (0.9.5)."""
        s = self.song()
        out = list(s.tracks) + list(getattr(s, "return_tracks", ()) or ())
        if getattr(s, "master_track", None) is not None:
            out.append(s.master_track)
        return out

    def _track(self, track, regular=False):
        s = self.song()
        n = len(s.tracks)
        every = self._all_tracks()
        i = int(track)
        if i < 0 or i >= len(every):
            raise ValueError("track %d doesn't exist (there are %d tracks, numbered from 0; the return tracks and Main "
                             "come after them, up to %d)" % (i, n, len(every) - 1))
        if regular and i >= n:
            raise ValueError("track %d is %s, and this only works on regular tracks (0-%d)" % (i, every[i].name, n - 1))
        return every[i]

    def _slot(self, track, slot):
        t = self._track(track)
        j = int(slot)
        slots = _slots(t)
        if not slots:
            raise ValueError("track %d (%s) is a return track or Main, which have no clip slots" % (int(track), t.name))
        if j < 0 or j >= len(slots):
            raise ValueError("slot %d doesn't exist on track %d (there are %d slots)" % (j, int(track), len(slots)))
        return slots[j]

    def _clip(self, track, slot):
        cs = self._slot(track, slot)
        if not cs.has_clip:
            raise ValueError("track %d, slot %d is empty" % (int(track), int(slot)))
        return cs.clip

    def _track_info(self, i, t):
        info = {
            "index": i,
            "name": t.name,
            "kind": "midi" if t.has_midi_input else "audio",
            "armed": _safe(lambda: bool(t.arm), None) if _safe(lambda: t.can_be_armed, False) else None,
            "mute": _safe(lambda: bool(t.mute), False),
            "solo": _safe(lambda: bool(t.solo), False),
            "devices": [d.name for d in t.devices],
            "playing_slot": _safe(lambda: t.playing_slot_index, -1),
        }
        mon = _safe(lambda: t.current_monitoring_state, None)
        if mon is not None and _safe(lambda: t.can_be_armed, False):
            info["monitor"] = MONITOR_NAMES.get(int(mon), str(mon))
        if _safe(lambda: t.is_grouped, False):
            info["in_group"] = str(getattr(getattr(t, "group_track", None), "name", ""))
        if _safe(lambda: t.is_foldable, False):
            info["is_group"] = True
        return info

    def _clean_notes(self, notes):
        if not isinstance(notes, list) or not notes:
            raise ValueError("notes must be a non-empty list")
        if len(notes) > MAX_NOTES:
            raise ValueError("too many notes (max %d)" % MAX_NOTES)
        out = []
        for n in notes:
            p = int(n["pitch"])
            s = float(n.get("start", 0.0))
            d = float(n.get("duration", 1.0))
            v = int(n.get("velocity", 100))
            if not (0 <= p <= 127):
                raise ValueError("pitch %d is outside 0-127" % p)
            if s < 0 or d <= 0:
                raise ValueError("start must be >= 0 and duration > 0")
            v = max(1, min(127, v))
            out.append((p, s, d, v))
        return out

    def _write_notes(self, clip, notes):
        spec = getattr(Live.Clip, "MidiNoteSpecification", None)
        if spec is not None and hasattr(clip, "add_new_notes"):
            clip.add_new_notes(tuple(
                spec(pitch=p, start_time=s, duration=d, velocity=v, mute=False) for (p, s, d, v) in notes))
        else:
            clip.set_notes(tuple((p, s, d, v, False) for (p, s, d, v) in notes))

    # actions
    def _a_ping(self):
        app = Live.Application.get_application()
        return {
            "bridge": VERSION,
            "live": "%d.%d.%d" % (app.get_major_version(), app.get_minor_version(), app.get_bugfix_version()),
            "chord_coach": dict(zip(("device", "device_seen_ms_ago"), self._device_state())),
        }

    def _a_get_session(self):
        s = self.song()
        tracks = list(s.tracks)
        sel = s.view.selected_track
        sel_index = None
        for i, t in enumerate(tracks):
            if t == sel:
                sel_index = i
        out = {
            "tempo": s.tempo,
            "signature": [s.signature_numerator, s.signature_denominator],
            "is_playing": bool(s.is_playing),
            "song_time_beats": s.current_song_time,
            "tracks": [self._track_info(i, t) for i, t in enumerate(tracks)],
            "scenes": [{"index": i, "name": sc.name} for i, sc in enumerate(s.scenes)],
            "selected_track": sel_index,
        }
        n = len(tracks)
        returns = list(getattr(s, "return_tracks", ()) or ())
        out["returns"] = [dict(self._track_info(n + k, t), kind="return", send="Send %s" % chr(ord("A") + k)) for k, t in enumerate(returns)]
        if getattr(s, "master_track", None) is not None:
            out["main"] = {"index": n + len(returns), "name": s.master_track.name, "devices": [d.name for d in s.master_track.devices]}
        for attr in ("root_note", "scale_name", "scale_mode"):
            if hasattr(s, attr):
                out[attr] = getattr(s, attr)
        return out

    def _a_get_track(self, track):
        t = self._track(track)
        info = self._track_info(int(track), t)
        clips = []
        for j, cs in enumerate(_slots(t)):
            if cs.has_clip:
                c = cs.clip
                clips.append({"slot": j, "name": c.name, "length_beats": c.length,
                              "midi": bool(c.is_midi_clip), "playing": bool(c.is_playing)})
        info["clips"] = clips
        info["slot_count"] = len(_slots(t))
        return info

    def _a_get_clip_notes(self, track, slot):
        c = self._clip(track, slot)
        if not c.is_midi_clip:
            raise ValueError("that clip is audio, not MIDI")
        notes = []
        if hasattr(c, "get_notes_extended"):
            for n in c.get_notes_extended(0, 128, 0.0, c.length):
                notes.append({"pitch": n.pitch, "start": n.start_time, "duration": n.duration,
                              "velocity": n.velocity})
        else:
            for (p, st, d, v, m) in c.get_notes(0.0, 0, c.length, 128):
                notes.append({"pitch": p, "start": st, "duration": d, "velocity": v})
        notes.sort(key=lambda n: (n["start"], n["pitch"]))
        return {"name": c.name, "length_beats": c.length, "notes": notes}

    def _a_create_midi_clip(self, track, slot, length_beats, notes, name=""):
        t = self._track(track)
        if not t.has_midi_input:
            raise ValueError("track %d is an audio track; pick a MIDI track" % int(track))
        cs = self._slot(track, slot)
        if cs.has_clip:
            raise ValueError("track %d, slot %d already has a clip; pick an empty slot" % (int(track), int(slot)))
        length = float(length_beats)
        if not (0 < length <= 4096):
            raise ValueError("length_beats must be between 0 and 4096")
        clean = self._clean_notes(notes)
        cs.create_clip(length)
        c = cs.clip
        if name:
            c.name = str(name)
        self._write_notes(c, clean)
        count, _ = _gone(lambda: len(_clip_notes(c)))
        label = "the clip %sin track %d, slot %d" % ("%r " % str(name) if name else "", int(track), int(slot))
        self._log("wrote " + label, [_ClipMade(cs, c, label, count if count is not None else len(clean))])
        return {"track": int(track), "slot": int(slot), "notes_written": len(clean), "length_beats": length}

    def _a_add_notes(self, track, slot, notes):
        c = self._clip(track, slot)
        if not c.is_midi_clip:
            raise ValueError("that clip is audio, not MIDI")
        clean = self._clean_notes(notes)
        self._write_notes(c, clean)
        label = "the clip in track %d, slot %d" % (int(track), int(slot))
        self._log("added %d note%s to %s" % (len(clean), "" if len(clean) == 1 else "s", label), [_NotesAdded(c, label, [(p, st, d) for (p, st, d, v) in clean])])
        return {"notes_added": len(clean)}

    def _a_set_tempo(self, bpm):
        b = float(bpm)
        if not (20 <= b <= 999):
            raise ValueError("tempo must be between 20 and 999 BPM")
        s = self.song()
        old = s.tempo
        s.tempo = b
        self._log("set the tempo from %g to %g BPM" % (old, b), [_Attrs(s, "the tempo", {"tempo": (old, s.tempo)}, close=0.001)])
        return {"tempo": b}

    def _a_set_scale(self, root, name=None, enabled=True):
        s = self.song()
        if not hasattr(s, "root_note"):
            raise ValueError("this Live version has no song scale")
        attrs = [a for a in ("root_note", "scale_name", "scale_mode") if hasattr(s, a)]
        old = dict((a, getattr(s, a)) for a in attrs)
        s.root_note = int(root) % 12
        if name:
            s.scale_name = str(name)
        if hasattr(s, "scale_mode"):
            s.scale_mode = bool(enabled)
        self._log("set the song's scale to %s %s" % (NOTE_NAMES[s.root_note], s.scale_name),
                  [_Attrs(s, "the song's scale", dict((a, (old[a], getattr(s, a))) for a in attrs))])
        return {"root_note": s.root_note, "scale_name": s.scale_name}

    def _a_play(self):
        self.song().start_playing()
        return {"is_playing": True}

    def _a_stop(self):
        self.song().stop_playing()
        return {"is_playing": False}

    def _transport_state(self):
        s = self.song()
        beats_per_bar = s.signature_numerator * 4.0 / s.signature_denominator
        return {"is_playing": bool(s.is_playing), "record": bool(getattr(s, "record_mode", False)),
                "bar": int(s.current_song_time // beats_per_bar) + 1,
                "session_overrides_arrangement": bool(getattr(s, "back_to_arranger", False))}

    def _a_stop_all_clips(self):
        """Live's Stop All Clips: every Session clip stops (at the next launch quantization, as the button does)."""
        self.song().stop_all_clips()
        return self._transport_state()

    def _a_back_to_arrangement(self):
        """Live's Back to Arrangement button: the Arrangement plays again where Session clips had taken over."""
        s = self.song()
        if not hasattr(s, "back_to_arranger"):
            raise ValueError("this Live version doesn't let scripts press Back to Arrangement")
        s.back_to_arranger = False
        return self._transport_state()

    def _a_set_record(self, on):
        """Arrangement Record on or off (Live's round record button at the top)."""
        s = self.song()
        s.record_mode = bool(on)
        return self._transport_state()

    def _a_jump_to_bar(self, bar):
        s = self.song()
        b = float(bar)
        if b < 1 or b > 10000:
            raise ValueError("bar must be 1 or more")
        beats_per_bar = s.signature_numerator * 4.0 / s.signature_denominator
        s.current_song_time = (b - 1) * beats_per_bar
        return self._transport_state()

    # ---- the Arrangement timeline (0.9.0) ----
    def _beats_per_bar(self):
        s = self.song()
        return s.signature_numerator * 4.0 / s.signature_denominator

    def _bar_of(self, beats):
        return round(float(beats) / self._beats_per_bar() + 1, 3)

    def _arr_clip_info(self, c):
        bpb = self._beats_per_bar()
        return {"name": c.name, "start_bar": self._bar_of(c.start_time), "end_bar": self._bar_of(c.end_time),
                "bars": round((float(c.end_time) - float(c.start_time)) / bpb, 3),
                "kind": "midi" if c.is_midi_clip else "audio", "muted": bool(getattr(c, "muted", False))}

    def _a_get_arrangement(self, track=None):
        """What's on the Arrangement timeline: each track's clips by bar (bars from 1), plus the Arrangement Loop."""
        s = self.song()
        bpb = self._beats_per_bar()
        tracks = list(s.tracks)
        if track is not None:
            self._track(track)
        pick = range(len(tracks)) if track is None else [int(track)]
        out = {"tracks": []}
        every = self._all_tracks()
        for i in pick:
            t = every[i]
            clips = sorted(_arr(t), key=lambda c: float(c.start_time))
            out["tracks"].append({"index": i, "name": t.name, "clips": [self._arr_clip_info(c) for c in clips]})
        ends = [float(c.end_time) for t in tracks for c in _arr(t)]
        out["last_bar"] = self._bar_of(max(ends)) if ends else None
        if hasattr(s, "loop"):
            out["arrangement_loop"] = {"on": bool(s.loop), "start_bar": self._bar_of(s.loop_start),
                                       "bars": round(float(s.loop_length) / bpb, 3)}
        return out

    def _a_place_clip(self, track, slot, bar, bars=None, to_track=None):
        """Copies a Session clip onto the Arrangement timeline at a bar, repeated to fill bars if given.
        Never covers clips already there."""
        src_clip = self._clip(track, slot)
        dest_i = int(track if to_track is None else to_track)
        t = self._track(dest_i, regular=True)
        if not hasattr(t, "duplicate_clip_to_arrangement"):
            raise ValueError("this Live version can't place clips on the Arrangement from a script")
        if bool(src_clip.is_midi_clip) != bool(t.has_midi_input):
            raise ValueError("a %s clip can't go on track %d, which is %s track" % (
                "MIDI" if src_clip.is_midi_clip else "audio", dest_i, "a MIDI" if t.has_midi_input else "an audio"))
        b = float(bar)
        if not (1 <= b <= 10000):
            raise ValueError("bar must be 1 or more")
        bpb = self._beats_per_bar()
        start = (b - 1) * bpb
        length = float(src_clip.length)
        if length <= 0:
            raise ValueError("that clip has no length")
        fill = length if bars is None else float(bars) * bpb
        if not (0 < fill <= 1024 * bpb):
            raise ValueError("bars must be between 0 and 1024")
        copies = int(-(-round(fill, 6) // length))  # whole copies; the last may run past the end
        if copies > 256:
            raise ValueError("that would take %d copies of the clip; ask for fewer bars" % copies)
        end = start + copies * length
        hit = [c for c in _arr(t)
               if float(c.start_time) < end - 1e-6 and float(c.end_time) > start + 1e-6]
        if hit:
            raise ValueError("track %d already has clips there (%s), and the bridge never covers clips. Pick another "
                             "bar, or move them first" % (dest_i, ", ".join(
                                 "%r at bar %g" % (c.name, self._bar_of(c.start_time)) for c in hit)))
        before = list(t.arrangement_clips)
        for k in range(copies):
            t.duplicate_clip_to_arrangement(src_clip, start + k * length)
        new = [c for c in t.arrangement_clips if not any(c == x for x in before)]
        if not new:
            yield  # Live may show them on the next tick
            new = [c for c in t.arrangement_clips if not any(c == x for x in before)]
        new.sort(key=lambda c: float(c.start_time))
        label = "%d cop%s of %r on track %d from bar %g" % (len(new), "y" if len(new) == 1 else "ies", src_clip.name, dest_i, b)
        self._log("placed " + label, [_ArrClipsMade(t, new, label)])
        out = {"track": dest_i, "placed": [self._arr_clip_info(c) for c in new]}
        if bars is not None and copies * length > fill + 1e-6:
            out["note"] = "the clip is %g bars long, so the last copy runs to bar %g, past the %g bars asked for" % (
                length / bpb, self._bar_of(end), float(bars))
        return out

    def _a_duplicate_track(self, track):
        s = self.song()
        i = int(track)
        t = self._track(i, regular=True)
        before = list(s.tracks)
        s.duplicate_track(i)
        new = [(n, x) for n, x in enumerate(s.tracks) if not any(x == b for b in before)]
        if len(new) != 1:
            raise ValueError("duplicated the track but couldn't tell which one is new; check live_status")
        n, copy = new[0]
        self._log("duplicated track %d %r" % (i, t.name), [_TrackCopied(s, copy, "the copy %r" % copy.name)])
        return {"track": n, "name": copy.name, "copied_from": i}

    def _a_rename_track(self, track, name):
        t = self._track(track)
        new = str(name).strip()[:100]
        if not new:
            raise ValueError("give a name")
        old = t.name
        t.name = new
        self._log("renamed track %d from %r to %r" % (int(track), old, new),
                  [_Attrs(t, "track %d's name" % int(track), {"name": (old, t.name)})])
        return {"track": int(track), "was": old, "name": t.name}

    def _a_rename_scene(self, scene, name):
        scenes = self.song().scenes
        i = int(scene)
        if i < 0 or i >= len(scenes):
            raise ValueError("scene %d doesn't exist (there are %d, numbered from 0)" % (i, len(scenes)))
        sc = scenes[i]
        new = str(name).strip()[:100]
        old = sc.name
        sc.name = new
        self._log("renamed scene %d from %r to %r" % (i, old, new), [_Attrs(sc, "scene %d's name" % i, {"name": (old, sc.name)})])
        return {"scene": i, "was": old, "name": sc.name}

    def _a_fire_clip(self, track, slot):
        self._slot(track, slot).fire()
        return {"fired": [int(track), int(slot)]}

    def _a_stop_track(self, track):
        self._track(track).stop_all_clips()
        return {"stopped": int(track)}

    def _a_fire_scene(self, index):
        scenes = self.song().scenes
        i = int(index)
        if i < 0 or i >= len(scenes):
            raise ValueError("scene %d doesn't exist (there are %d)" % (i, len(scenes)))
        scenes[i].fire()
        return {"fired_scene": i}

    def _a_arm_track(self, track, armed=True):
        t = self._track(track)
        if not t.can_be_armed:
            raise ValueError("track %d can't be armed" % int(track))
        old = t.arm
        t.arm = bool(armed)
        if bool(old) != bool(t.arm):
            self._log("%s track %d" % ("armed" if t.arm else "disarmed", int(track)),
                      [_Attrs(t, "track %d's arm button" % int(track), {"arm": (old, t.arm)})])
        return {"track": int(track), "armed": bool(t.arm), "changed": bool(old) != bool(t.arm)}

    def _a_create_midi_track(self, name=None, index=-1):
        s = self.song()
        i = int(index)
        if i < -1 or i > len(s.tracks):
            raise ValueError("index must be -1 (end) or 0-%d" % len(s.tracks))
        before = list(s.tracks)
        s.create_midi_track(i)
        # Live doesn't always put it where asked (with -1 it can land right after the selected track),
        # so find the track that wasn't there before.
        new = [(n, t) for n, t in enumerate(s.tracks) if not any(t == b for b in before)]
        if len(new) != 1:
            raise ValueError("made a track but couldn't tell which one it is; check live_status")
        new_index, t = new[0]
        if name:
            t.name = str(name)
        self._log("made the MIDI track %r" % t.name, [_TrackMade(s, t, "the track %r" % t.name)])
        return {"track": new_index, "name": t.name}

    def _a_create_audio_track(self, name=None, index=-1):
        s = self.song()
        i = int(index)
        if i < -1 or i > len(s.tracks):
            raise ValueError("index must be -1 (end) or 0-%d" % len(s.tracks))
        if not hasattr(s, "create_audio_track"):
            raise ValueError("this Live version can't make audio tracks from a script")
        before = list(s.tracks)
        s.create_audio_track(i)
        new = [(n, t) for n, t in enumerate(s.tracks) if not any(t == b for b in before)]
        if len(new) != 1:
            raise ValueError("made a track but couldn't tell which one it is; check live_status")
        new_index, t = new[0]
        if name:
            t.name = str(name)
        self._log("made the audio track %r" % t.name, [_TrackMade(s, t, "the track %r" % t.name)])
        return {"track": new_index, "name": t.name, "kind": "audio",
                "note": "Tracks after it moved down by one, and so did the return tracks and Main; read live_status again."}

    def _a_create_return_track(self, name=None):
        s = self.song()
        if not hasattr(s, "create_return_track"):
            raise ValueError("this Live version can't make return tracks from a script")
        before = list(s.return_tracks)
        if len(before) >= 12:
            raise ValueError("Live has at most 12 return tracks")
        s.create_return_track()
        new = [(k, t) for k, t in enumerate(s.return_tracks) if not any(t == b for b in before)]
        if len(new) != 1:
            raise ValueError("made a return track but couldn't tell which one it is; check live_status")
        k, t = new[0]
        if name:
            t.name = str(name)
        self._log("made the return track %r" % t.name, [_ReturnMade(s, t, "the return track %r" % t.name)])
        return {"track": len(s.tracks) + k, "name": t.name, "kind": "return", "send": "Send %s" % chr(ord("A") + k),
                "note": "Every track now has this send (on its mixer). Turn it up with live_set_device_param, device 'mixer'."}

    def _a_set_monitoring(self, track, monitor):
        """A track's Monitor switch: in (always hear its input), auto (while armed), off."""
        t = self._track(track, regular=True)
        want = str(monitor).strip().lower()
        if want not in MONITOR_VALUES:
            raise ValueError("monitor can be: in, auto, off")
        if not hasattr(t, "current_monitoring_state") or not getattr(t, "can_be_armed", False):
            raise ValueError("track %d (%s) has no Monitor switch" % (int(track), t.name))
        old = int(t.current_monitoring_state)
        t.current_monitoring_state = MONITOR_VALUES[want]
        if old != int(t.current_monitoring_state):
            self._log("set track %d's Monitor from %s to %s" % (int(track), MONITOR_NAMES.get(old, old), want),
                      [_Attrs(t, "track %d's Monitor switch" % int(track), {"current_monitoring_state": (old, int(t.current_monitoring_state))})])
        return {"track": int(track), "name": t.name, "was": MONITOR_NAMES.get(old, str(old)), "monitor": want}

    def _a_select_track(self, track):
        self.song().view.selected_track = self._track(track)
        return {"selected_track": int(track)}

    def _a_undo(self, steps=1):
        s = self.song()
        n = int(steps)
        if not (1 <= n <= 40):
            raise ValueError("steps must be 1-40")
        done = 0
        while done < n and s.can_undo:
            s.undo()
            done += 1
        if done == 0:
            raise ValueError("nothing to undo")
        return {"undone": True, "steps": done}

    def _log(self, what, parts):
        self._journal.append({"what": what, "parts": parts})

    def _a_revert(self, steps=1, preview=False, skip=False):
        """Takes back the bridge's own last changes, newest first, only where nobody changed them since."""
        n = int(steps)
        if not (1 <= n <= 20):
            raise ValueError("steps must be 1-20")
        if not self._journal:
            raise ValueError("the bridge has no changes of its own to revert (since Live started, or they're all reverted)")
        if preview:
            out = []
            for entry in list(self._journal)[::-1][:n]:
                states = [p.state() for p in entry["parts"]]
                why = [w for st, w in states if st == "changed"]
                out.append({"what": entry["what"],
                            "can_revert": not why and any(st == "left" for st, _ in states),
                            "already_back": all(st == "back" for st, _ in states),
                            "why_not": "; ".join(why) or None})
            return {"newest_first": out, "in_list": len(self._journal)}
        if skip:
            dropped = [self._journal.pop()["what"] for _ in range(min(n, len(self._journal)))]
            return {"dropped_from_list": dropped, "note": "Nothing in Live was changed."}
        return self._revert_job(n)

    def _revert_job(self, n):
        done = []
        for _ in range(n):
            if not self._journal:
                break
            entry = self._journal[-1]
            states = [(p, p.state()) for p in entry["parts"]]
            why = [w for p, (st, w) in states if st == "changed"]
            if why:
                stop = {"what": entry["what"], "why": "; ".join(why)}
                if not done:
                    raise ValueError("didn't revert %s: %s. Nothing was changed. Ask the user; to leave it and go further "
                                     "back, use skip" % (entry["what"], stop["why"]))
                return {"reverted": done, "stopped_at": stop, "left_in_list": len(self._journal)}
            for p, (st, w) in reversed(states):
                if st == "left":
                    r = p.revert()
                    if isinstance(r, types.GeneratorType):
                        yield from r
            self._journal.pop()
            done.append({"what": entry["what"],
                         "result": "already back" if all(st == "back" for p, (st, w) in states) else "reverted"})
            yield
        return {"reverted": done, "left_in_list": len(self._journal)}

    def _a_show_on_keys(self, notes, label=""):
        if not isinstance(notes, list) or not notes:
            raise ValueError("notes must be a non-empty list of MIDI note numbers")
        clean = []
        for n in notes:
            if isinstance(n, bool) or not isinstance(n, (int, float)) or int(n) != n:
                raise ValueError("every note must be a whole number from 0 to 127")
            n = int(n)
            if not (0 <= n <= 127):
                raise ValueError("note %d is outside 0-127" % n)
            clean.append(n)
        clean = sorted(set(clean))
        if len(clean) > MAX_SHOW_NOTES:
            raise ValueError("too many notes (max %d)" % MAX_SHOW_NOTES)
        text = ("" if label is None else str(label)).strip()[:MAX_LABEL].strip()
        self._osc_send("/cc/show", [text] + clean)
        with self._cc_lock:
            self._last_shown = {"label": text, "notes": clean, "at": int(time.time() * 1000)}
        device, ago = self._device_state()
        return {"label": text, "notes": clean, "device": device, "device_seen_ms_ago": ago}

    def _a_clear_keys(self):
        self._osc_send("/cc/clear")
        with self._cc_lock:
            self._last_shown = None
        device, ago = self._device_state()
        return {"cleared": True, "device": device, "device_seen_ms_ago": ago}

    def _a_get_played(self):
        now = int(time.time() * 1000)
        device, ago = self._device_state()
        with self._cc_lock:
            self._prune(now)
            events = [dict(e) for e in self._events]
            held = sorted(self._held)
            shown = dict(self._last_shown) if self._last_shown else None
        return {"now": now, "device": device, "device_seen_ms_ago": ago, "held": held,
                "events": events, "shown": shown}

    # ---- device settings: read and turn one knob at a time (Live's undo takes it back) ----

    def _find_device(self, track, device):
        """A device by index or name, or by a path into racks: "808 Rack > Kick > Saturator" (rack, chain, device;
        the chain can be left out when the rack has one). Returns (label, device, owner), where owner is the track or
        chain whose devices list holds it."""
        t = self._track(track)
        if isinstance(device, bool):
            raise ValueError("device must be an index or a name")
        parts = [p.strip() for p in str(device).split(">")] if isinstance(device, str) else [device]
        owner, label, d = t, [], None
        while parts:
            part = parts.pop(0)
            devs = list(owner.devices)
            if not devs:
                raise ValueError("%s has no devices" % (" > ".join(label) or "track %d" % int(track)))
            if isinstance(part, (int, float)) or str(part).isdigit():
                j = int(part)
                if not (0 <= j < len(devs)):
                    raise ValueError("device %d doesn't exist in %s (it has %d, numbered from 0)" % (
                        j, " > ".join(label) or "track %d" % int(track), len(devs)))
                d = devs[j]
            else:
                d = _pick(devs, str(part), _dev_name, "device", "in %s" % (" > ".join(label) or "track %d" % int(track)))
            label.append(_dev_name(d))
            if not parts:
                break
            chains = list(getattr(d, "chains", ()) or ()) if getattr(d, "can_have_chains", False) else []
            if not chains:
                raise ValueError("%s isn't a rack, so there's nothing inside it" % _dev_name(d))
            named = [c for c in chains if str(c.name).strip().lower() == parts[0].strip().lower()]
            if named or len(chains) != 1:
                chain = named[0] if named else _pick(chains, parts[0], lambda c: str(c.name), "chain", "in %s" % _dev_name(d))
                parts.pop(0)
                label.append(str(chain.name))
                if not parts:
                    raise ValueError("say which device in the chain %s (rack > chain > device)" % chain.name)
            else:
                chain = chains[0]
            owner = chain
        return " > ".join(label), d, owner

    def _device(self, track, device):
        """A device on the track, by index (from 0), name, or a path into racks ("Rack > Chain > Device").
        "mixer" is the track's own volume, pan and sends. Returns (name, [(param name, param)], device)."""
        t = self._track(track)
        if isinstance(device, str) and ">" in device:
            label, d, _ = self._find_device(track, device)
            return label, [(str(p.name), p) for p in d.parameters], d
        if isinstance(device, str) and device.strip().lower() == "mixer":
            m = t.mixer_device
            params = [("Volume", m.volume), ("Pan", m.panning)]
            for i, s in enumerate(getattr(m, "sends", ()) or ()):
                params.append(("Send %s" % chr(ord("A") + i), s))
            return "Mixer", params, None
        devs = list(t.devices)
        if not devs:
            raise ValueError("track %d has no devices" % int(track))
        if isinstance(device, bool):
            raise ValueError("device must be an index or a name")
        if isinstance(device, (int, float)) or (isinstance(device, str) and device.strip().isdigit()):
            j = int(device)
            if not (0 <= j < len(devs)):
                raise ValueError("device %d doesn't exist on track %d (it has %d, numbered from 0)" % (j, int(track), len(devs)))
            d = devs[j]
        else:
            d = _pick(devs, str(device), _dev_name, "device", "on track %d" % int(track))
        return _dev_name(d), [(str(p.name), p) for p in d.parameters], d

    def _a_get_device_params(self, track, device):
        name, params, d = self._device(track, device)
        out = []
        for i, (pname, p) in enumerate(params):
            info = _param_info(i, p)
            info["name"] = pname
            out.append(info)
        res = {"track": int(track), "device": name, "params": out}
        if d is not None and getattr(d, "can_have_chains", False) and not getattr(d, "can_have_drum_pads", False):
            res["chains"] = [{"name": str(c.name), "devices": [_dev_name(x) for x in c.devices]}
                             for c in list(d.chains)[:32]]
            res["note"] = 'Reach inside with device "%s > chain > device"' % name
        return res

    def _param(self, track, device, param):
        """(device name, param name, param, device) for a knob on a track's device (or "mixer")."""
        dname, params, dev = self._device(track, device)
        if isinstance(param, bool):
            raise ValueError("param must be an index or a name")
        if isinstance(param, (int, float)) or (isinstance(param, str) and param.strip().isdigit()):
            k = int(param)
            if not (0 <= k < len(params)):
                raise ValueError("%s has no parameter %d (it has %d, numbered from 0)" % (dname, k, len(params)))
            pname, p = params[k]
        else:
            pname, p = _pick(params, str(param), lambda x: x[0], "parameter", "on %s" % dname)
        return dname, pname, p, dev

    def _target(self, p, pname, value=None, text=None, percent=None):
        """The raw value for a setting given as Live's display text, a percent of the range, or a raw value."""
        given = [x for x in (value, text, percent) if x is not None]
        if len(given) != 1:
            raise ValueError("give exactly one of value, text or percent")
        lo, hi = float(p.min), float(p.max)
        if text is not None:
            items = [str(x) for x in (getattr(p, "value_items", ()) or ())] if getattr(p, "is_quantized", False) else []
            hit = [i for i, it in enumerate(items) if it.strip().lower() == str(text).strip().lower()]
            step = _step_with_text(p, text) if not items else None
            if items and hit:
                v = lo + hit[0]
            elif items and _number_of(text) is None:
                raise ValueError("%s can be: %s" % (pname, ", ".join(items)))
            elif step is not None:
                v = step
            else:
                v = _set_by_text(p, str(text))
        elif percent is not None:
            pc = float(percent)
            if not (0 <= pc <= 100):
                raise ValueError("percent must be 0-100")
            v = lo + (hi - lo) * pc / 100.0
        else:
            v = float(value)
            if not (lo <= v <= hi):
                raise ValueError("%s takes values from %g to %g" % (pname, lo, hi))
        if getattr(p, "is_quantized", False):
            v = float(round(v))
        return max(lo, min(hi, v))

    def _a_set_device_param(self, track, device, param, value=None, text=None, percent=None):
        dname, pname, p, dev = self._param(track, device, param)
        if not getattr(p, "is_enabled", True):
            raise ValueError("%s on %s is locked (a macro or automation controls it)" % (pname, dname))
        before = _param_text(p)
        v = self._target(p, pname, value, text, percent)
        old = p.value
        p.value = v
        self._log("set %s on %s (track %d) from %s" % (pname, dname, int(track), before),
                  [_Attrs(p, "%s on %s" % (pname, dname), {"value": (old, p.value)}, close=1e-6)])
        out = {"track": int(track), "device": dname, "param": pname, "was": before, "now": _param_text(p),
               "value": float(p.value), "undo_steps": 1}
        if dev is not None and _is_plugin(dev):
            return self._settle_plugin_param(p, out)
        return out

    # ---- devices: move and delete (0.9.2) ----
    def _a_move_device(self, track, device, position=None, before=None, after=None):
        """Moves a device within its track or rack chain: to position (from 0), or before/after another device."""
        label, d, owner = self._find_device(track, device)
        if len([x for x in (position, before, after) if x is not None]) != 1:
            raise ValueError("give one of position, before or after")
        devs = list(owner.devices)
        old = [i for i, x in enumerate(devs) if x == d][0]
        if position is not None:
            to = int(position)
            if not (0 <= to < len(devs)):
                raise ValueError("position must be 0-%d" % (len(devs) - 1))
        else:
            other = _pick(devs, str(before if before is not None else after), _dev_name, "device", "next to %s" % label)
            if other == d:
                raise ValueError("a device can't go next to itself")
            j = [i for i, x in enumerate(devs) if x == other][0]
            to = j if before is not None else j + 1
            if old < to:
                to -= 1  # the list closes up once the device leaves its old place
        if to == old:
            return {"track": int(track), "device": label, "position": old, "devices": [_dev_name(x) for x in devs], "moved": False}
        s = self.song()
        if not hasattr(s, "move_device"):
            raise ValueError("this Live version can't move devices from a script")
        s.move_device(d, owner, to)
        now = [_dev_name(x) for x in owner.devices]
        at = [i for i, x in enumerate(owner.devices) if x == d][0]
        self._log("moved %s from position %d to %d" % (label, old, at),
                  [_DeviceMoved(s, owner, d, old, at, label)])
        return {"track": int(track), "device": label, "was": old, "position": at, "devices": now, "moved": True}

    def _a_delete_device(self, track, device, name):
        """Deletes one device, only when the user asks for it to go. The name must match, so a stale index can't
        delete the wrong one."""
        label, d, owner = self._find_device(track, device)
        if _dev_name(d).strip().lower() != str(name).strip().lower():
            raise ValueError("that device is %s, not %s, so nothing was deleted" % (_dev_name(d), name))
        devs = list(owner.devices)
        at = [i for i, x in enumerate(devs) if x == d][0]
        if not hasattr(owner, "delete_device"):
            raise ValueError("this Live version can't delete that device from a script")
        owner.delete_device(at)
        self._log("deleted %s on track %d" % (label, int(track)),
                  [_Fixed("deleting %s" % label, "use live_undo straight away to bring it back")])
        return {"track": int(track), "deleted": label, "devices": [_dev_name(x) for x in owner.devices]}

    # ---- meters (0.9.2) ----
    def _a_get_levels(self, track=None, seconds=1.5):
        """Generator: watches the output meters for a moment and reports each track's peak (0-1, Live's meter scale)."""
        s = self.song()
        secs = max(0.2, min(5.0, float(seconds)))
        tracks = list(s.tracks)
        if track is not None:
            self._track(track)
        pick = [(i, tracks[i]) for i in (range(len(tracks)) if track is None else [int(track)])]
        master = getattr(s, "master_track", None)
        if track is None and master is not None:
            pick.append(("main", master))
        peaks = dict((k, [0.0, 0.0, 0.0]) for k, _ in pick)
        end = time.time() + secs
        while True:
            for k, t in pick:
                p = peaks[k]
                p[0] = max(p[0], float(getattr(t, "output_meter_level", 0.0) or 0.0))
                p[1] = max(p[1], float(getattr(t, "output_meter_left", 0.0) or 0.0))
                p[2] = max(p[2], float(getattr(t, "output_meter_right", 0.0) or 0.0))
            if time.time() >= end:
                break
            yield
        out = []
        for k, t in pick:
            lvl, l, r = peaks[k]
            row = {"track": k, "name": str(t.name), "peak": round(lvl, 3), "left": round(l, 3), "right": round(r, 3)}
            try:
                row["about"] = _param_text(t.mixer_device.volume, lvl)  # a guess: the meter shares the fader's dB scale
            except Exception:
                pass
            row["reads"] = ("silent" if lvl < 0.01 else "low" if lvl < 0.5 else "healthy" if lvl < 0.85
                            else "hot" if lvl < 0.95 else "near the top")
            out.append(row)
        res = {"seconds": secs, "is_playing": bool(s.is_playing), "levels": out,
               "note": "peak is Live's meter value from 0 to 1. 'about' and the words are guesses at the dB scale."}
        if not s.is_playing:
            res["warning"] = "Live isn't playing, so most meters read 0. Play the part (or arm and speak/play into an input) first."
        return res

    # ---- clips: copy between Session slots, and move or delete on the Arrangement (0.9.2) ----
    def _a_copy_clip(self, track, slot, to_track, to_slot):
        src = self._slot(track, slot)
        if not src.has_clip:
            raise ValueError("track %d, slot %d is empty" % (int(track), int(slot)))
        dest = self._slot(to_track, to_slot)
        if dest.has_clip:
            raise ValueError("track %d, slot %d already has a clip; pick an empty slot" % (int(to_track), int(to_slot)))
        t = self._track(to_track)
        if bool(src.clip.is_midi_clip) != bool(t.has_midi_input):
            raise ValueError("a %s clip can't go on track %d" % ("MIDI" if src.clip.is_midi_clip else "audio", int(to_track)))
        if not hasattr(src, "duplicate_clip_to"):
            raise ValueError("this Live version can't copy clips from a script")
        src.duplicate_clip_to(dest)
        label = "the copy of %r in track %d, slot %d" % (src.clip.name, int(to_track), int(to_slot))
        self._log("copied " + label, [_SlotClipMade(dest, dest.clip, label)])
        return {"copied": src.clip.name, "to_track": int(to_track), "to_slot": int(to_slot)}

    def _arr_clip_at(self, t, i, bar, name):
        b = float(bar)
        start = (b - 1) * self._beats_per_bar()
        hit = [c for c in _arr(t) if abs(float(c.start_time) - start) < 0.01]
        if not hit:
            near = ", ".join("%r at bar %g" % (c.name, self._bar_of(c.start_time)) for c in _arr(t)[:20])
            raise ValueError("no clip starts at bar %g on track %d. Its clips: %s" % (b, i, near or "none"))
        named = [c for c in hit if str(c.name).strip().lower() == str(name).strip().lower()]
        if not named:
            raise ValueError("the clip at bar %g on track %d is %r, not %r, so nothing was changed" % (b, i, hit[0].name, name))
        return named[0]

    def _a_move_arrangement_clip(self, track, bar, name, to_bar, to_track=None):
        """Moves an Arrangement clip to another bar (and track), only when the user asks. Never covers clips."""
        i = int(track)
        t = self._track(i)
        c = self._arr_clip_at(t, i, bar, name)
        di = i if to_track is None else int(to_track)
        dt = self._track(di, regular=True)
        if bool(c.is_midi_clip) != bool(dt.has_midi_input):
            raise ValueError("a %s clip can't go on track %d" % ("MIDI" if c.is_midi_clip else "audio", di))
        nb = float(to_bar)
        if not (1 <= nb <= 10000):
            raise ValueError("to_bar must be 1 or more")
        start = (nb - 1) * self._beats_per_bar()
        end = start + float(c.end_time) - float(c.start_time)
        hit = [x for x in dt.arrangement_clips if x != c and float(x.start_time) < end - 1e-6 and float(x.end_time) > start + 1e-6]
        if hit:
            raise ValueError("track %d already has clips there (%s), and the bridge never covers clips" % (
                di, ", ".join("%r at bar %g" % (x.name, self._bar_of(x.start_time)) for x in hit)))
        old_start = float(c.start_time)
        before = list(dt.arrangement_clips)
        dt.duplicate_clip_to_arrangement(c, start)
        new = [x for x in dt.arrangement_clips if not any(x == y for y in before)]
        if not new:
            yield
            new = [x for x in dt.arrangement_clips if not any(x == y for y in before)]
        if len(new) != 1:
            raise ValueError("copied the clip but couldn't find the copy, so the original was left in place; check live_get_arrangement")
        t.delete_clip(c)
        label = "%r (now at bar %g on track %d)" % (new[0].name, nb, di)
        self._log("moved %r from bar %g to bar %g" % (str(name), float(bar), nb), [_ArrClipMoved(t, dt, new[0], old_start, label)])
        return {"moved": str(new[0].name), "from": {"track": i, "bar": float(bar)}, "to": self._arr_clip_info(new[0]),
                "to_track": di}

    def _a_delete_arrangement_clip(self, track, bar, name):
        """Deletes one Arrangement clip, only when the user asks for it to go. Its name and start bar must match."""
        i = int(track)
        t = self._track(i)
        c = self._arr_clip_at(t, i, bar, name)
        info = self._arr_clip_info(c)
        t.delete_clip(c)
        self._log("deleted the Arrangement clip %r at bar %g on track %d" % (info["name"], float(bar), i),
                  [_Fixed("deleting the clip %r" % info["name"], "use live_undo straight away to bring it back")])
        return {"track": i, "deleted": info}

    # ---- automation shapes (0.9.4): one engine for recorded and Session-clip automation ----
    def _rate_beats(self, rate):
        """A rate as beats: "1/4" (a quarter note = 1 beat), "1/8t" (triplet), "1/4d" (dotted), "1 bar", "2 bars",
        or a number of beats."""
        if isinstance(rate, bool):
            raise ValueError("rate must be like '1/4', '1 bar' or a number of beats")
        if isinstance(rate, (int, float)):
            b = float(rate)
        else:
            r = str(rate).strip().lower().replace(" ", "")
            mult = 1.0
            if r.endswith("t"):
                mult, r = 2.0 / 3.0, r[:-1]
            elif r.endswith("d"):
                mult, r = 1.5, r[:-1]
            m = re.match(r"^(\d+(?:\.\d+)?)bars?$", r)
            f = re.match(r"^(\d+)/(\d+)$", r)
            if m:
                b = float(m.group(1)) * self._beats_per_bar()
            elif f and int(f.group(2)) > 0:
                b = 4.0 * int(f.group(1)) / int(f.group(2))
            else:
                try:
                    b = float(r)
                except ValueError:
                    raise ValueError("rate %r isn't like '1/4', '1/8t', '1 bar' or a number of beats" % rate)
            b *= mult
        if not (0 < b <= 4096):
            raise ValueError("rate must be more than 0")
        return b

    def _lane(self, track, lane, a, b, locked_ok=False):
        """One knob's movement between bars a and b: a straight ramp (start/end), a curve, a list of points, or an
        LFO. Returns (dname, pname, param, f, summary), where f(beat) gives the knob's raw value at that beat
        (beats counted the same way as the bars: song time for the Arrangement, clip time for a Session clip)."""
        if not isinstance(lane, dict):
            raise ValueError("each lane is an object with device and param")
        tr = lane.get("track", track)
        dname, pname, p, dev = self._param(tr, lane.get("device"), lane.get("param"))
        if not locked_ok and not getattr(p, "is_enabled", True):
            raise ValueError("%s on %s is locked (a macro or automation controls it)" % (pname, dname))

        def spec(d, what):
            if not isinstance(d, dict):
                raise ValueError("%s is {text}, {percent} or {value}" % what)
            return self._target(p, pname, **dict((k, d.get(k)) for k in ("value", "text", "percent")))

        bpb = self._beats_per_bar()
        s_beat, e_beat = (a - 1) * bpb, (b - 1) * bpb
        lo_v, hi_v = float(p.min), float(p.max)
        curve = str(lane.get("curve") or "linear").strip().lower().replace("-", "_").replace(" ", "_")
        if curve not in CURVES:
            raise ValueError("curve can be: %s" % ", ".join(sorted(CURVES)))
        lfo = lane.get("lfo")
        if lfo is not None:
            if not isinstance(lfo, dict):
                raise ValueError("lfo is {shape, rate, low, high, phase}")
            shape = str(lfo.get("shape") or "sine").strip().lower().replace("-", "_").replace(" ", "_")
            if shape not in LFO_SHAPES:
                raise ValueError("lfo shape can be: %s" % ", ".join(LFO_SHAPES))
            period = self._rate_beats(lfo.get("rate", "1 bar"))
            low = spec(lfo.get("low", {"percent": 0}), "low")
            high = spec(lfo.get("high", {"percent": 100}), "high")
            phase = float(lfo.get("phase", 0.0)) % 1.0
            rnd, cache = random.Random(int(lfo.get("seed", 7))), {}

            def f(t):
                x = (t - s_beat) / period + phase
                cyc = int(math.floor(x))
                u = x - cyc
                if shape == "sine":
                    y = 0.5 - 0.5 * math.cos(2 * math.pi * u)
                elif shape == "triangle":
                    y = 2 * u if u < 0.5 else 2 - 2 * u
                elif shape == "square":
                    y = 1.0 if u >= 0.5 else 0.0
                elif shape == "saw_up":
                    y = u
                elif shape == "saw_down":
                    y = 1 - u
                else:  # random: a new level each cycle
                    if cyc not in cache:
                        cache[cyc] = rnd.random()
                    y = cache[cyc]
                return low + (high - low) * y
            summary = {"lfo": shape, "rate_beats": round(period, 4), "low": _param_text(p, low), "high": _param_text(p, high)}
            return dname, pname, p, f, summary, period
        points = lane.get("points")
        if points is not None:
            if not isinstance(points, list) or len(points) < 2:
                raise ValueError("points needs at least two {bar, text|percent|value}")
            pts = []
            for pt in points:
                if not isinstance(pt, dict) or "bar" not in pt:
                    raise ValueError("each point is {bar, text|percent|value}, with an optional curve to the next point")
                c = str(pt.get("curve") or curve).strip().lower().replace("-", "_").replace(" ", "_")
                if c not in CURVES:
                    raise ValueError("curve can be: %s" % ", ".join(sorted(CURVES)))
                pts.append(((float(pt["bar"]) - 1) * bpb, spec(pt, "a point"), c))
            pts.sort(key=lambda x: x[0])
        else:
            if lane.get("start") is None or lane.get("end") is None:
                raise ValueError("give start and end, or points, or lfo")
            pts = [(s_beat, spec(lane["start"], "start"), curve), (e_beat, spec(lane["end"], "end"), curve)]

        def f(t):
            if t <= pts[0][0]:
                return pts[0][1]
            for (t0, v0, c), (t1, v1, _) in zip(pts, pts[1:]):
                if t <= t1:
                    x = 0.0 if t1 <= t0 else (t - t0) / (t1 - t0)
                    return v0 + (v1 - v0) * CURVES[c](x)
            return pts[-1][1]
        summary = {"points": [{"bar": round(t0 / bpb + 1, 3), "setting": _param_text(p, v)} for t0, v, _ in pts], "curve": curve}
        return dname, pname, p, f, summary, None

    def _lanes_from(self, track, device, param, start, end, curve, points, lfo, lanes):
        if lanes is not None:
            if not isinstance(lanes, list) or not lanes:
                raise ValueError("lanes is a list of {device, param, and start/end, points or lfo}")
            if len(lanes) > 8:
                raise ValueError("at most 8 lanes at once")
            return lanes
        return [{"device": device, "param": param, "start": start, "end": end, "curve": curve, "points": points, "lfo": lfo}]

    @staticmethod
    def _clamp_for(p, v):
        v = max(float(p.min), min(float(p.max), v))
        return float(round(v)) if getattr(p, "is_quantized", False) else v

    # ---- recorded automation (0.9.3): the Arrangement's own automation lane, recorded like a controller knob ----
    def _a_record_automation(self, track, from_bar, to_bar, device=None, param=None, start=None, end=None,
                             curve=None, points=None, lfo=None, lanes=None, hold_to_bar=None):
        """Generator: records knob movements onto the tracks' Arrangement automation lanes, the way a hand on a
        controller would. Live plays from one bar before from_bar, Arrangement Record punches in, every lane's
        knob moves along its shape (each marked as one gesture) until to_bar (or holds its end value until
        hold_to_bar), then record punches out and everything is put back.
        Live only writes while a knob moves (checked 2026-11-12), so:
        - a lane with no automation yet first gets its current value recorded in the bar before from_bar, or Live
          would hold the first recorded value backwards to the start of the song;
        - wherever a knob should stay still (a flat take, a hold), it's nudged by a tiny step each tick so Live
          keeps writing."""
        s = self.song()
        a, b = float(from_bar), float(to_bar)
        if not (1 <= a < b <= 10000):
            raise ValueError("from_bar must be 1 or more and before to_bar")
        bpb = self._beats_per_bar()
        s_beat, e_beat = (a - 1) * bpb, (b - 1) * bpb
        if hold_to_bar is None:
            h_beat = e_beat
        else:
            if isinstance(hold_to_bar, str) and hold_to_bar.strip().lower() == "end":
                ends = [float(c.end_time) for t in s.tracks for c in _arr(t)]
                if not ends:
                    raise ValueError("there are no Arrangement clips, so there's no song end to hold to; give a bar")
                h_beat = max(ends)
            else:
                h_beat = (float(hold_to_bar) - 1) * bpb
            if h_beat <= e_beat:
                raise ValueError("hold_to_bar must be after to_bar")
        built = [self._lane(track, ln, a, b) for ln in self._lanes_from(track, device, param, start, end, curve, points, lfo, lanes)]
        if len(set(id(x[2]) for x in built)) != len(built):
            raise ValueError("two lanes move the same knob")
        for dname, pname, p, f, summary, period in built:
            if not hasattr(p, "begin_gesture"):
                raise ValueError("this Live version can't record automation from a script")
            if period is not None and period * 60.0 / float(s.tempo) < MIN_LFO_SECONDS:
                raise ValueError("the %s wobble on %s repeats every %.2f seconds, too fast to record cleanly (the bridge "
                                 "gets about 10 updates a second). Use a slower rate, Live's LFO device, or a Session clip "
                                 "with live_automate (no speed limit)" % (summary["lfo"], pname, period * 60.0 / float(s.tempo)))
        if s.is_playing:
            raise ValueError("Live is playing. Stop it first: recording the automation plays the bars itself")
        pre = max(0.0, s_beat - bpb)
        secs = (h_beat - pre) * 60.0 / float(s.tempo)
        if secs > MAX_RECORD_SECONDS:
            raise ValueError("that takes %d seconds to play; split it into parts under %d seconds" % (secs, MAX_RECORD_SECONDS))
        # Per lane: [dname, pname, p, f, summary, keep_old (value to hold before from_bar, or None), last written, nudge sign]
        work = []
        for dname, pname, p, f, summary, period in built:
            fresh = int(getattr(p, "automation_state", 0) or 0) == 0
            keep = float(p.value) if fresh and pre < s_beat else None
            work.append([dname, pname, p, f, summary, keep, None, 1.0])
        rec_from = pre if any(w[5] is not None for w in work) else s_beat
        armed = [t for t in s.tracks if getattr(t, "can_be_armed", False) and t.arm]
        saved = {"record_mode": bool(s.record_mode), "time": float(s.current_song_time)}
        for attr in ("loop", "session_automation_record", "back_to_arranger"):
            if hasattr(s, attr):
                saved[attr] = getattr(s, attr)
        recording, steps, stopped_by_hand = False, 0, False
        touched = set()

        def write(w, v):
            p = w[2]
            v = self._clamp_for(p, v)
            if w[6] is not None and abs(v - w[6]) < 1e-9 and not getattr(p, "is_quantized", False):
                # Live only writes while the knob moves: nudge by a tiny step (about 1/10000 of the range).
                eps = (float(p.max) - float(p.min)) * 1e-4
                w[7] = -w[7]
                v2 = v + eps * w[7]
                if v2 > float(p.max) or v2 < float(p.min):
                    v2 = v - eps * w[7]
                p.value = v2
            else:
                p.value = v
            w[6] = v

        try:
            for t in armed:
                t.arm = False  # otherwise the take would also record audio or MIDI on them
            if "loop" in saved:
                s.loop = False
            if "session_automation_record" in saved:
                s.session_automation_record = True  # Live's Automation Arm button
            if "back_to_arranger" in saved:
                s.back_to_arranger = False
            for w in work:
                if w[5] is None:
                    w[2].value = self._clamp_for(w[2], w[3](s_beat))
            s.current_song_time = pre
            if rec_from <= 1e-6:
                # From the very start of the song: punch in before playing, so the take also covers time 0
                # (a take that punched in a tick late left the old point at 0 in place; seen 2026-11-12).
                s.record_mode = True
                recording = True
                for w in work:
                    if w[5] is not None or s_beat <= 1e-6:
                        w[2].begin_gesture()
                        touched.add(id(w[2]))
                        write(w, w[5] if w[5] is not None and s_beat > 1e-6 else w[3](0.0))
            s.start_playing()
            yield
            while True:
                if not s.is_playing:
                    stopped_by_hand = True
                    break
                now = float(s.current_song_time)
                if not recording and now >= rec_from - 1e-3:
                    s.record_mode = True
                    recording = True
                if recording:
                    for w in work:
                        if now < s_beat - 1e-3:
                            if w[5] is None:
                                continue  # this lane already has automation: leave the bar before alone
                            v = w[5]
                        else:
                            v = w[3](min(now, e_beat))
                        if id(w[2]) not in touched:
                            w[2].begin_gesture()
                            touched.add(id(w[2]))
                        write(w, v)
                    steps += 1
                if now >= h_beat:
                    for w in work:
                        write(w, w[3](e_beat))
                    break
                yield
        finally:
            for w in work:
                if id(w[2]) in touched:
                    try:
                        w[2].end_gesture()
                    except Exception:
                        pass
            s.record_mode = saved["record_mode"]
            s.stop_playing()
            for attr in ("loop", "session_automation_record", "back_to_arranger"):
                if attr in saved:
                    try:
                        setattr(s, attr, saved[attr])
                    except Exception:
                        pass
            s.current_song_time = saved["time"]
            for t in armed:
                try:
                    t.arm = True
                except Exception:
                    pass
        read_back = None
        if recording and not stopped_by_hand:
            # Check the take the way the user would: the knob's setting before, inside and after the ramp.
            last = self._bar_of(h_beat)
            bars = [x for x in (a - 0.5, a, a + 0.1 if b - a > 0.2 else None, (a + b) / 2.0, b,
                                last if hold_to_bar is not None else None, last + 0.5)
                    if x is not None and x >= 1]
            read_back = yield from self._read_back([(w[0], w[1], w[2]) for w in work], sorted(set(bars)), saved["time"])
        names = ", ".join("%s on %s" % (w[1], w[0]) for w in work)
        self._log("recorded automation for %s, bars %g to %g" % (names, a, b),
                  [_Fixed("the recorded automation (%s)" % names, "Live's own undo takes a recording back: use live_undo straight away")])
        lanes_out = []
        for w in work:
            row = dict({"device": w[0], "param": w[1]}, **w[4])
            if w[5] is not None:
                row["kept_before"] = "%s (the lane was empty, so the bar before from_bar keeps the old setting)" % _param_text(w[2], w[5])
            lanes_out.append(row)
        out = {"from_bar": a, "to_bar": b, "steps": steps, "recorded": recording and not stopped_by_hand, "lanes": lanes_out,
               "note": "Recorded onto the tracks' own Arrangement automation lanes, over any automation already in those bars. "
                       "After the take, the lane goes on with whatever automation it had later. The knobs now follow the "
                       "automation. live_undo straight away takes the take back."}
        if hold_to_bar is not None:
            out["held_to_bar"] = self._bar_of(h_beat)
        if read_back is not None:
            # Compare each reading with what the take was meant to leave there, and flag what doesn't match.
            bpb_ = self._beats_per_bar()
            wrong = []
            for r in read_back:
                raw = r.pop("_raw", [])
                beat = (r["bar"] - 1) * bpb_
                for w, got in zip(work, raw):
                    if s_beat > 1e-6 and abs(beat - s_beat) < 1e-6:
                        want = None  # the old and the new setting meet exactly here: either reading is right
                    elif beat < s_beat - 1e-6:
                        want = w[5]  # only lanes that were empty: the bar before keeps the old setting
                    elif beat <= e_beat + 1e-6:
                        want = w[3](beat)
                    elif beat <= h_beat + 1e-6 and hold_to_bar is not None:
                        want = w[3](e_beat)
                    else:
                        want = None  # after the take the lane goes on with what it had: nothing to compare
                    if want is None:
                        continue
                    want = self._clamp_for(w[2], want)
                    if abs(got - want) > (float(w[2].max) - float(w[2].min)) * 0.01:
                        wrong.append({"bar": r["bar"], "knob": "%s on %s" % (w[1], w[0]),
                                      "expected": _param_text(w[2], want), "got": _param_text(w[2], got)})
            out["read_back"] = read_back
            out["read_back_ok"] = not wrong
            if wrong:
                out["read_back_mismatch"] = wrong
                out["warning"] = "Some bars don't read back as planned; tell the user which, and check them in the lane."
                if any(abs(x["bar"] - 1.0) < 1e-6 for x in wrong):
                    out["warning"] += (" At bar 1: Live writes a take's first value a moment late, so a take can't reach "
                                       "the very start of the song. An old point there has to be deleted by hand (click it "
                                       "in the lane, press Delete).")
        if len(work) == 1:
            out.update({"device": work[0][0], "param": work[0][1],
                        "start": _param_text(work[0][2], work[0][3](s_beat)), "end": _param_text(work[0][2], work[0][3](e_beat))})
        if armed:
            out["re_armed"] = [str(t.name) for t in armed]
        if stopped_by_hand:
            out["warning"] = "Live was stopped part way, so only part was recorded"
        elif not recording:
            out["warning"] = "nothing was recorded"
        return out

    # ---- playing a range, Melodyne Transfer, and bouncing a track (0.9.4) ----
    def _save_transport(self):
        s = self.song()
        saved = {"record_mode": bool(s.record_mode), "time": float(s.current_song_time)}
        for attr in ("loop", "back_to_arranger"):
            if hasattr(s, attr):
                saved[attr] = getattr(s, attr)
        return saved

    def _restore_transport(self, saved):
        s = self.song()
        s.record_mode = saved["record_mode"]
        s.stop_playing()
        for attr in ("loop", "back_to_arranger"):
            if attr in saved:
                try:
                    setattr(s, attr, saved[attr])
                except Exception:
                    pass
        s.current_song_time = saved["time"]

    def _range(self, from_bar, to_bar):
        s = self.song()
        a, b = float(from_bar), float(to_bar)
        if not (1 <= a < b <= 10000):
            raise ValueError("from_bar must be 1 or more and before to_bar")
        if s.is_playing:
            raise ValueError("Live is playing. Stop it first: this plays the bars itself")
        bpb = self._beats_per_bar()
        return a, b, (a - 1) * bpb, (b - 1) * bpb, bpb

    def _a_play_range(self, from_bar, to_bar, melodyne_track=None):
        """Generator: plays the Arrangement from from_bar to to_bar once, then stops and puts the loop and the play
        position back. With melodyne_track, first checks Melodyne is the first device there and that the track has
        clips in those bars (Melodyne's Transfer has to hear the part played in real time)."""
        s = self.song()
        a, b, s_beat, e_beat, bpb = self._range(from_bar, to_bar)
        secs = (e_beat - s_beat) * 60.0 / float(s.tempo)
        if secs > MAX_RECORD_SECONDS:
            raise ValueError("that takes %d seconds to play; split it into parts under %d seconds" % (secs, MAX_RECORD_SECONDS))
        mel = None
        if melodyne_track is not None:
            t = self._track(melodyne_track)
            devs = list(t.devices)
            hits = [i for i, d in enumerate(devs) if "melodyne" in _dev_name(d).lower()]
            if not hits:
                raise ValueError("track %d (%s) has no Melodyne. Load it first, as the first device: live_load_device "
                                 "with name 'Melodyne' and tree 'plugins', then live_move_device to position 0" % (int(melodyne_track), t.name))
            if hits[0] != 0:
                raise ValueError("Melodyne is device %d on %s, so it would hear the devices before it. Move it first: "
                                 "live_move_device with position 0" % (hits[0], t.name))
            if not [c for c in _arr(t)
                    if float(c.start_time) < e_beat - 1e-6 and float(c.end_time) > s_beat + 1e-6]:
                raise ValueError("%s has no clips between bars %g and %g, so there's nothing for Melodyne to hear" % (t.name, a, b))
            mel = _dev_name(devs[0])
        saved = self._save_transport()
        stopped_by_hand = False
        try:
            if "loop" in saved:
                s.loop = False
            if "back_to_arranger" in saved:
                s.back_to_arranger = False
            s.current_song_time = s_beat
            s.start_playing()
            yield
            while True:
                if not s.is_playing:
                    stopped_by_hand = True
                    break
                if float(s.current_song_time) >= e_beat:
                    break
                yield
        finally:
            self._restore_transport(saved)
        out = {"from_bar": a, "to_bar": b, "seconds": round(secs, 1), "played": not stopped_by_hand}
        if mel:
            out["melodyne"] = mel
            out["note"] = ("Melodyne should now show the notes for bars %g-%g. If it shows nothing, Transfer wasn't on: "
                           "press Transfer in Melodyne and run this again." % (a, b))
        if stopped_by_hand:
            out["warning"] = "Live was stopped part way, so only part was played"
        return out

    def _a_bounce_track(self, track, from_bar, to_bar, name=None, channel="Post FX"):
        """Generator: records a track's sound (its Post FX output by default, so Melodyne and effects are included)
        onto a new audio track over the bars, like resampling. The original is left as it is."""
        s = self.song()
        a, b, s_beat, e_beat, bpb = self._range(from_bar, to_bar)
        i = int(track)
        src = self._track(i)
        pre = max(0.0, s_beat - bpb)
        secs = (e_beat - pre) * 60.0 / float(s.tempo)
        if secs > MAX_RECORD_SECONDS:
            raise ValueError("that takes %d seconds to play; split it into parts under %d seconds" % (secs, MAX_RECORD_SECONDS))
        if not hasattr(s, "create_audio_track"):
            raise ValueError("this Live version can't make audio tracks from a script")
        before = list(s.tracks)
        # A group's print goes at the end: right after the group it would land inside it and feed back into it.
        is_group = bool(_safe(lambda: src.is_foldable, False))
        s.create_audio_track(-1 if is_group else i + 1)
        made = [(n, x) for n, x in enumerate(s.tracks) if not any(x == y for y in before)]
        if len(made) != 1:
            raise ValueError("made a track but couldn't tell which one it is; check live_status")
        ni, new = made[0]
        new.name = str(name).strip()[:100] if name else "%s (bounce)" % src.name
        types_ = list(new.available_input_routing_types)
        exact = [x for x in types_ if _rname(x).strip().lower() == ("%d-%s" % (i + 1, src.name)).lower()]
        new.input_routing_type = exact[0] if exact else _choose_route(types_, src.name, "source")
        yield  # Live refreshes the channel list for the source
        new.input_routing_channel = _choose_route(list(new.available_input_routing_channels), channel, "channel")
        if hasattr(new, "current_monitoring_state"):
            new.current_monitoring_state = MONITOR_VALUES["off"]  # hearing the source through both tracks would double it
        inside = _safe(lambda: bool(new.is_grouped), False) and is_group
        if inside:
            try:  # Live still put it in the group: send it straight to Main so it doesn't pass through the group again
                new.output_routing_type = _choose_route(list(new.available_output_routing_types), "Main", "output")
                inside = False
            except Exception:
                try:
                    new.output_routing_type = _choose_route(list(new.available_output_routing_types), "Master", "output")
                    inside = False
                except Exception:
                    pass
        armed = [t for t in s.tracks if getattr(t, "can_be_armed", False) and t.arm and t != new]
        saved = self._save_transport()
        # Punch in and out on the loop brace give the take exact edges. Punching in by hand is up to a display
        # tick late (real Live: the print started 80 ms after the bar).
        punch = all(hasattr(s, x) for x in ("punch_in", "punch_out", "loop_start", "loop_length"))
        if punch:
            saved_punch = (bool(s.punch_in), bool(s.punch_out), float(s.loop_start), float(s.loop_length))
        recording, stopped_by_hand = False, False
        try:
            for t in armed:
                t.arm = False
            new.arm = True
            if "loop" in saved:
                s.loop = False
            if "back_to_arranger" in saved:
                s.back_to_arranger = False
            if punch:
                try:
                    s.loop_start = s_beat
                    s.loop_length = e_beat - s_beat
                except Exception:
                    s.loop_length = e_beat - s_beat
                    s.loop_start = s_beat
                s.punch_in, s.punch_out = True, True
            s.current_song_time = pre
            if punch:
                s.record_mode = True
                recording = True
            s.start_playing()
            yield
            while True:
                if not s.is_playing:
                    stopped_by_hand = True
                    break
                now = float(s.current_song_time)
                if not recording and now >= s_beat - 1e-3:
                    s.record_mode = True
                    recording = True
                if now >= e_beat + (0.5 if punch else 0.0):
                    break
                yield
        finally:
            self._restore_transport(saved)
            if punch:
                try:
                    s.punch_in, s.punch_out = saved_punch[0], saved_punch[1]
                    try:
                        s.loop_start = saved_punch[2]
                        s.loop_length = saved_punch[3]
                    except Exception:
                        s.loop_length = saved_punch[3]
                        s.loop_start = saved_punch[2]
                except Exception:
                    pass
            try:
                new.arm = False
            except Exception:
                pass
            try:  # the print is done: stop it listening to the source, so nothing can loop back
                new.input_routing_type = _choose_route(list(new.available_input_routing_types), "No Input", "source")
            except Exception:
                pass
            for t in armed:
                try:
                    t.arm = True
                except Exception:
                    pass
        yield  # the new clip shows up on the next tick
        clips = [self._arr_clip_info(c) for c in sorted(_arr(new), key=lambda c: float(c.start_time))]
        self._log("bounced %s, bars %g to %g, onto the new track %r" % (src.name, a, b, new.name),
                  [_Fixed("the bounce track %r" % new.name, "use live_undo straight away, or the user deletes the track")])
        out = {"track": ni, "name": new.name, "source": {"track": i, "name": src.name, "channel": str(channel)},
               "from_bar": a, "to_bar": b, "clips": clips, "recorded": recording and not stopped_by_hand,
               "note": "The original track is unchanged. Mute it or switch it off (its Track Activator) so you don't hear both; "
                       "for Melodyne, the edits are now printed as audio, and Melodyne can come off the original to save CPU."}
        if armed:
            out["re_armed"] = [str(t.name) for t in armed]
        if stopped_by_hand:
            out["warning"] = "Live was stopped part way, so only part was recorded"
        elif not clips:
            out["warning"] = "no clip showed up on the new track; check it in Live"
        if inside:
            out["warning"] = (out.get("warning", "") + " The print landed inside the group and still plays through it: "
                              "set its Audio To to Main, or drag it out of the group.").strip()
        if is_group:
            out["placed"] = "at the end of the track list, outside the group"
        return out

    def _read_back(self, lanes, bars, restore_time):
        """Generator: moves the play position to each bar (Live stopped), lets Live apply the automation, and reads
        each knob's setting. Puts the play position back."""
        s = self.song()
        bpb = self._beats_per_bar()
        rows = []
        try:
            for bar in bars:
                s.current_song_time = (float(bar) - 1) * bpb
                yield
                yield
                rows.append({"bar": round(float(bar), 3),
                             "settings": dict(("%s on %s" % (pname, dname), _param_text(p)) for dname, pname, p in lanes),
                             "_raw": [float(p.value) for dname, pname, p in lanes]})
        finally:
            s.current_song_time = restore_time
        return rows

    def _a_read_knob(self, track, device, param, bars):
        """Generator: a knob's setting at each bar, as its automation leaves it (read-only, Live must be stopped)."""
        s = self.song()
        dname, pname, p, dev = self._param(track, device, param)
        if not isinstance(bars, list) or not bars or len(bars) > 32:
            raise ValueError("bars is a list of 1-32 bar numbers")
        clean = []
        for x in bars:
            if isinstance(x, bool) or not isinstance(x, (int, float)) or not (1 <= float(x) <= 10000):
                raise ValueError("each bar is a number from 1")
            clean.append(float(x))
        if s.is_playing:
            raise ValueError("Live is playing; stop it first, so moving the play position doesn't jump the music")
        if dev is not None and _is_plugin(dev):
            raise ValueError("a plugin knob shows its setting a moment late, so a read-back can't be trusted; "
                             "use percent values from live_get_device after moving the play position by hand")
        rows = yield from self._read_back([(dname, pname, p)], clean, float(s.current_song_time))
        for r in rows:
            r.pop("_raw", None)
        state = int(getattr(p, "automation_state", 0) or 0)
        return {"track": int(track), "device": dname, "param": pname, "automated": state != 0,
                "at": [{"bar": r["bar"], "setting": list(r["settings"].values())[0]} for r in rows]}

    # ---- Session-clip automation (0.9.0, shapes 0.9.4): written straight into the clip's envelope ----
    def _a_automate(self, track, from_bar, to_bar, device=None, param=None, start=None, end=None, slot=None,
                    curve=None, points=None, lfo=None):
        """Writes a shape into a Session clip's envelope (bars count from the clip's start). Live refuses clip
        envelopes in Arrangement clips (checked 2026-11-12), so the Arrangement goes through record_automation."""
        if slot is None:
            raise ValueError("Live doesn't let scripts write automation into Arrangement clips. For the Arrangement, "
                             "use live_record_automation: it records it onto the track's own automation lane, the way a "
                             "controller knob would. For a Session clip, give slot")
        a, b = float(from_bar), float(to_bar)
        if not (1 <= a < b <= 10000):
            raise ValueError("from_bar must be 1 or more and before to_bar")
        dname, pname, p, f, summary, period = self._lane(track, {"device": device, "param": param, "start": start, "end": end,
                                                                 "curve": curve, "points": points, "lfo": lfo}, a, b, locked_ok=True)
        c = self._clip(track, slot)
        label = "the Session clip in slot %d" % int(slot)
        bpb = self._beats_per_bar()
        s0, s1 = (a - 1) * bpb, (b - 1) * bpb
        if not hasattr(c, "automation_envelope"):
            raise ValueError("this Live version can't write automation from a script")
        env = c.automation_envelope(p)
        made = env is None
        if made:
            env = c.create_automation_envelope(p)
            if env is None:
                raise ValueError("Live won't take %s automation in %s" % (pname, label))
        span = s1 - s0
        step = 0.25 if period is None else min(0.25, period / 16.0)
        n = max(1, min(2048, int(round(span / step))))
        step = span / n
        for k in range(n):
            env.insert_step(s0 + k * step, step, self._clamp_for(p, f(s0 + (k + 0.5) * step)))
        if made:
            parts = [_EnvMade(c, p, "the %s automation in %s" % (pname, label))]
        else:
            parts = [_Fixed("the %s automation in %s" % (pname, label),
                            "it was written over automation that was already there; use live_undo straight away")]
        self._log("automated %s on %s (track %d, slot %d), bars %g to %g" % (pname, dname, int(track), int(slot), a, b), parts)
        return dict({"track": int(track), "slot": int(slot), "device": dname, "param": pname, "from_bar": a, "to_bar": b,
                     "start": _param_text(p, f(s0)), "end": _param_text(p, f(s1)), "clips": [label], "steps": n,
                     "revertible": made}, **summary)

    def _settle_plugin_param(self, p, out):
        """Generator: a plugin shows its new setting a moment later, so read "now" after a few ticks."""
        for _ in range(4):
            yield
        out["now"] = _param_text(p)
        if out["now"] == out["was"]:
            out["note"] = "The plugin still shows the old setting; it may update a moment later. Check with live_get_device."
        return out

    # ---- routing: where a track's audio comes from and goes, and a device's sidechain input ----

    def _routing_endpoints(self, track, device):
        """[(name, object, attrs)] for a track (input, output) or a device (its sidechain and audio/MIDI inputs)."""
        t = self._track(track)
        if device is None or device == "":
            return "track %d" % int(track), t.name, [("input", t, TRACK_INPUT), ("output", t, TRACK_OUTPUT)]
        dname, _, d = self._device(track, device)
        if d is None:
            raise ValueError("the mixer has no routing of its own; leave device out to route the track itself")
        eps = []
        if hasattr(d, "available_input_routing_types"):  # Compressor's own sidechain
            eps.append(("sidechain", d, TRACK_INPUT))
        for kind, attr in (("audio input", "audio_inputs"), ("midi input", "midi_inputs")):
            for i, io in enumerate(getattr(d, attr, ()) or ()):
                eps.append(("%s %d" % (kind, i + 1), io, DEVICE_IO))
        if not eps and _is_plugin(d):
            raise ValueError("Live doesn't let scripts reach a plugin's sidechain (VST/AU), so %s's sidechain has to be "
                             "set by hand on the device in Live. Live's own Compressor, Glue Compressor, Gate and Auto "
                             "Filter sidechains do work through the bridge" % dname)
        if not eps:
            raise ValueError("%s has no input that can be routed (no sidechain)" % dname)
        return "track %d" % int(track), dname, eps

    def _a_get_routing(self, track, device=None):
        where, name, eps = self._routing_endpoints(track, device)
        out = {"track": int(track), ("device" if device not in (None, "") else "track_name"): name}
        out["routes"] = {n: _route_info(o, a) for n, o, a in eps}
        return out

    def _a_set_routing(self, track, device=None, io=None, source=None, channel=None):
        if source in (None, "") and channel in (None, ""):
            raise ValueError("give source (where the audio comes from or goes) and/or channel")
        where, name, eps = self._routing_endpoints(track, device)
        names = [n for n, _, _ in eps]
        if io in (None, ""):
            if device in (None, ""):
                raise ValueError("say io: \"input\" or \"output\" for a track")
            # A device: its sidechain, or its only routable audio input.
            pick = [e for e in eps if e[0] == "sidechain"] or [e for e in eps if e[0].startswith("audio input")]
            if len(pick) != 1:
                raise ValueError("%s has more than one input (%s); say which with io" % (name, ", ".join(names)))
            ep = pick[0]
        else:
            want = str(io).strip().lower()
            pick = [e for e in eps if e[0] == want] or [e for e in eps if e[0].startswith(want)]
            if want == "sidechain" and not pick:
                pick = [e for e in eps if e[0].startswith("audio input")][:1] if len([e for e in eps if e[0].startswith("audio input")]) == 1 else []
            if len(pick) != 1:
                raise ValueError("io must be one of: %s" % ", ".join(names))
            ep = pick[0]
        ename, obj, attrs = ep
        types_a, type_a, chans_a, chan_a = attrs
        before = _route_info(obj, attrs)
        steps = 0
        if source not in (None, ""):
            setattr(obj, type_a, _choose_route(list(getattr(obj, types_a)), source, "source"))
            steps += 1
            yield  # Live refreshes the channel list for the new source
        if channel not in (None, ""):
            setattr(obj, chan_a, _choose_route(list(getattr(obj, chans_a)), channel, "channel"))
            steps += 1
        after = _route_info(obj, attrs)
        self._log("routed %s's %s to %s %s" % (name, ename, after["from"], after["channel"]),
                  [_Route(obj, attrs, "%s's %s" % (name, ename), (before["from"], before["channel"]),
                          (after["from"], after["channel"]))])
        return {"track": int(track), "on": name, "io": ename,
                "was": {"from": before["from"], "channel": before["channel"]},
                "now": {"from": after["from"], "channel": after["channel"]},
                "channel_choices": after["channel_choices"], "undo_steps": steps}

    # ---- sample chopping: an audio file in Simpler, its slicing, warp and transpose ----

    def _simpler_on(self, track, device=None):
        t = self._track(track)
        if device not in (None, ""):
            name, _, d = self._device(track, device)
            if d is None or not _is_simpler(d):
                raise ValueError("%s isn't a Simpler" % name)
            return t, d
        sims = [d for d in t.devices if _is_simpler(d)]
        if not sims:
            raise ValueError("track %d has no Simpler" % int(track))
        if len(sims) > 1:
            raise ValueError("track %d has more than one Simpler; say which with device" % int(track))
        return t, sims[0]

    def _apply(self, plan, what):
        """Applies a checked plan and logs it as one change. Returns the list of what changed."""
        if not plan:
            return []
        groups = {}
        for obj, attr, new, label in plan:
            key = id(obj)
            groups.setdefault(key, [obj, {}, []])
            groups[key][1][attr] = (getattr(obj, attr), new)
            groups[key][2].append(label)
        for obj, attr, new, label in plan:
            setattr(obj, attr, new)
        parts = []
        for obj, changes, labels in groups.values():
            now = dict((a, (old, getattr(obj, a))) for a, (old, new) in changes.items())
            parts.append(_Attrs(obj, "%s's %s" % (what, ", ".join(labels)), now, close=1e-6))
        self._log("set %s on %s" % (", ".join(l for _, _, _, l in plan), what), parts)
        return [l for _, _, _, l in plan]

    def _a_get_simpler(self, track, device=None):
        t, d = self._simpler_on(track, device)
        out = {"track": int(track), "device": _dev_name(d)}
        out.update(_simpler_info(d))
        return out

    def _a_set_simpler(self, track, device=None, **settings):
        t, d = self._simpler_on(track, device)
        bad = [k for k in settings if k not in ("mode", "slice_by", "sensitivity", "beat_division", "regions", "warp",
                                                "warp_mode", "transpose", "slice_playback")]
        if bad:
            raise ValueError("unknown setting: %s" % ", ".join(bad))
        plan = _simpler_plan(d, **settings)
        if not plan:
            raise ValueError("give at least one setting to change")
        before = _simpler_info(d)
        changed = self._apply(plan, "%s on track %d" % (_dev_name(d), int(track)))
        yield  # Live works out new slices on the next tick
        out = {"track": int(track), "device": _dev_name(d), "changed": changed, "was": before}
        out["now"] = _simpler_info(d)
        return out

    def _a_load_sample(self, track, file=None, from_clip=None, **settings):
        """Generator: a new Simpler on an empty MIDI track, holding an audio file (or an audio clip's file)."""
        t = self._track(track)
        if not t.has_midi_input:
            raise ValueError("track %d is an audio track; Simpler needs a MIDI track" % int(track))
        inst = _instrument_of(t)
        if inst is not None:
            raise ValueError("track %d already has an instrument (%s). Pick a MIDI track with no instrument, or make "
                             "a new one" % (int(track), _dev_name(inst)))
        if (file in (None, "")) == (from_clip is None):
            raise ValueError("give either file (an audio file's full path) or from_clip ({track, slot} of an audio clip)")
        clip_info = None
        if from_clip is not None:
            if not isinstance(from_clip, dict) or "track" not in from_clip or "slot" not in from_clip:
                raise ValueError("from_clip needs track and slot")
            c = self._clip(from_clip["track"], from_clip["slot"])
            if c.is_midi_clip:
                raise ValueError("that clip is MIDI; from_clip needs an audio clip")
            path = str(c.file_path)
            clip_info = {"track": int(from_clip["track"]), "slot": int(from_clip["slot"]), "name": c.name,
                         "transpose": int(getattr(c, "pitch_coarse", 0)), "warp": bool(getattr(c, "warping", False))}
            if settings.get("transpose") is None and clip_info["transpose"]:
                settings["transpose"] = clip_info["transpose"]  # keep how the clip sounds
        else:
            path = str(file)
        if not path.lower().endswith(AUDIO_FILES):
            raise ValueError("%r isn't an audio file Live can load (%s)" % (_file_name(path), ", ".join(AUDIO_FILES)))
        if not os.path.isfile(path):
            raise ValueError("there's no file at %s" % path)
        if not hasattr(t, "insert_device"):
            raise ValueError("this Live version can't add Simpler from a script (needs Live 12.3 or later)")
        yield from self._prepare_load(t)
        before = list(t.devices)
        t.insert_device("Simpler", len(before))
        yield
        new = yield from self._wait_for_devices(t, before)
        sims = [d for d in new if _is_simpler(d)]
        if not sims:
            raise ValueError("Live didn't add a Simpler to track %d" % int(track))
        d = sims[0]
        d.replace_sample(path)
        for _ in range(LOAD_TICKS):
            smp = getattr(d, "sample", None)
            if smp is not None and str(smp.file_path):
                break
            yield
        if getattr(d, "sample", None) is None:
            self.song().undo()
            raise ValueError("Live didn't load %s into Simpler, so the Simpler was taken out again" % _file_name(path))
        plan = _simpler_plan(d, **settings)
        for obj, attr, new_v, label in plan:
            setattr(obj, attr, new_v)
        yield
        self._log("loaded %s into a Simpler on track %d" % (_file_name(path), int(track)),
                  [_DevicesAdded(t, [d], "the Simpler with %s on track %d" % (_file_name(path), int(track)))])
        out = {"track": int(track), "device": _dev_name(d), "position": len(before)}
        out.update(_simpler_info(d))
        if clip_info:
            out["from_clip"] = clip_info
        if out.get("mode") == "slice":
            out["pads"] = "In Slice mode, slice 1 plays on C1 (MIDI 36), pad 1 on most pad controllers, and each next slice one note up."
        out["undo_steps"] = 2 + len(plan)
        return out

    def _a_set_audio_clip(self, track, slot, transpose=None, warp=None, warp_mode=None):
        c = self._clip(track, slot)
        if c.is_midi_clip:
            raise ValueError("that clip is MIDI; this is for audio clips")
        plan = []
        if transpose is not None:
            st = int(round(float(transpose)))
            if not (-48 <= st <= 48):
                raise ValueError("transpose is -48 to 48 semitones")
            plan.append((c, "pitch_coarse", st, "transpose"))
        if warp is not None:
            plan.append((c, "warping", bool(warp), "warp"))
        if warp_mode is not None:
            plan.append((c, "warp_mode", _warp_mode(warp_mode), "warp mode"))
        if not plan:
            raise ValueError("give transpose, warp and/or warp_mode")
        was = {"transpose": int(c.pitch_coarse), "warp": bool(c.warping), "warp_mode": _warp_name(c.warp_mode)}
        changed = self._apply(plan, "the clip %r in track %d, slot %d" % (c.name, int(track), int(slot)))
        return {"track": int(track), "slot": int(slot), "clip": c.name, "changed": changed, "was": was,
                "now": {"transpose": int(c.pitch_coarse), "warp": bool(c.warping), "warp_mode": _warp_name(c.warp_mode)},
                "file": str(getattr(c, "file_path", ""))}

    # ---- lining audio takes up (0.9.6): warp markers at note starts ----
    def _audio_clip(self, ref):
        """An audio clip by {track, slot} (Session) or {track, bar, name} (Arrangement). Returns (clip, label, origin),
        where origin is the song beat of the clip's start (0 for a Session clip)."""
        if not isinstance(ref, dict) or "track" not in ref:
            raise ValueError("name the clip as {track, slot} or {track, bar, name}")
        i = int(ref["track"])
        if ref.get("slot") is not None:
            c = self._clip(i, ref["slot"])
            label, origin = "the clip %r in track %d, slot %d" % (c.name, i, int(ref["slot"])), 0.0
        else:
            if ref.get("bar") is None or ref.get("name") is None:
                raise ValueError("an Arrangement clip needs bar (where it starts) and name")
            c = self._arr_clip_at(self._track(i), i, ref["bar"], ref["name"])
            label, origin = "the clip %r at bar %g on track %d" % (c.name, float(ref["bar"]), i), float(c.start_time)
        if c.is_midi_clip:
            raise ValueError("%s is MIDI; this is for audio clips" % label)
        return c, label, origin

    def _a_audio_clip_info(self, clip):
        c, label, origin = self._audio_clip(clip)
        marks = [(float(m.sample_time), float(m.beat_time)) for m in (getattr(c, "warp_markers", ()) or ())]
        out = {"clip": c.name, "file": str(getattr(c, "file_path", "")), "warp": bool(c.warping),
               "warp_markers": len(marks), "start_bar": self._bar_of(origin) if clip.get("slot") is None else None,
               # what Live reports, so a wrong reading can be traced (0.9.8)
               "raw": {"first_markers": marks[:3], "last_markers": marks[-2:],
                       "start_marker": _safe(lambda: float(c.start_marker), None), "end_marker": _safe(lambda: float(c.end_marker), None),
                       "loop_start": _safe(lambda: float(c.loop_start), None), "looping": _safe(lambda: bool(c.looping), None),
                       "start_time": _safe(lambda: float(c.start_time), None), "end_time": _safe(lambda: float(c.end_time), None),
                       "sample_to_beat_time(1.0)": _safe(lambda: float(c.sample_to_beat_time(1.0)), None)}}
        return out

    def _warp_map(self, c, file_seconds=None):
        """Reads the clip's warp markers and returns (to_beat, scale): to_beat(seconds) gives the clip beat for a
        time in the file, by straight lines between the markers (and on past the ends); scale turns seconds into
        the unit the markers use. Live's docs don't say whether a marker's sample_time is seconds or samples, and
        real Live disagreed with the first guess (2026-11-12), so the unit is worked out from the file's length."""
        marks = sorted((float(m.sample_time), float(m.beat_time)) for m in c.warp_markers)
        if len(marks) < 2:
            raise ValueError("the clip has fewer than two warp markers, so its timing can't be read")
        scale = 1.0
        if file_seconds and marks[-1][0] > float(file_seconds) * 4.0:
            rate = _safe(lambda: float(c.sample_rate), None) or round(marks[-1][0] / float(file_seconds) / 50.0) * 50.0
            scale = float(rate)  # the markers count samples

        def to_beat(seconds):
            x = float(seconds) * scale
            k = 0
            while k < len(marks) - 2 and x > marks[k + 1][0]:
                k += 1
            (x0, b0), (x1, b1) = marks[k], marks[k + 1]
            return b0 + (x - x0) * (b1 - b0) / (x1 - x0) if x1 > x0 else b0
        return to_beat, scale

    def _song_beats(self, c, origin, seconds, file_seconds=None):
        """Song beat of each time (seconds into the file), for the part of the file the clip plays."""
        to_beat, scale = self._warp_map(c, file_seconds)
        sm = float(getattr(c, "start_marker", 0.0))
        length = float(c.end_time) - float(c.start_time) if hasattr(c, "end_time") else float(c.length)
        out = []
        for t in seconds:
            inner = to_beat(t)
            if -1e-6 <= inner - sm <= length + 1e-6:
                out.append((float(t) * scale, inner, origin + inner - sm))
        return out

    def _a_align_audio(self, clip, onsets, to=None, to_onsets=None, grid=None, max_ms=60, preview=False,
                       file_seconds=None, to_file_seconds=None):
        """Generator: lines an audio clip's note starts up with another clip's (to + to_onsets) or with a grid, by
        adding a warp marker at each start: starts within max_ms of a target move onto it, the others are pinned
        where they are so nothing else drifts. onsets are seconds into each clip's file, found by the MCP server."""
        s = self.song()
        c, label, origin = self._audio_clip(clip)
        if not isinstance(onsets, list) or not onsets:
            raise ValueError("no note starts were found in %s, so there's nothing to line up" % label)
        if len(onsets) > 4000:
            raise ValueError("too many note starts (%d); line up a shorter clip" % len(onsets))
        if (to is None) == (grid is None):
            raise ValueError("give to (the clip to match) or grid, one of them")
        limit_ms = float(max_ms)
        if not (5 <= limit_ms <= 250):
            raise ValueError("max_ms is 5 to 250")
        spec = getattr(Live.Clip, "WarpMarker", None)
        if spec is None or not hasattr(c, "add_warp_marker"):
            raise ValueError("this Live version can't add warp markers from a script")
        was_warping = bool(c.warping)
        if not was_warping:
            if preview:
                raise ValueError("%s has Warp off. Lining up needs Warp on; run it without preview and the bridge "
                                 "switches it on (revertible)" % label)
            c.warping = True
            yield
        mine = self._song_beats(c, origin, sorted(float(t) for t in onsets), file_seconds)
        if not mine:
            raise ValueError("none of the note starts fall inside the part of the file %s plays" % label)
        if len(mine) >= 4 and mine[-1][2] - mine[0][2] < 0.5:
            raise ValueError("the note starts of %s all read as the same moment, so its timing is being misread; "
                             "nothing was changed. Send the lead chat live audio_clip_info for this clip" % label)
        beats_per_ms = float(s.tempo) / 60000.0
        limit = limit_ms * beats_per_ms
        if to is not None:
            rc, rlabel, rorigin = self._audio_clip(to)
            if rc == c:
                raise ValueError("that's the same clip")
            if not rc.warping:
                raise ValueError("%s has Warp off, so its timing can't be read; switch its Warp on first" % rlabel)
            targets = sorted(x[2] for x in self._song_beats(rc, rorigin, [float(t) for t in (to_onsets or [])], to_file_seconds))
            if not targets:
                raise ValueError("no note starts were found in %s to line up with" % rlabel)
            against = rlabel
        else:
            g = self._rate_beats(grid)
            targets, against = None, "the %s grid" % grid
        plan, used, prev = [], set(), None
        for t, inner, song in mine:
            if targets is None:
                want = round(song / g) * g
            else:
                near = min(targets, key=lambda x: abs(x - song))
                want = near if near not in used else None
            move = want is not None and abs(want - song) <= limit and abs(want - song) > 1e-4
            if move and prev is not None and want <= prev + 1e-3:
                move = False  # it would cross the start before it
            final = want if move else song
            if move and targets is not None:
                used.add(want)
            prev = final
            plan.append({"t": t, "inner": inner + (final - song), "song": song, "final": final, "moved": move})
        moved = [p for p in plan if p["moved"]]
        moves = [{"bar": self._bar_of(p["song"]), "shift_ms": round((p["final"] - p["song"]) / beats_per_ms, 1)} for p in moved]
        out = {"clip": c.name, "lined_up_with": against, "starts_found": len(plan), "moved": len(moved), "left_in_place": len(plan) - len(moved),
               "biggest_shift_ms": max([abs(m["shift_ms"]) for m in moves] or [0]), "moves": moves[:200], "preview": bool(preview),
               "first_starts_at_bars": [self._bar_of(p["song"]) for p in plan[:6]]}
        if targets is not None:
            out["lead_starts_at_bars"] = [self._bar_of(x) for x in targets[:6]]
        if preview or not moved:
            if not was_warping and not preview:
                c.warping = False
            if not moved:
                out["note"] = "Nothing was within %g ms of a target, so nothing was changed. Try a larger max_ms." % limit_ms
            return out
        have = [float(m.sample_time) for m in c.warp_markers]
        added, failed = [], 0
        for p in plan:
            if any(abs(p["t"] - x) < 0.002 for x in have):
                continue  # a marker already sits on this start
            try:
                c.add_warp_marker(spec(float(p["t"]), float(p["inner"])))
                added.append(float(p["inner"]))
            except Exception:
                failed += 1
        if not added:
            raise ValueError("Live refused every warp marker on %s; nothing was changed" % label)
        self._log("lined %s up with %s (%d of %d starts moved)" % (label, against, len(moved), len(plan)),
                  [_WarpAdded(c, added, was_warping, label)])
        out["markers_added"] = len(added)
        if failed:
            out["warning"] = "Live refused %d of the markers, so some starts may not sit right; listen to it" % failed
        out["note"] = ("Each note start got a warp marker: the moved ones sit on their target, the rest are pinned where they "
                       "were. Listen for stretched or squashed words. live_revert takes it all back.")
        return out

    def _a_delete_track(self, track, name):
        """Deletes one track, only when the user asks: the name must match, and it must hold no clips."""
        s = self.song()
        t = self._track(track, regular=True)
        if str(name).strip().lower() != str(t.name).strip().lower():
            raise ValueError("track %d is called %r, not %r, so nothing was deleted" % (int(track), t.name, name))
        clips = [j for j, cs in enumerate(t.clip_slots) if cs.has_clip]
        if clips:
            raise ValueError("track %d (%s) has clips in slots %s, so the bridge won't delete it; the user can delete it by hand"
                             % (int(track), t.name, ", ".join(str(j) for j in clips)))
        if len(s.tracks) <= 1:
            raise ValueError("that's the only track")
        devices = [_dev_name(d) for d in t.devices]
        s.delete_track(int(track))
        self._log("deleted track %d (%s)" % (int(track), name),
                  [_Fixed("deleting a track", "use live_undo straight away to bring it back")])
        return {"deleted": int(track), "name": str(name), "had_devices": devices, "undo_steps": 1,
                "note": "live_undo brings it back with its devices. Track numbers after it moved down by one."}

    # ---- Live's browser: find and load devices and samples ----
    #
    # Browser loads land on the selected track (Live's double-click behaviour), so every load first selects the
    # track the call named, clears any hotswap target, and checks afterwards that nothing already on the track was
    # replaced. If something was, it undoes the load and says so. Loads can finish on a later tick, so these
    # actions are jobs (generators) that update_display steps once per tick.

    def _browser(self):
        return Live.Application.get_application().browser

    def _tree_root(self, tree):
        attr = BROWSER_TREES.get(tree)
        if attr is None:
            raise ValueError("unknown tree %r; use one of: %s" % (tree, ", ".join(sorted(BROWSER_TREES))))
        b = self._browser()
        if tree == "places":
            return _Places(b)
        if not hasattr(b, attr):
            raise ValueError("this Live version's browser has no %s" % tree)
        return getattr(b, attr)

    def _walk(self, root, max_depth=8):
        """Breadth-first over a browser tree. Yields (item, path), and None every WALK_CHUNK items so the caller
        can hand the tick back to Live. Stops after MAX_VISIT items."""
        level = [(root, [])]
        seen = 0
        for _ in range(max_depth):
            nxt = []
            for item, path in level:
                for child in _children(item):
                    seen += 1
                    if seen % WALK_CHUNK == 0:
                        yield None
                    if seen > MAX_VISIT:
                        return
                    name = _item_name(child)
                    if _hidden(name):
                        continue
                    cpath = path + [name]
                    yield (child, cpath)
                    if _is_folder(child):
                        nxt.append((child, cpath))
            if not nxt:
                return
            level = nxt

    def _resolve(self, root, path):
        """Follows a path of names ("Reverb/Hall") down from root. Names match without case or file extension,
        but an exact name wins, so "Noisy Pad.adv" never loads its neighbour "Noisy Pad.adg"."""
        item, walked = root, []
        for part in _split_path(path):
            kids = _children(item)
            hit = None
            for child in kids:
                if _item_name(child).strip().lower() == part.lower():
                    hit = child
                    break
            if hit is None:
                for child in kids:
                    if _same_name(_item_name(child), part):
                        hit = child
                        break
            if hit is None:
                raise ValueError("couldn't find %r in %s" % (part, "/".join(walked) or "the top"))
            item = hit
            walked.append(_item_name(hit))
        return item, walked

    def _a_browse(self, tree, query=None, path=None, limit=40):
        lim = max(1, min(200, int(limit)))
        root = self._tree_root(tree)
        base = []
        if path:
            root, base = self._resolve(root, path)
        out, more = [], False
        if not query:
            for child in _children(root):
                name = _item_name(child)
                if _hidden(name):
                    continue
                if len(out) >= lim:
                    more = True
                    break
                out.append(_item_info(child, base + [name]))
            return {"tree": tree, "path": "/".join(base), "items": out, "more": more}
        words = [w for w in str(query).lower().split() if w]
        searched = 0
        for step in self._walk(root):
            if step is None:
                yield
                continue
            searched += 1
            item, ipath = step
            low = ipath[-1].lower()
            if all(w in low for w in words):
                if len(out) >= lim:
                    more = True
                    break
                out.append(_item_info(item, base + ipath))
        return {"tree": tree, "path": "/".join(base), "query": query, "items": out, "more": more,
                "searched": searched, "complete": searched < MAX_VISIT}

    def _a_list_tree(self, tree, path=None, limit=3000):
        """Every loadable item under one tree (or one folder of it), as paths. Read-only. The MCP server ranks these
        against a description, so the bridge only lists names and never interprets them."""
        lim = max(1, min(MAX_LIST, int(limit)))
        root = self._tree_root(tree)
        base = []
        if path:
            root, base = self._resolve(root, path)
        out, more, searched = [], False, 0
        for step in self._walk(root):
            if step is None:
                yield
                continue
            searched += 1
            item, ipath = step
            if not _loadable(item):
                continue
            if len(out) >= lim:
                more = True
                break
            out.append("/".join(base + ipath))
        return {"tree": tree, "path": "/".join(base), "items": out, "more": more,
                "searched": searched, "complete": searched < MAX_VISIT}

    def _find_device_item(self, tree, name, path):
        """Generator: returns (item, tree it came from, path as a list)."""
        trees = [tree] if tree else list(DEVICE_SEARCH)
        if path:
            for t in trees:
                try:
                    item, walked = self._resolve(self._tree_root(t), path)
                    return item, t, walked
                except ValueError:
                    continue
            raise ValueError("couldn't find %r in %s" % (path, ", ".join(trees)))
        for t in trees:
            try:
                root = self._tree_root(t)
            except ValueError:
                continue
            for step in self._walk(root, max_depth=4):
                if step is None:
                    yield
                    continue
                item, ipath = step
                if _same_name(ipath[-1], name) and _loadable(item):
                    return item, t, ipath
        raise ValueError("couldn't find a device called %r. Try live_browse with a query to see the exact name" % name)

    def _select_for_load(self, t):
        """Generator: selects the track and waits until Live shows it selected. In real Live the selection can take
        a tick, and a browser load in between goes to the track that was selected before (seen 2026-11-12)."""
        s = self.song()
        s.view.selected_track = t
        for _ in range(6):
            if s.view.selected_track == t:
                return
            yield
        raise ValueError("Live wouldn't select track %r, so nothing was loaded. Is someone clicking in Live right now?" % t.name)

    def _snapshot_devices(self):
        return [(x, list(x.devices)) for x in self.song().tracks]

    def _strays(self, snap, t):
        """Devices that appeared on other tracks than t since snap: [(track, index, devices)]."""
        out = []
        for i, (x, before) in enumerate(snap):
            if x == t:
                continue
            new, gone = _gone(lambda: [d for d in x.devices if not any(d == b for b in before)])
            if not gone and new:
                out.append((x, i, new))
        return out

    def _remove_strays(self, strays):
        names = []
        for x, i, new in strays:
            devs = list(x.devices)
            for j in sorted([j for j, d in enumerate(devs) if any(d == n for n in new)], reverse=True):
                x.delete_device(j)
            names.append("%s on track %d" % (", ".join(_dev_name(d) for d in new), i))
        return "; ".join(names)

    def _prepare_load(self, t):
        """Generator: selects the track (and waits for it) and clears any hotswap target, so Live loads onto that
        track and replaces nothing."""
        yield from self._select_for_load(t)
        b = self._browser()
        try:
            if b.hotswap_target is not None:
                b.hotswap_target = None
        except Exception:
            pass
        # "default" insert mode adds to the end of the chain, as a double-click in Live's browser does.
        try:
            t.view.device_insert_mode = Live.Track.DeviceInsertMode.default
        except Exception:
            pass

    def _wait_for_devices(self, track, before):
        """Generator: waits a few ticks for a load to show up in track.devices. Returns the new devices.
        If a device that was there before is gone, Live replaced it: undo and refuse."""
        for _ in range(LOAD_TICKS):
            now = list(track.devices)
            if len(now) != len(before) or any(a != b for a, b in zip(now, before)):
                break
            yield
        now = list(track.devices)
        gone = [d for d in before if not any(d == n for n in now)]
        if gone:
            self.song().undo()
            raise ValueError("Live replaced %s instead of adding to the chain, so the load was undone" %
                             ", ".join(_dev_name(d) for d in gone))
        return [d for d in now if not any(d == b for b in before)]

    def _a_load_device(self, track, name=None, path=None, tree=None, only_if_no_instrument=False, replace_instrument=None):
        if not name and not path:
            raise ValueError("give a device name or a browser path")
        if tree is not None and tree not in BROWSER_TREES:
            raise ValueError("unknown tree %r" % tree)
        t = self._track(track)
        if replace_instrument:
            result = yield from self._replace_instrument(t, int(track), str(replace_instrument), name, path, tree)
            return result
        if only_if_no_instrument:
            # For sounds and presets: the track must be a MIDI track with no instrument, whatever the item turns out to be.
            if not t.has_midi_input:
                raise ValueError("track %d is an audio track; a sound needs a MIDI track" % int(track))
            inst = _instrument_of(t)
            if inst is not None:
                raise ValueError("track %d already has an instrument (%s). Pick a MIDI track with no instrument, or "
                                 "make a new one" % (int(track), _dev_name(inst)))
        item, found_in, ipath = yield from self._find_device_item(tree, name, path)
        if not _loadable(item):
            raise ValueError("%r is a folder, not something Live can load. Use live_browse to look inside it" % "/".join(ipath))
        kind = TREE_KIND.get(found_in)
        if kind in ("instrument", "midi_effect") and not t.has_midi_input:
            raise ValueError("track %d is an audio track; instruments and MIDI effects need a MIDI track" % int(track))
        inst = _instrument_of(t)
        if inst is not None and kind == "instrument":
            raise ValueError("track %d already has an instrument (%s), and Live would replace it. Pick an empty MIDI track"
                             % (int(track), _dev_name(inst)))
        # Items from plugins, Places or the User Library could be anything; _wait_for_devices undoes a replacement.
        yield from self._prepare_load(t)
        before = list(t.devices)
        snap = self._snapshot_devices()
        self._browser().load_item(item)
        yield
        new = yield from self._wait_for_devices(t, before)
        strays = self._strays(snap, t)
        if strays:
            took = self._remove_strays(strays)
            raise ValueError("Live loaded it on another track instead of track %d (%s); the bridge took that back off. "
                             "Nothing else changed. Try again, and ask the user not to click in Live meanwhile" % (int(track), took))
        if not new:
            raise ValueError("Live didn't add anything to track %d. Is %r a device?" % (int(track), "/".join(ipath)))
        devs = list(t.devices)
        inst = _instrument_of(t)
        self._log("loaded %s on track %d" % (ipath[-1], int(track)),
                  [_DevicesAdded(t, new, "%s on track %d" % (", ".join(_dev_name(d) for d in new), int(track)))])
        return {"track": int(track), "loaded": "/".join(ipath), "from": found_in,
                "added": [_dev_name(d) for d in new],
                "position": [i for i, d in enumerate(devs) if any(d == n for n in new)],
                "devices": [_dev_name(d) for d in devs],
                "instrument": _dev_name(inst) if inst is not None else None, "undo_steps": 1}

    def _replace_instrument(self, t, track, expected, name, path, tree):
        """Generator: hot-swaps the track's instrument for another sound, but only if the instrument is the one
        named (the MCP server's audition loaded it). Nothing else on the track may change."""
        inst = _instrument_of(t)
        if inst is None:
            raise ValueError("track %d has no instrument to replace" % track)
        if _dev_name(inst).strip().lower() != expected.strip().lower():
            raise ValueError("track %d's instrument is %s, not %s, so it wasn't replaced" % (track, _dev_name(inst), expected))
        item, found_in, ipath = yield from self._find_device_item(tree, name, path)
        if not _loadable(item):
            raise ValueError("%r is a folder, not something Live can load" % "/".join(ipath))
        if TREE_KIND.get(found_in) not in (None, "instrument"):
            raise ValueError("%r isn't an instrument or sound" % "/".join(ipath))
        yield from self._select_for_load(t)
        before = list(t.devices)
        at = [i for i, d in enumerate(before) if d == inst][0]
        b = self._browser()
        b.hotswap_target = inst
        try:
            b.load_item(item)
            yield
            for _ in range(LOAD_TICKS):
                now = list(t.devices)
                if not any(d == inst for d in now):
                    break
                yield
        finally:
            try:
                b.hotswap_target = None
            except Exception:
                pass
        now = list(t.devices)
        others = [d for d in before if d != inst]
        if any(d == inst for d in now):
            if len(now) != len(before):
                s.undo()
                raise ValueError("Live added %r instead of replacing %s, so the load was undone" % ("/".join(ipath), expected))
            raise ValueError("Live didn't replace %s with %r" % (expected, "/".join(ipath)))
        if not all(any(d == n for n in now) for d in others) or len(now) != len(before):
            s.undo()
            raise ValueError("loading %r changed more than the instrument, so it was undone" % "/".join(ipath))
        new_inst = _instrument_of(t)
        self._log("swapped %s for %s on track %d" % (expected, ipath[-1], track),
                  [_Fixed("the audition swap on track %d" % track, "use live_audition (back, go or keep) to change the sound")])
        return {"track": track, "loaded": "/".join(ipath), "from": found_in, "replaced": expected,
                "instrument": _dev_name(new_inst) if new_inst is not None else None,
                "position": at, "devices": [_dev_name(d) for d in now], "undo_steps": 1}

    def _find_folder(self, folder):
        """Finds a sample folder in Places (then the User Library) by the longest tail of its path that matches.
        "rondo/Samples/Kit" matches a Places folder "Samples" holding "Kit", or a Places folder "Kit" itself."""
        parts = _split_path(folder)
        if not parts:
            raise ValueError("give the sample folder's name")
        for tree in ("places", "user_library"):
            root = self._tree_root(tree)
            for start in range(len(parts)):
                try:
                    item, walked = self._resolve(root, parts[start:])
                    return item, tree, walked
                except ValueError:
                    continue
            # not at the top: look a few levels down for a folder with the last name
            for step in self._walk(root, max_depth=4):
                if step is None:
                    yield
                    continue
                item, ipath = step
                if _same_name(ipath[-1], parts[-1]) and _children(item):
                    return item, tree, ipath
        raise ValueError(
            "couldn't find the folder %r in Live's browser. Live only loads samples it can see there. To add it: in "
            "Live's browser, under Places, click \"Add Folder...\", pick the folder that holds the kit (or a folder above "
            "it, like Samples), then try again." % parts[-1])

    def _load_on_pad(self, rack, pad, item):
        """Generator: loads one sample onto one Drum Rack pad, by making the pad Live's hotswap target."""
        b = self._browser()
        try:
            rack.view.selected_drum_pad = pad
        except Exception:
            pass
        try:
            b.hotswap_target = pad
        except Exception as e:
            raise ValueError("Live wouldn't aim the browser at pad %s (%s)" % (_note_name(pad.note), e))
        b.load_item(item)
        for _ in range(LOAD_TICKS):
            if list(pad.chains):
                break
            yield
        try:
            b.hotswap_target = None
        except Exception:
            pass
        if not list(pad.chains):
            raise ValueError("Live didn't put %s on pad %s" % (_item_name(item), _note_name(pad.note)))

    # ---- swapping one pad's sample ----
    # The one place the bridge replaces a sound, and only when the user asks: one pad on the named track. It keeps the
    # pad's Simpler, volume and choke group, reports the old sample (the MCP server saves it, so it can be put back),
    # and undoes itself if anything else on the Drum Rack changed.

    def _pick_pad(self, rack, pad):
        """pad: 1-16 (the pads from C1 up), a MIDI note 17-127, a note name ("D1"), or words from the pad's name ("snare")."""
        pads = dict((p.note, p) for p in rack.drum_pads)
        if isinstance(pad, bool):
            raise ValueError("pad must be a pad number, a note or a name")
        note = None
        if isinstance(pad, (int, float)) or str(pad).strip().isdigit():
            n = int(pad)
            note = FIRST_PAD + n - 1 if 1 <= n <= MAX_PADS else n
            if not (0 <= note <= 127):
                raise ValueError("pad %d doesn't exist; use 1-16 or a MIDI note up to 127" % n)
        else:
            note = _note_from_name(str(pad))
        if note is not None:
            if note not in pads:
                raise ValueError("this Drum Rack has no pad on %s" % _note_name(note))
            return pads[note]
        words = [w for w in str(pad).lower().split() if w]
        if not words:
            raise ValueError("say which pad: a number 1-16, a note like D1, or part of its name")
        full = [p for p in rack.drum_pads if list(p.chains)]
        label = lambda p: (_item_name(p) + " " + " ".join(_item_name(c) for c in p.chains)).lower()
        hits = [p for p in full if all(w in label(p) for w in words)]
        if len(hits) == 1:
            return hits[0]
        if not hits:
            raise ValueError("no pad's name has %r. Pads with sounds: %s" % (
                str(pad), ", ".join("%s %s" % (_note_name(p.note), _item_name(p)) for p in full[:16]) or "none"))
        raise ValueError("more than one pad matches %r: %s. Say which by number or note" % (
            str(pad), ", ".join("%s %s" % (_note_name(p.note), _item_name(p)) for p in hits)))

    def _pad_simpler(self, pad):
        chains = list(pad.chains)
        if not chains:
            raise ValueError("pad %s is empty, so there's nothing to swap; load a sample onto it instead" % _note_name(pad.note))
        if len(chains) > 1:
            raise ValueError("pad %s is layered (%d sounds), so the bridge won't swap it" % (_note_name(pad.note), len(chains)))
        simplers = [d for d in chains[0].devices if hasattr(d, "sample")]
        if not simplers:
            raise ValueError("pad %s has no Simpler or Sampler holding a sample, so there's nothing to swap" % _note_name(pad.note))
        return chains[0], simplers[0]

    def _rack_snapshot(self, rack, skip_note):
        snap = {}
        for p in rack.drum_pads:
            if p.note == skip_note:
                continue
            chains = list(p.chains)
            if chains:
                snap[p.note] = tuple((len(c.devices), tuple(_dev_name(d) for d in c.devices),
                                      tuple(_simpler_file(d) for d in c.devices if hasattr(d, "sample"))) for c in chains)
        return snap

    def _find_sample(self, sample, tree):
        """Generator: a sample by browser path. Tries the longest tail of the path in Places, the User Library, Samples
        and Drums (or only tree), then a file of that name a few folders down. Returns (item, tree, path)."""
        parts = _split_path(sample)
        if not parts:
            raise ValueError("give the new sample's path from live_browse")
        trees = [tree] if tree else ["places", "user_library", "samples", "drums"]
        for t in trees:
            root = self._tree_root(t)
            for start in range(len(parts)):
                try:
                    item, walked = self._resolve(root, parts[start:])
                except ValueError:
                    continue
                if _loadable(item) and not _is_folder(item):
                    return item, t, walked
        for t in trees:
            for step in self._walk(self._tree_root(t), max_depth=6):
                if step is None:
                    yield
                    continue
                item, ipath = step
                if _loadable(item) and not _is_folder(item) and ipath[-1].strip().lower() == parts[-1].lower():
                    return item, t, ipath
        raise ValueError("couldn't find the sample %r in %s. Use live_browse to find its path" % (parts[-1], ", ".join(trees)))

    def _a_swap_pad_sample(self, track, pad, sample, tree=None):
        if tree is not None and tree not in BROWSER_TREES:
            raise ValueError("unknown tree %r" % tree)
        t = self._track(track)
        racks = [d for d in t.devices if getattr(d, "can_have_drum_pads", False)]
        if not racks:
            raise ValueError("track %d has no Drum Rack" % int(track))
        rack = racks[0]
        p = self._pick_pad(rack, pad)
        chain, simpler = self._pad_simpler(p)
        old_file = _simpler_file(simpler)
        was = {"sample": _item_name(chain) or _file_name(old_file), "file": old_file}
        item, found_in, ipath = yield from self._find_sample(sample, tree)
        if getattr(item, "is_device", False):
            raise ValueError("%r is a device, not a sample" % "/".join(ipath))
        if old_file and _file_name(old_file).strip().lower() == ipath[-1].strip().lower():
            raise ValueError("pad %s already plays %s" % (_note_name(p.note), ipath[-1]))
        before = self._rack_snapshot(rack, p.note)
        keep_vol, keep_choke = chain.mixer_device.volume.value, getattr(chain, "choke_group", None)
        b = self._browser()
        yield from self._select_for_load(t)
        try:
            rack.view.selected_drum_pad = p
        except Exception:
            pass
        # Aim the browser at the pad's Simpler, so only its sample changes (Live's hot-swap of a Simpler's sample).
        b.hotswap_target = simpler
        b.load_item(item)
        for _ in range(LOAD_TICKS):
            if len(list(p.chains)) != 1 or _simpler_file(simpler) != old_file:
                break
            yield
        try:
            b.hotswap_target = None
        except Exception:
            pass
        chains = list(p.chains)
        if self._rack_snapshot(rack, p.note) != before:
            s.undo()
            raise ValueError("Live changed another pad too, so the swap was undone")
        if len(chains) != 1:
            s.undo()
            raise ValueError("Live changed the pad's layout, so the swap was undone")
        new_chain = chains[0]
        kept_simpler = any(d == simpler for d in new_chain.devices)
        if kept_simpler:
            now_file = _simpler_file(simpler)
        else:
            sims = [d for d in new_chain.devices if hasattr(d, "sample")]
            now_file = _simpler_file(sims[0]) if sims else ""
        if now_file == old_file:
            raise ValueError("Live didn't change the sample on pad %s" % _note_name(p.note))
        self._log("swapped the sample on pad %s (track %d)" % (_note_name(p.note), int(track)),
                  [_Fixed("the sample swap on pad %s" % _note_name(p.note),
                          "swap the old sample back with live_swap_pad_sample (it was saved), or use live_undo")])
        steps = 1
        # If Live rebuilt the pad, put its volume and choke group back.
        if new_chain.mixer_device.volume.value != keep_vol:
            new_chain.mixer_device.volume.value = keep_vol
            steps += 1
        if keep_choke is not None and getattr(new_chain, "choke_group", keep_choke) != keep_choke:
            new_chain.choke_group = keep_choke
            steps += 1
        out = {"track": int(track), "track_name": t.name,
               "pad": p.note - FIRST_PAD + 1 if FIRST_PAD <= p.note < FIRST_PAD + MAX_PADS else None,
               "note": p.note, "note_name": _note_name(p.note), "was": was,
               "now": {"sample": _item_name(new_chain) or ipath[-1], "file": now_file, "path": "/".join(ipath), "from": found_in},
               "kept": "Simpler settings, volume and choke group" if kept_simpler else "volume and choke group",
               "undo_steps": steps}
        if not kept_simpler:
            out["notes"] = ["Live rebuilt the pad, so its Simpler settings (start, length, envelope) went back to defaults; "
                            "volume and choke group were kept"]
        return out

    def _a_build_drum_kit(self, track, folder, volumes_db=None, choke_hats=True, name=None):
        t = self._track(track)
        if not t.has_midi_input:
            raise ValueError("track %d is an audio track; a drum kit needs a MIDI track" % int(track))
        inst = _instrument_of(t)
        if inst is not None:
            raise ValueError("track %d already has an instrument (%s). Pick an empty MIDI track, or make one with "
                             "live_create_midi_track" % (int(track), _dev_name(inst)))
        vols = list(volumes_db or [])
        for v in vols:
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not (-70 <= v <= 6):
                raise ValueError("volumes_db values must be numbers from -70 to 6")
        fitem, ftree, fpath = yield from self._find_folder(folder)
        samples = [c for c in _children(fitem) if _loadable(c) and not _is_folder(c) and not _hidden(_item_name(c))]
        samples.sort(key=lambda c: _natural_key(_item_name(c)))
        if not samples:
            raise ValueError("the folder %r has no samples Live can load" % "/".join(fpath))
        skipped = [_item_name(c) for c in samples[MAX_PADS:]]
        samples = samples[:MAX_PADS]
        yield from self._prepare_load(t)
        before = list(t.devices)
        if hasattr(t, "insert_device"):
            t.insert_device("Drum Rack", len(before))  # Live 12.3+: adds a native device by name, right away
        else:
            rack_item, _, _ = yield from self._find_device_item("instruments", "Drum Rack", None)
            self._browser().load_item(rack_item)
        yield
        new = yield from self._wait_for_devices(t, before)
        racks = [d for d in new if getattr(d, "can_have_drum_pads", False)]
        if not racks:
            raise ValueError("Live didn't add a Drum Rack to track %d" % int(track))
        rack = racks[0]
        steps = 1
        pads_by_note = dict((p.note, p) for p in rack.drum_pads)
        pads = []
        for i, sample in enumerate(samples):
            pad = pads_by_note[FIRST_PAD + i]
            yield from self._load_on_pad(rack, pad, sample)
            steps += 1
            pads.append({"pad": i + 1, "note": pad.note, "note_name": _note_name(pad.note), "sample": _item_name(sample)})
        try:
            rack.view.selected_drum_pad = pads_by_note[FIRST_PAD]
        except Exception:
            pass

        notes = []
        for i, p in enumerate(pads):
            chain = list(pads_by_note[p["note"]].chains)[0]
            if i < len(vols):
                got = _set_db(chain.mixer_device.volume, float(vols[i]))
                if got is None:
                    notes.append("couldn't set the volume on pad %d" % (i + 1))
                else:
                    p["volume"] = got
                    steps += 1
            if choke_hats and "hat" in p["sample"].lower():
                if hasattr(chain, "choke_group"):
                    chain.choke_group = 1
                    p["choke_group"] = 1
                    steps += 1
                else:
                    notes.append("this Live version doesn't let scripts set choke groups; set the hats' Choke to 1 in the Drum Rack's I-O section by hand")
        parts = [_DevicesAdded(t, [rack], "the drum kit on track %d" % int(track))]
        if name:
            old_name = t.name
            t.name = str(name)
            steps += 1
            parts.append(_Attrs(t, "track %d's name" % int(track), {"name": (old_name, t.name)}))
        self._log("built a drum kit from %s on track %d" % (fpath[-1], int(track)), parts)
        out = {"track": int(track), "track_name": t.name, "folder": "/".join(fpath), "found_in": ftree,
               "pads": pads, "undo_steps": steps,
               "controller": "On most pad controllers the first eight pads send MIDI 36-43, so pad 1 plays sample 1. Arm the track to play it."}
        if skipped:
            out["skipped"] = skipped
            notes.append("only the first %d samples fit on the kit; the rest were skipped" % MAX_PADS)
        if notes:
            out["notes"] = sorted(set(notes))
        return out
