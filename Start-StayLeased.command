#!/bin/bash
# StayLeased demo launcher (macOS / Linux). Double-click me (macOS: right-click -> Open the first time).
cd "$(dirname "$0")" || exit 1

echo "=========================================="
echo "  StayLeased - Summit Ridge demo launcher"
echo "=========================================="
echo

pause_exit() {
  echo
  read -n 1 -s -r -p "Press any key to close this window..."
  echo
  exit 1
}

# 1) Node present and new enough?
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed on this computer."
  echo "Install the LTS version from https://nodejs.org (big green button),"
  echo "then double-click this file again."
  pause_exit
fi
if ! node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=11)?0:1)"; then
  echo "Node $(node -v) is installed, but StayLeased needs Node 22.11 or newer."
  echo "Install the current LTS from https://nodejs.org, then run this again."
  pause_exit
fi
echo "Node $(node -v) - OK"

# TypeScript support: Node 22 needs the flag; newer Nodes strip types by default
# (and may eventually drop the flag), so probe instead of assuming.
RUN_FLAGS="--experimental-strip-types --no-warnings"
if ! node --experimental-strip-types -e "" >/dev/null 2>&1; then
  RUN_FLAGS="--no-warnings"
fi

# 2) Dependencies (bundled in the zip; installed only if missing)
if [ ! -f node_modules/pdf-lib/package.json ]; then
  echo
  echo "Installing dependencies (one time)..."
  npm install --omit=dev || { echo "npm install failed - see the message above."; pause_exit; }
fi

# 3) Demo world (bundled in the zip; rebuilt only if you deleted the data folder)
if [ ! -f data/.seeded ]; then
  echo
  echo "Building the demo world - about a minute, one time only..."
  node $RUN_FLAGS src/seed/seed.ts --reset || { echo "Seeding failed - see the message above."; pause_exit; }
  touch data/.seeded
fi

# 4) Pick a port and start
PORT_TO_USE=3000
if command -v nc >/dev/null 2>&1; then
  while nc -z 127.0.0.1 "$PORT_TO_USE" >/dev/null 2>&1 && [ "$PORT_TO_USE" -lt 3010 ]; do
    PORT_TO_USE=$((PORT_TO_USE + 1))
  done
fi

echo
echo "Starting StayLeased at http://localhost:$PORT_TO_USE"
echo "Sign in as admin@summitridge.demo with password demo1234"
echo "(all demo logins are listed in HOW-TO-RUN.txt)"
echo
echo "Leave this window open while you use it. Close it (or press Ctrl+C) to stop."
echo

if [ "$(uname)" = "Darwin" ]; then
  (sleep 2 && open "http://localhost:$PORT_TO_USE") &
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 2 && xdg-open "http://localhost:$PORT_TO_USE" >/dev/null 2>&1) &
fi

PORT="$PORT_TO_USE" node $RUN_FLAGS src/server/main.ts
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo
  echo "The server stopped with an error (see above)."
  echo "If it says the address is in use, another app is on port $PORT_TO_USE - close it and try again."
  pause_exit
fi
