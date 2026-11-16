"""Runs the real SecondChair Remote Script against a stand-in for Live's Python API, so the socket protocol,
token check, main-thread queue and actions can be tested without Ableton. Usage: python fake_live.py [seconds]"""
import math, os, socket, sys, threading, time, types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "remote_script"))

# ---- stand-ins for Live's modules ----
class Note:
    def __init__(self, pitch, start_time, duration, velocity, mute=False):
        self.pitch, self.start_time, self.duration, self.velocity, self.mute = pitch, start_time, duration, velocity, mute

import itertools
NOTE_IDS = itertools.count(1)

class Envelope:
    """Like Live's AutomationEnvelope: steps of (time, duration, value)."""
    def __init__(self): self.steps = []
    def insert_step(self, time, duration, value): self.steps.append((time, duration, value))
    def value_at_time(self, time):
        hit = [v for (t, d, v) in self.steps if t <= time < t + d]
        return hit[-1] if hit else None

class Enveloped:
    """Clip envelopes, keyed by the parameter."""
    def _envs(self):
        if not hasattr(self, "envelopes"): self.envelopes = {}
        return self.envelopes
    def automation_envelope(self, p): return self._envs().get(id(p))
    def create_automation_envelope(self, p):
        if isinstance(self, ArrClip):  # like real Live 12 (checked 2026-11-12)
            raise RuntimeError("Not a session clip or parameter belongs to another track.")
        e = Envelope(); self._envs()[id(p)] = e; return e
    def clear_envelope(self, p): self._envs().pop(id(p), None)

class Clip(Enveloped):
    def __init__(self, length):
        self.length, self.name, self.is_midi_clip, self.is_playing, self.notes = length, "", True, False, []
    def add_new_notes(self, specs):
        for n in specs:  # like Live, every note gets an id
            n.note_id = next(NOTE_IDS)
        self.notes.extend(specs)
    def remove_notes_by_id(self, ids):
        self.notes = [n for n in self.notes if n.note_id not in ids]
    def get_notes_extended(self, from_pitch, pitch_span, from_time, time_span):
        return list(self.notes)

# An audio file on disk for the chopping tests, and an audio clip that plays it (on the audio track, slot 7).
import tempfile
VOCAL = os.path.join(tempfile.gettempdir(), "fake-live-vocal_97_A#m.wav")
open(VOCAL, "wb").write(b"RIFF fake")

class AudioClip(Enveloped):
    def __init__(self, path, name):
        self.file_path, self.name, self.length, self.is_midi_clip, self.is_playing = path, name, 8.0, False, False
        self.pitch_coarse, self.warping, self.warp_mode = 0, True, 0

class ArrClip(Enveloped):
    """A clip on the Arrangement timeline: a copy of a Session clip placed at start_time (in beats)."""
    def __init__(self, src, start):
        self.name, self.is_midi_clip, self.length = src.name, src.is_midi_clip, src.length
        self.start_time, self.end_time, self.muted, self.start_marker = float(start), float(start) + src.length, False, 0.0

class Slot:
    def __init__(self): self.clip = None
    @property
    def has_clip(self): return self.clip is not None
    def create_clip(self, length): self.clip = Clip(length)
    def duplicate_clip_to(self, other):
        import copy
        other.clip = copy.copy(self.clip)
    def delete_clip(self): self.clip = None
    def fire(self):
        if self.clip: self.clip.is_playing = True

