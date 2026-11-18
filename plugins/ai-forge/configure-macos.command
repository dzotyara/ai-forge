#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_EXE=""

if command -v node >/dev/null 2>&1; then
  NODE_EXE=$(command -v node)
fi

if [ -z "$NODE_EXE" ]; then
  for candidate in \
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
    "$HOME/Library/Caches/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
    "/Applications/ChatGPT.app/Contents/Resources/node/bin/node" \
    "/Applications/Codex.app/Contents/Resources/node/bin/node"
  do
    if [ -x "$candidate" ]; then
      NODE_EXE="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE_EXE" ]; then
  for root in \
    "$HOME/.cache/codex-runtimes" \
    "$HOME/Library/Caches/codex-runtimes" \
    "$HOME/.codex"
  do
    if [ -d "$root" ]; then
      NODE_EXE=$(find "$root" -type f -path '*/dependencies/node/bin/node' -print -quit 2>/dev/null || true)
      if [ -n "$NODE_EXE" ]; then
        break
      fi
    fi
  done
fi

if [ -z "$NODE_EXE" ]; then
  echo "Could not find Node.js. Install Node.js 18 or newer, for example: brew install node" >&2
  exit 1
fi

exec "$NODE_EXE" "$SCRIPT_DIR/configure.mjs"
