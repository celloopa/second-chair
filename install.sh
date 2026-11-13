#!/bin/sh
# Mac installer. It only checks that Node is there, then runs install.mjs, which does the work.
#   sh install.sh             install or update
#   sh install.sh --check     change nothing, report the setup
#   sh install.sh --uninstall
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "Node isn't installed. Get Node 24 or newer from https://nodejs.org (the LTS button), install it,"
  echo "open a NEW Terminal window, and run this again."
  exit 1
fi
exec node "$here/install.mjs" "$@"