class Track:
    def __init__(self, name, midi=True):
        self.name, self.has_midi_input, self.can_be_armed = name, midi, True
        self.arm = self.mute = self.solo = False
        self.current_monitoring_state = 1  # auto
        self.devices = [Device("Electric", INSTRUMENT)] if midi and name == "Keys" else []
        self.clip_slots = [Slot() for _ in range(8)]
        self.playing_slot_index = -1
        self.arrangement_clips = []
        self.view = types.SimpleNamespace(device_insert_mode=0)
        pct = lambda v: "C" if abs(v) < 0.005 else "%d%s" % (round(abs(v) * 50), "R" if v > 0 else "L")
        self.mixer_device = types.SimpleNamespace(volume=Param(), panning=Param(0, "Track Panning", -1, 1, pct),
                                                  sends=[Param(0, "Send", 0, 1)])
    # Routing, like Live's: types and channels are objects with display_name; channels depend on the type.
    @property
    def available_input_routing_types(self): return route_sources(self, ["Ext. In", "Resampling", "No Input"])
    @property
    def available_input_routing_channels(self): return route_channels(getattr(self, "_in", None))
    @property
    def input_routing_type(self): return getattr(self, "_in", None) or self.available_input_routing_types[0]
    @input_routing_type.setter
    def input_routing_type(self, v): check_choice(v, self.available_input_routing_types); self._in = v; self._in_ch = None
    @property
    def input_routing_channel(self): return getattr(self, "_in_ch", None) or self.available_input_routing_channels[0]
    @input_routing_channel.setter
    def input_routing_channel(self, v): check_choice(v, self.available_input_routing_channels); self._in_ch = v
    @property
    def available_output_routing_types(self): return [R("Master"), R("Sends Only")]
    @property
    def available_output_routing_channels(self): return [R("Track In")]
    @property
    def output_routing_type(self): return getattr(self, "_out", None) or R("Master")
    @output_routing_type.setter
    def output_routing_type(self, v): check_choice(v, self.available_output_routing_types); self._out = v
    @property
    def output_routing_channel(self): return R("Track In")
    def insert_device(self, name, index=-1):  # Live 12.3+
        assert name in ("Drum Rack", "Simpler"), name
        d = Device("Drum Rack", INSTRUMENT, drum=True) if name == "Drum Rack" else Simpler(None)
        self.devices.insert(len(self.devices) if index == -1 else index, d)
        return d
    def delete_device(self, index): del self.devices[index]
    @property
    def has_audio_output(self): return not self.has_midi_input or any(d.type == INSTRUMENT for d in self.devices)
    output_meter_level = 0.62
    def _side_meter(self, v):  # like Live: a MIDI track with no instrument has no left or right meter
        if not self.has_audio_output: raise RuntimeError("Tracks with MIDI output have no 'output_meter_left' property!")
        return v
    @property
    def output_meter_left(self): return self._side_meter(0.6)
    @property
    def output_meter_right(self): return self._side_meter(0.62)
    def duplicate_clip_to_arrangement(self, clip, time):  # like Live: covers what was there
        c = ArrClip(clip, time)
        self.arrangement_clips = [x for x in self.arrangement_clips if not (x.start_time < c.end_time and x.end_time > c.start_time)]
        self.arrangement_clips.append(c)
        self.arrangement_clips.sort(key=lambda x: x.start_time)
    def delete_clip(self, clip): self.arrangement_clips.remove(clip)
    def stop_all_clips(self):
        for s in self.clip_slots:
            if s.clip: s.clip.is_playing = False

class NoClipTrack(Track):
    """Return tracks and Main. Like real Live (checked on the Mac, 2026-11-12), their clip properties
    raise RuntimeError, not AttributeError, so getattr(t, ..., default) doesn't protect a caller."""
    def __init__(self, name, midi=False):
        Track.__init__(self, name, midi)
        self.can_be_armed = False
    def _no(self, *_):
        raise RuntimeError("Main and Return Tracks have no Clips")
    clip_slots = property(_no, lambda self, v: None)
    playing_slot_index = property(_no, lambda self, v: None)
    arrangement_clips = property(_no, lambda self, v: None)

