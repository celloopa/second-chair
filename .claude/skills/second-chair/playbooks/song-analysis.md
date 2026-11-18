# Playbook: analyze a song (a full mix, then its stems)

Use for "what key is this song in", "what's the tempo", "what's the bass doing", "what's the singer's range" and "what key suits this singer". You can't hear the song, so `song_analyze` measures it. It reports and offers options; the user decides by ear.

## 1. The full mix first (seconds)

1. **Get a WAV.** The user brings the file, or exports it from Live (File > Export Audio/Video, WAV). MP3 doesn't work yet.
2. **`song_analyze {file}`** (or `{clip}` for an audio clip in Live). It gives the key and its relative key, tuning, tempo with the half and the double, the repeats, a drum map or "no clear drums", and rough bass notes.
3. **Report each reading with its confidence and its check-by-ear step.** Don't pick major or relative minor, or half or double time, for them.
4. **Offer stems** when the answer matters and the mix can't settle it: no clear drums, the relative key is close, the bass looks odd, or they want the singer's range.

## 2. Stems (Live Suite 12.3 or later; minutes, by hand)

Tools can't start Stem Separation. The user clicks:

1. **Save the set first.** Then the stems land in the project's `Samples\Processed\Stems` folder.
2. **Right-click the audio clip > Separate Stems to New Audio Tracks.** Pick all four stems (Vocals, Drums, Bass, Others). High Quality is slower (several minutes for a short song on a CPU) but cleaner.
3. **Live adds a group track** named "<song> Stems". `live_status` shows it (`is_group`).
4. **Separate Stems can change the set's tempo** to Live's own guess. Mention it, and ask before changing the tempo back.

## 3. Read the stems (about 10 to 20 seconds)

- **`song_analyze {stems: <group index>}`**, or `{stems: {vocals, drums, bass, others}}` with full paths. Add `file` if they have the full mix; without it, the stems are added together.
- **Levels first.** A near-silent stem means that part isn't in the song (a drumless song still gives a Drums stem of leakage). Say so plainly: "there are no drums".
- **Tempo feel:** from where the snare lands (2 and 4 of the felt tempo). With no drums, the chord rhythm and the phrasing set it; the user taps along and decides.
- **Key:** the chords (Others) and the melody (Vocals) can lean to relative keys. Report both: "the chords lean G minor, the melody leans B♭ major". The user hums the home note.
- **Bass:** its notes in order, when it plays, and whether it has one home note.
- **Vocals:** the held range, the usual zone (10th to 90th percentile), and the notes with the most time. **Stems leak:** trust the usual zone over the extremes.
- **Keys that suit this singer:** options only. Each says where the melody would sit. Suggest trying two or three with the singer and choosing by ear. The range is only what was sung in this song.

## 4. Check with tools you already have (optional)

- **Chords:** the user runs Convert Harmony to New MIDI Track on the Others stem (`live_convert_to_midi` can, when asked). Then `live_get_clip_notes` and the chord namer read it. Ableton warns of extra notes, so it stays rough.
- **Melody:** Convert Melody on the Vocals stem gives notes they can see, a check on the measured range.

## Don't

- Don't change the set while analyzing. These readings change nothing.
- Don't download songs. The user brings the audio, and only audio they may use.
- Don't present a key, a feel or a singer's key as the answer. They are measurements and options.
