#!/bin/zsh
set -euo pipefail
HERE="${0:A:h}"
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  for candidate in /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node /Applications/Codex.app/Contents/Resources/cua_node/bin/node; do
    if [[ -x "$candidate" ]]; then NODE="$candidate"; break; fi
  done
fi
if [[ -z "$NODE" ]]; then
  echo 'Node.js 22+ is required.'
  exit 2
fi
exec "$NODE" "$HERE/ChatGPT_Account_Route_Probe.mjs" "$@"