class Song:
    def __init__(self):
        self.tempo, self.signature_numerator, self.signature_denominator = 120.0, 4, 4
        self.is_playing, self._t = False, 0.0
        self.root_note, self.scale_name, self.scale_mode = 0, "Major", False
        self.tracks = [Track("Keys"), Track("Bass guitar", midi=False)]
        self.tracks[1].clip_slots[7].clip = AudioClip(VOCAL, "vocal loop")
        self.master_track = NoClipTrack("Main", midi=False)
        self.return_tracks = [self._return("A-Reverb"), self._return("B-Delay")]
        self.scenes = [types.SimpleNamespace(name="Intro", fire=lambda: None)]
        self.view = types.SimpleNamespace(selected_track=self.tracks[0], selected_device=None)
        self.view.select_device = lambda d: setattr(self.view, "selected_device", d)
        self.undo_count = 0
        self.stuck_selection = False  # fake-only: the next browser load lands on track 0, as in real Live on 2026-11-12
        self.after_selected = False  # the fake-only action "fake_after_selected" turns on real Live's placement
    def create_scene(self, index):  # like Live: -1 adds at the end, and every track gets an empty slot in that row
        at = len(self.scenes) if index == -1 else index
        self.scenes.insert(at, types.SimpleNamespace(name="", fire=lambda: None))
        for t in self.tracks:
            t.clip_slots.insert(min(at, len(t.clip_slots)) if index != -1 else len(t.clip_slots), Slot())
    record_mode, back_to_arranger, session_automation_record = False, False, False
    punch_in, punch_out = False, False
    @property
    def current_song_time(self): return self._t
    @current_song_time.setter
    def current_song_time(self, t):
        self._t = float(t)
        if not self.is_playing:  # like Live: moving the play position applies each knob's automation there
            for p in [p for p in RECORDED if getattr(p, "recorded", None)]:
                pts = [v for (pt, v) in p.recorded if pt <= self._t + 1e-9]
                p.value = pts[-1] if pts else p.recorded[0][1]  # the first point holds backwards
    def advance(self, seconds):
        """The fake's clock: song time moves while playing, and gestures are recorded while recording."""
        if not self.is_playing: return
        rec = self.record_mode  # like Live: with punch in/out, recording only happens inside the loop brace
        if rec and self.punch_in and self._t < self.loop_start - 1e-9: rec = False
        if rec and self.punch_out and self._t >= self.loop_start + self.loop_length - 1e-9: rec = False
        for t in self.tracks:  # an armed audio track records while Arrangement Record is on
            if rec and t.arm and not t.has_midi_input and getattr(t, "_rec_start", None) is None:
                # with punch in the take starts exactly on the brace; by hand it starts wherever the clock is
                t._rec_start = self.loop_start if self.punch_in else self._t
        if not rec:
            self._finish_takes(self.loop_start + self.loop_length if (self.record_mode and self.punch_out) else None)
        if self.record_mode and self.session_automation_record:
            for p in GESTURES:  # like Live: only a knob that moved gets written, and its lane then has automation
                rec = getattr(p, "recorded", [])
                if not rec or abs(rec[-1][1] - p.value) > 1e-12:
                    p.recorded = rec + [(self.current_song_time, p.value)]
                    p.automation_state = 1
                    RECORDED.add(p)
        self._t += self.tempo / 60.0 * seconds  # then the clock moves on
    def stop_all_clips(self):
        for t in self.tracks: t.stop_all_clips()
    def start_playing(self): self.is_playing = True
    def stop_playing(self):
        self._finish_takes()
        self.is_playing = False
    def _return(self, name):
        return NoClipTrack(name, midi=False)
    def create_return_track(self): self.return_tracks.append(self._return("%s-Return" % chr(ord("A") + len(self.return_tracks))))
    def delete_return_track(self, index): del self.return_tracks[index]
    def create_audio_track(self, index):
        t = Track("Audio", midi=False)
        self.tracks.insert(len(self.tracks) if index == -1 else index, t)
    def _finish_takes(self, end=None):
        """Like Live: an armed audio track's take becomes an Arrangement clip when recording ends."""
        end = self._t if end is None else end
        for t in self.tracks:
            st = getattr(t, "_rec_start", None)
            if st is not None and end > st:
                t.arrangement_clips.append(ArrClip(types.SimpleNamespace(name="Audio", is_midi_clip=False, length=end - st), st))
            t._rec_start = None
    def create_midi_track(self, index):
        t = Track("MIDI")
        if index == -1 and self.after_selected:  # like real Live: lands right after the selected track
            self.tracks.insert(self.tracks.index(self.view.selected_track) + 1, t)
        elif index == -1: self.tracks.append(t)
        else: self.tracks.insert(index, t)
    loop, loop_start, loop_length = True, 0.0, 100.0  # like the user's set on day 1: the Arrangement Loop on, 25 bars
    def move_device(self, device, target, position):
        for owner in [t for t in self.tracks] + [c for t in self.tracks for d in t.devices for c in getattr(d, "chains", [])]:
            if device in owner.devices:
                owner.devices.remove(device)
        target.devices.insert(position, device)
        return position
    def duplicate_track(self, index):
        import copy
        src = self.tracks[index]
        t = copy.copy(src)
        t.devices, t.arrangement_clips = list(src.devices), list(src.arrangement_clips)
        t.clip_slots = [Slot() for _ in src.clip_slots]
        for a, b in zip(src.clip_slots, t.clip_slots): b.clip = a.clip
        self.tracks.insert(index + 1, t)  # like Live: the copy sits right after it
    def delete_track(self, index):
        gone = self.tracks.pop(index)
        if self.view.selected_track is gone:  # like Live: the selection moves to a neighbour
            self.view.selected_track = self.tracks[min(index, len(self.tracks) - 1)]
    @property
    def can_undo(self): return True
    def undo(self): self.undo_count += 1

# ---- routing stand-ins ----
class R:
    def __init__(self, name): self.display_name = name
    def __eq__(self, o): return isinstance(o, R) and o.display_name == self.display_name
    def __hash__(self): return hash(self.display_name)

def route_sources(me, extra):
    return [R(x) for x in extra[:2]] + [R("%d-%s" % (i + 1, t.name)) for i, t in enumerate(SONG.tracks) if t is not me] + [R(x) for x in extra[2:]]

def route_channels(src):
    if src is None or src.display_name in ("No Input",):
        return [R("1/2"), R("1"), R("2")] if src is None else [R("")]
    t = [t for i, t in enumerate(SONG.tracks) if "%d-%s" % (i + 1, t.name) == src.display_name]
    if not t:
        return [R("1/2"), R("1"), R("2")]
    chans = [R("Pre FX"), R("Post FX"), R("Post Mixer")]
    for d in t[0].devices:  # a Drum Rack's chains can be picked one by one, as in Live
        for pad in getattr(d, "drum_pads", ()):
            for c in pad.chains:
                chans.append(R("%s | %s | Post FX" % (d.name, c.name)))
    return chans

def check_choice(v, choices):
    if v not in choices: raise ValueError("not one of the available choices")

