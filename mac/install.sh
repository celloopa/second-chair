#!/bin/sh
# Mac version of live-bridge/install.ps1. Installs the CelloBridge Remote Script into Live's User Library
# and creates the shared token. Safe to run again: it replaces the script and keeps the existing token.
# The token is never printed.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../live-bridge/remote_script/CelloBridge"
dest="$HOME/Music/Ableton/User Library/Remote Scripts/CelloBridge"
tokdir="$HOME/CelloBridge"
tok="$tokdir/token"

mkdir -p "$dest"
cp "$src"/*.py "$dest/"
rm -rf "$dest/__pycache__"   # Live recompiles on its next start

# Both the Remote Script (os.path.expanduser("~")) and cello-live (APPDATA || HOME) find ~/CelloBridge/token on the Mac.
umask 077
mkdir -p "$tokdir"
chmod 700 "$tokdir"
if [ ! -s "$tok" ]; then
  openssl rand -hex 24 > "$tok"
  echo "Created token at $tok"
fi
chmod 600 "$tok"
echo "Installed CelloBridge to $dest"

# Chord Coach: the .amxd loads chordcoach.js from its own folder, so both files go together.
# On the Mac the User Library is not nested (Windows has User Library\User Library).
umask 022
cc="$HOME/Music/Ableton/User Library/Presets/MIDI Effects/Max MIDI Effect/Chord Coach"
mkdir -p "$cc"
cp "$here/../chord-coach/Chord Coach.amxd" "$here/../chord-coach/chordcoach.js" "$cc/"
echo "Installed Chord Coach to $cc"
echo "Next: quit and reopen Live, then Settings > Link, Tempo & MIDI > Control Surface > pick CelloBridge (Input/Output: None)."