class DeviceIO:
    """Like Live's DeviceIO: one routable input of a device (a plugin's sidechain bus)."""
    def __init__(self): self._type, self._chan = None, None
    @property
    def available_routing_types(self): return [R("No Input")] + route_sources(None, [])
    @property
    def routing_type(self): return self._type or R("No Input")
    @routing_type.setter
    def routing_type(self, v): check_choice(v, self.available_routing_types); self._type, self._chan = v, None
    @property
    def available_routing_channels(self): return route_channels(self._type) if self._type else [R("")]
    @property
    def routing_channel(self): return self._chan or self.available_routing_channels[0]
    @routing_channel.setter
    def routing_channel(self, v): check_choice(v, self.available_routing_channels); self._chan = v

# ---- stand-in for Live's browser, devices and Drum Rack ----
INSTRUMENT, AUDIO_FX, MIDI_FX = 1, 2, 4
DeviceType = types.SimpleNamespace(undefined=0, instrument=INSTRUMENT, audio_effect=AUDIO_FX, midi_effect=MIDI_FX)

def db_text(v):
    return "-inf dB" if v <= 0 else "%.1f dB" % (60.0 * math.log10(v / 0.85))

GESTURES = set()
RECORDED = set()  # knobs with automation, so a jump of the play position applies it (as in Live)

class Param:
    """Like Live's DeviceParameter. The default is a mixer volume: value 0..1, 0.85 is 0 dB, shown by str_for_value."""
    def __init__(self, value=0.85, name="Volume", lo=0.0, hi=1.0, show=db_text, items=None, enabled=True):
        self.name, self.value, self.min, self.max, self.show = name, value, lo, hi, show
        self.is_quantized, self.value_items, self.is_enabled = items is not None, tuple(items or ()), enabled
    def str_for_value(self, v):
        return self.value_items[int(v)] if self.is_quantized else self.show(v)
    # Like Live: a gesture marks knob moves that belong together; while Arrangement Record and Automation Arm are on,
    # Live records them onto the track's automation lane. The fake keeps (song time, value) pairs.
    automation_state = 0  # like Live: 0 = no automation on this knob's lane
    def begin_gesture(self): GESTURES.add(self)
    def end_gesture(self): GESTURES.discard(self)

class PluginParam(Param):
    """Like a VST3 parameter in Live: 0..1, str_for_value ignores its argument and shows the current setting,
    which the plugin updates a moment after the value changes."""
    def __init__(self, value, name, show):
        Param.__init__(self, value, name, 0.0, 1.0, show)
        self.shown = show(value)
    def str_for_value(self, v): return self.shown
    def tick(self): self.shown = self.show(self.value)

PLUGINS = ("Kickstart 2", "ValhallaSupermassive", "Melodyne")

def params_for(name):
    on = Param(1, "Device On", 0, 1, items=["Off", "On"])
    if name in PLUGINS:
        return [on, PluginParam(0.0, "LowCut", lambda v: "%d Hz" % round(10 + 1990 * v)),
                PluginParam(0.5, "Mix", lambda v: "%d %%" % round(v * 100))]
    if name == "Drum Buss":
        return [on, Param(0.2, "Drive", 0, 1, lambda v: "%d %%" % round(v * 100)),
                Param(0, "Crunch", 0, 1, lambda v: "%d %%" % round(v * 100)),
                Param(1, "Boom Freq", 0, 1, lambda v: "%.2f kHz" % ((30 * (2000 / 30) ** v) / 1000) if 30 * (2000 / 30) ** v >= 1000 else "%d Hz" % round(30 * (2000 / 30) ** v)),
                Param(0, "Type", 0, 2, items=["Soft", "Medium", "Hard"]),
                Param(0.5, "Locked Knob", 0, 1, lambda v: "%d %%" % round(v * 100), enabled=False)]
    if name == "Echo":
        # Like Live's Echo: synced times are whole steps -6 ... 0 shown as note lengths, with no named choices.
        return [on, Param(-2.0, "L Synced", -6, 0, lambda v: "1/%d" % (2 ** -int(round(v))))]
    if name in ("Large Hall", "Reverb"):
        return [on, Param(0.3, "Dry/Wet", 0, 1, lambda v: "%d %%" % round(v * 100)),
                Param(0.4, "Decay Time", 0, 1, lambda v: "%.2f s" % (0.2 * 300 ** v) if 0.2 * 300 ** v >= 1 else "%d ms" % round(200 * 300 ** v))]
    return [on]

class Sample:
    """Like Live's Sample: the file, warp, and slicing settings (slices depend on the style)."""
    def __init__(self, file_path):
        self.file_path = file_path
        self.warping, self.warp_mode = True, 0
        self.slicing_style, self.slicing_sensitivity, self.slicing_beat_division, self.slicing_region_count = 0, 0.5, 4, 8
    @property
    def slices(self):
        return [0] * {0: int(4 + self.slicing_sensitivity * 20), 1: 16, 2: self.slicing_region_count, 3: 1}[self.slicing_style]

class Simpler:
    """Like Live's SimplerDevice: holds one sample (on a pad, or on its own track), keeps its own settings when the sample changes."""
    def __init__(self, file_path):
        self.name, self.type, self.class_name, self.can_have_drum_pads = "Simpler", INSTRUMENT, "OriginalSimpler", False
        self.parameters = params_for("Simpler") + [Param(0.0, "Transpose", -48, 48, lambda v: "%d st" % round(v))]
        self.sample = Sample(file_path) if file_path is not None else None
        self.playback_mode, self.slicing_playback_mode = 0, 0
    def replace_sample(self, path):
        if not os.path.isfile(path): raise RuntimeError("not a valid audio file")
        self.sample = Sample(path)

class Device:
    def __init__(self, name, kind, drum=False):
        self.name, self.type, self.class_name = name, kind, "DrumGroupDevice" if drum else name.replace(" ", "")
        self.can_have_drum_pads = drum
        self.parameters = params_for(name)
        self.audio_inputs, self.midi_inputs = [], []
        if name in PLUGINS:
            self.class_name = "PluginDevice"
            # Real Live 12 (checked 2026-11-10 and 11-12): a VST3's sidechain bus isn't in audio_inputs, so scripts can't reach it.

        self.can_have_chains = drum or name == "808 Rack"
        if name == "808 Rack":  # like the user's 808: an Instrument Rack with devices inside one chain
            self.chains = [Chain("808", [Device("Operator", INSTRUMENT), Device("Saturator", AUDIO_FX), Device("Drum Buss", AUDIO_FX)])]
        if drum:
            self.drum_pads = [DrumPad(n) for n in range(128)]
            self.view = types.SimpleNamespace(selected_drum_pad=self.drum_pads[36])

class Compressor(Device):
    """Live's Compressor: its sidechain routing is on the device itself, not in audio_inputs."""
    def __init__(self, name, kind):
        Device.__init__(self, name, kind)
        self._sc = DeviceIO()
    available_input_routing_types = property(lambda me: me._sc.available_routing_types)
    available_input_routing_channels = property(lambda me: me._sc.available_routing_channels)
    input_routing_type = property(lambda me: me._sc.routing_type, lambda me, v: setattr(me._sc, "routing_type", v))
    input_routing_channel = property(lambda me: me._sc.routing_channel, lambda me, v: setattr(me._sc, "routing_channel", v))

class Chain:
    """A rack chain, like Live's Chain: a name and its devices."""
    def __init__(self, name, devices):
        self.name, self.devices = name, devices
        self.mixer_device = types.SimpleNamespace(volume=Param())
    def delete_device(self, index): del self.devices[index]

class DrumChain:
    def __init__(self, name, file_path=""):
        self.name, self.choke_group = name, 0
        self.mixer_device = types.SimpleNamespace(volume=Param())
        self.devices = [Simpler(file_path)]

class DrumPad:
    def __init__(self, note): self.note, self.name, self.chains = note, "", []

class Item:
    def __init__(self, name, kids=(), loadable=True, device=False, kind=None, path=None):
        self.name, self.children, self.is_loadable, self.is_device = name, list(kids), loadable, device
        self.is_folder = not loadable and not device
        self.kind, self.path = kind, path
    def __repr__(self): return "Item(%s)" % self.name

def folder(name, *kids): return Item(name, kids, loadable=False)
def dev(name, kind, *presets): return Item(name, presets, device=True, kind=kind)

KIT_NAMES = ["1 kick.wav", "2 snare.wav", "3 closed hat.wav", "4 open hat.wav", "5 clap.wav", "6 low tom.wav", "7 high tom.wav", "8 ride.wav"]
SAMPLES_DIR = "C:\\Users\\sam\\Documents\\Samples"
KIT_FILES = []
for n in KIT_NAMES:
    f = SAMPLES_DIR + "\\Fluffy Kit - finger drums\\" + n
    KIT_FILES += [Item(n, kind="sample", path=f), Item(n + ".asd", kind="sample", path=f + ".asd")]
KIT_FILES.reverse()  # the bridge must sort them itself

class Browser:
    def __init__(self):
        self.instruments = folder("Instruments", dev("Drum Rack", "drum_rack"), dev("Simpler", INSTRUMENT), dev("Operator", INSTRUMENT, Item("Bass.adv", kind=INSTRUMENT)))
        self.drums = folder("Drums", dev("Drum Rack", "drum_rack"), folder("Drum Hits", Item("Kick 808.wav", kind="sample")))
        self.audio_effects = folder("Audio Effects", dev("Drum Buss", AUDIO_FX, Item("Crunchy.adv", kind=AUDIO_FX)),
                                    dev("Glue Compressor", AUDIO_FX), dev("Compressor", AUDIO_FX), dev("Echo", AUDIO_FX), dev("808 Rack", AUDIO_FX), dev("Reverb", AUDIO_FX, folder("Hall", Item("Large Hall.adv", kind=AUDIO_FX))))
        self.midi_effects = folder("MIDI Effects", dev("Arpeggiator", MIDI_FX), dev("Chord", MIDI_FX))
        # Sounds: Live's ready-made presets, by kind. "Noisy Pad" comes as .adg and .adv, as in Live, to check exact paths.
        S = lambda n: Item(n, kind=INSTRUMENT)
        self.sounds = folder("Sounds",
                             folder("Pad", S("Warm Analog Pad.adg"), S("Noisy Pad.adg"), S("Noisy Pad.adv"), S("Dark Drone Pad.adv")),
                             folder("Piano & Keys", S("E-Piano Rusty.adg"), S("Grand Piano.adg"), S("Organ Basic.adv")),
                             folder("Bass", S("808 Drifter.adg"), S("Acid Bass.adv")),
                             folder("MPE Sounds", S("MPE Airy Pad.adg")))
        self.samples = folder("Samples", Item("Clap 1.wav", kind="sample"))
        self.plugins = folder("Plug-Ins", dev("Melodyne", AUDIO_FX), dev("Kickstart 2", AUDIO_FX), dev("ValhallaSupermassive", AUDIO_FX))
        self.max_for_live = folder("Max for Live")
        self.user_library = folder("User Library", folder("Presets"))
        self.user_folders = [folder("Samples", folder("Fluffy Kit - finger drums", *KIT_FILES), folder("Empty kit"),
                                    folder("Extra hits", Item("Crunchy Snare.wav", kind="sample", path=SAMPLES_DIR + "\\Extra hits\\Crunchy Snare.wav")))]
        self.hotswap_target = None
        self.loads = []

    def load_item(self, item):
        # Like Live: loads onto the selected track; a sample with a Drum Rack pad as the hotswap target goes on that pad.
        self.loads.append(item.name)
        t = SONG.tracks[0] if SONG.stuck_selection else SONG.view.selected_track  # see fake_stuck_selection
        target = self.hotswap_target
        if item.kind == "sample":
            if isinstance(target, Simpler):  # hot-swap the sample inside a Simpler: its settings stay
                target.sample = Sample(item.path)
                for pad in [p for d in t.devices if getattr(d, "can_have_drum_pads", False) for p in d.drum_pads]:
                    for c in pad.chains:
                        if target in c.devices:
                            c.name = pad.name = item.name.rsplit(".", 1)[0]
                return
            if isinstance(target, DrumPad):
                target.chains = [DrumChain(item.name.rsplit(".", 1)[0], item.path or "")]
                target.name = target.chains[0].name
                return
            t.devices.append(Device("Simpler", INSTRUMENT))
            return
        if item.kind == "drum_rack":
            d = Device("Drum Rack", INSTRUMENT, drum=True)
        else:
            nm = item.name.rsplit(".", 1)[0]
            d = (Compressor if nm == "Compressor" else Device)(nm, item.kind)
        if isinstance(target, Device) and target in t.devices and d.type == INSTRUMENT:
            REPLACING.append((t, target, d))  # hot-swap: the new instrument takes the old one's place, next tick
            return
        if d.type == INSTRUMENT:
            t.devices = [x for x in t.devices if x.type != INSTRUMENT]  # Live replaces the instrument
        PENDING.append((t, d))  # appears on the next tick, as in Live

PENDING = []
REPLACING = []
BROWSER = Browser()
SONG = Song()

def finish_loads():
    while PENDING:
        t, d = PENDING.pop(0)
        t.devices.append(d)
    while REPLACING:
        t, old, d = REPLACING.pop(0)
        t.devices[t.devices.index(old)] = d
    for t in SONG.tracks:  # plugins show a new setting a tick later
        for d in t.devices:
            for prm in d.parameters:
                if isinstance(prm, PluginParam): prm.tick()

Live = types.ModuleType("Live")
class WarpMarker:
    def __init__(self, sample_time, beat_time): self.sample_time, self.beat_time = float(sample_time), float(beat_time)
Live.Clip = types.SimpleNamespace(MidiNoteSpecification=Note, WarpMarker=WarpMarker)

class ArrAudio(Enveloped):
    """An audio clip on the Arrangement with warp markers: (seconds into the file) -> (clip beat), straight lines between."""
    def __init__(self, path, name, start, seconds):
        beats = seconds * SONG.tempo / 60.0
        self.file_path, self.name, self.is_midi_clip, self.muted, self.warping = path, name, False, False, True
        self.start_time, self.end_time, self.length, self.start_marker = float(start), float(start) + beats, beats, 0.0
        self.sample_rate = 22050.0
        self.warp_markers = [WarpMarker(0.0, 0.0), WarpMarker(seconds * self.sample_rate, beats)]
    def sample_to_beat_time(self, t):
        m = self.warp_markers
        for a, b in zip(m, m[1:]):
            if t <= b.sample_time or b is m[-1]:
                return a.beat_time + (t - a.sample_time) * (b.beat_time - a.beat_time) / (b.sample_time - a.sample_time)
    def add_warp_marker(self, w):
        m = sorted(self.warp_markers + [w], key=lambda x: x.sample_time)
        if any(b.beat_time <= a.beat_time or b.sample_time <= a.sample_time for a, b in zip(m, m[1:])):
            raise RuntimeError("warp markers must stay in order")
        self.warp_markers = m
    def remove_warp_marker(self, beat_time):
        self.warp_markers = [x for x in self.warp_markers if abs(x.beat_time - beat_time) > 1e-4]

def click_wav(path, times, seconds=4.0, rate=22050):
    """A test take: a short decaying tone at each time (seconds)."""
    import wave, struct
    n = int(seconds * rate); x = [0.0] * n
    for t in times:
        for i in range(int(0.06 * rate)):
            j = int(t * rate) + i
            if j < n: x[j] += 0.8 * math.sin(2 * math.pi * 440 * i / rate) * math.exp(-i / (0.012 * rate))
    w = wave.open(path, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
    w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, v)) * 32767)) for v in x)); w.close()

def _fake_vocal_stack(self):
    """Two audio tracks with takes at bar 5: the stack's notes start 30 ms late, and one of them 200 ms late."""
    lead = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5]
    late = [t + 0.03 for t in lead]; late[3] = lead[3] + 0.2
    out = []
    for name, times in (("Lead Vox", lead), ("Stack Vox", late)):
        path = os.path.join(tempfile.gettempdir(), "fake-live-%s.wav" % name.replace(" ", "-").lower())
        click_wav(path, times)
        t = Track(name, midi=False)
        t.arrangement_clips = [ArrAudio(path, name + " take", 16.0, 4.0)]
        SONG.tracks.append(t); out.append(SONG.tracks.index(t))
    return {"lead": out[0], "stack": out[1], "tempo": SONG.tempo}
def _fake_stack_markers(self, track):
    c = SONG.tracks[int(track)].arrangement_clips[0]
    return {"markers": [[round(m.sample_time / c.sample_rate, 4), round(m.beat_time, 4)] for m in c.warp_markers], "warping": c.warping}
Live.Device = types.SimpleNamespace(DeviceType=DeviceType)
Live.Track = types.SimpleNamespace(DeviceInsertMode=types.SimpleNamespace(default=0, selected_left=1, selected_right=2))
APP = types.SimpleNamespace(get_major_version=lambda: 0, get_minor_version=lambda: 0, get_bugfix_version=lambda: 0,  # 0.0.0 tells mcp_client.ts it's the stand-in
                            browser=BROWSER)
Live.Application = types.SimpleNamespace(get_application=lambda: APP)
sys.modules["Live"] = Live

class ControlSurface:
    def __init__(self, c_instance): self.messages = []
    def song(self): return SONG
    def log_message(self, m): print("[log]", m, flush=True)
    def show_message(self, m): print("[status bar]", m, flush=True)
    def update_display(self): pass
    def disconnect(self): pass

fw = types.ModuleType("_Framework"); csm = types.ModuleType("_Framework.ControlSurface")
csm.ControlSurface = ControlSurface
sys.modules["_Framework"] = fw; sys.modules["_Framework.ControlSurface"] = csm

import SecondChair  # noqa: E402

# Spare UDP ports, so a test run never talks to the real Chord Coach while Live is open. Set SECOND_CHAIR_PORT
# (for example 19885) to test while Live itself holds 9885; mcp_client.ts and the MCP server read it too.
SecondChair.OSC_IN_PORT, SecondChair.OSC_OUT_PORT, SecondChair.EARS_PORT = 19886, 19887, 19888
SecondChair.PORT = int(os.environ.get("SECOND_CHAIR_PORT", SecondChair.PORT))

# A fake-only action: from now on, new tracks land after the selected track, as in real Live.
# (Off at first, so the other tests' track numbers stay put.)
# Another one: "fake_user_tempo" changes the tempo the way the user would by hand, outside the bridge.
SecondChair.ACTIONS = SecondChair.ACTIONS + ("fake_after_selected", "fake_user_tempo", "fake_stuck_selection", "fake_recorded", "fake_clear_recorded")
def _fake_clear_recorded(self, track):
    m = SONG.tracks[int(track)].mixer_device
    m.volume.recorded, m.panning.recorded = [], []
    return {"cleared": True}
SecondChair.SecondChair._a_fake_clear_recorded = _fake_clear_recorded
SecondChair.ACTIONS = SecondChair.ACTIONS + ("fake_vocal_stack", "fake_stack_markers")
SecondChair.SecondChair._a_fake_vocal_stack = _fake_vocal_stack
SecondChair.SecondChair._a_fake_stack_markers = _fake_stack_markers
def _fake_recorded(self, track):
    m = SONG.tracks[int(track)].mixer_device
    pts, pan = getattr(m.volume, "recorded", []), [v for _, v in getattr(m.panning, "recorded", [])]
    return {"pan_points": len(pan), "pan_min": min(pan) if pan else None, "pan_max": max(pan) if pan else None,
            "volume_values": [round(v, 3) for _, v in pts], "points": len(pts),
            "volume_points": [[round(t, 3), round(v, 5)] for t, v in pts], "first": pts[0] if pts else None, "last": pts[-1] if pts else None,
            "loop": SONG.loop, "automation_arm": SONG.session_automation_record, "record": SONG.record_mode,
            "playing": SONG.is_playing, "armed": [t.name for t in SONG.tracks if t.arm]}
SecondChair.SecondChair._a_fake_recorded = _fake_recorded
SecondChair.SecondChair._a_fake_stuck_selection = lambda self, on=True: setattr(SONG, "stuck_selection", bool(on)) or {"stuck_selection": SONG.stuck_selection}
SecondChair.SecondChair._a_fake_user_tempo = lambda self, bpm: setattr(SONG, "tempo", float(bpm)) or {"tempo": SONG.tempo}
SecondChair.SecondChair._a_fake_after_selected = lambda self: setattr(SONG, "after_selected", True) or {"after_selected": True}

bridge = SecondChair.create_instance(None)

# ---- stand-in for the Chord Coach Max device (OSC over UDP on loopback) ----
EM9 = (40, 55, 59, 62, 66)
stop_device = threading.Event()

def fake_device():
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.bind(("127.0.0.1", SecondChair.OSC_OUT_PORT))
    rx.settimeout(0.1)
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    to_bridge = ("127.0.0.1", SecondChair.OSC_IN_PORT)
    t0 = time.time()
    next_hello, stage, t_chord = 0.0, 0, 0.0
    while not stop_device.is_set():
        now = time.time() - t0
        if now >= next_hello:
            tx.sendto(SecondChair.osc_encode("/cc/hello"), to_bridge)
            next_hello += 2.0
        if stage == 0 and now >= 2.0:
            for n in EM9:
                tx.sendto(SecondChair.osc_encode("/cc/note", [n, 100]), to_bridge)
            stage, t_chord = 1, now
        if stage == 1 and now >= t_chord + 0.3:
            tx.sendto(SecondChair.osc_encode("/cc/note", [71, 100]), to_bridge)
            tx.sendto(SecondChair.osc_encode("/cc/note", [71, 0]), to_bridge)
            stage = 2
        try:
            data, _ = rx.recvfrom(4096)
        except socket.timeout:
            continue
        try:
            addr, args = SecondChair.osc_decode(data)
            print("[device got]", addr, " ".join(str(a) for a in args), flush=True)
        except Exception as e:
            print("[device got] undecodable packet:", e, flush=True)
    rx.close(); tx.close()

threading.Thread(target=fake_device, daemon=True).start()

# ---- stand-in for a Second Chair Ears Max device: off until the fake-only action "fake_ears" drops it on a track ----
EARS_ON = {"track": None}
EARS_FRAME = [-6.0, -18.0, -40.0, -21.0, -27.0, -33.0, -39.0, -45.0, -51.0, -60.0]  # peak, rms, then 8 bands: bass-heavy

def fake_ears():
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    to_bridge = ("127.0.0.1", SecondChair.EARS_PORT)
    tick = 0
    while not stop_device.is_set():
        track = EARS_ON["track"]
        if track is not None:
            tick += 1
            frame = list(EARS_FRAME)
            if tick % 2:
                frame[0] = -9.0  # the peak wobbles, so "now" and "the last moment" can differ
            tx.sendto(SecondChair.osc_encode("/ears/levels", [4242, "track", int(track)] + frame), to_bridge)
            tx.sendto(SecondChair.osc_encode("/ears/levels", [4243, "nowhere", 0] + frame), to_bridge)  # must be ignored
            tx.sendto(SecondChair.osc_encode("/ears/levels", [4244, "track", 999] + frame), to_bridge)  # no such track
        time.sleep(0.25)
    tx.close()

def _fake_ears(self, track=None):
    EARS_ON["track"] = None if track is None else int(track)
    return {"ears_on_track": EARS_ON["track"]}
SecondChair.ACTIONS = SecondChair.ACTIONS + ("fake_ears",)
SecondChair.SecondChair._a_fake_ears = _fake_ears
threading.Thread(target=fake_ears, daemon=True).start()
end = time.time() + float(sys.argv[1] if len(sys.argv) > 1 else 20)
while time.time() < end:
    finish_loads()           # browser loads land between ticks, as in Live
    bridge.update_display()  # Live calls this on its main thread about every 100 ms
    SONG.advance(0.05)       # knob moves are written at the time they happen, then the clock moves on
    time.sleep(0.05)
stop_device.set()
bridge.disconnect()
k =SONG.tracks[0].clip_slots[0].clip
print("[final] tempo", SONG.tempo, "scale", SONG.root_note, SONG.scale_name, "clip notes", len(k.notes) if k else 0, "undos", SONG.undo_count, "held", sorted(bridge._held), flush=True)
