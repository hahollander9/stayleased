#!/bin/bash
# SessionStart hook — prepares a Claude Code on the web container to work on StayLeased.
#
# Remote sessions start from a fresh clone with no node_modules and no graphify CLI, so
# `npx tsc --noEmit` fails on a missing pdf-lib and the graphify PreToolUse hooks no-op.
# This closes both gaps before the session takes its first turn.
#
# Rules this script keeps:
#   - web only (local machines are left alone; see CLAUDE_CODE_REMOTE)
#   - idempotent (warm containers re-run it in well under a second)
#   - non-interactive, and never fatal: tooling must not stop a session from starting
set -uo pipefail

# Local/desktop sessions manage their own environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}" || exit 0

export PATH="$HOME/.local/bin:$PATH"

# 1. Node dependencies — pdf-lib, typescript, playwright.
#    `install` not `ci`, so a warm cached container skips the work.
if [ -f package.json ]; then
  echo "[session-start] npm install"
  npm install --no-audit --no-fund --loglevel=error || echo "[session-start] WARN: npm install failed — tsc and tests will not run"
fi

# 2. graphify CLI. The [sql] extra is required or src/db/schema.sql is silently
#    dropped from the graph (tree_sitter_sql does not ship by default).
if ! command -v graphify >/dev/null 2>&1; then
  echo "[session-start] installing graphify"
  if command -v uv >/dev/null 2>&1; then
    uv tool install --quiet "graphifyy[sql]" || echo "[session-start] WARN: graphify install failed — /graphify will self-install on first use"
  elif command -v pipx >/dev/null 2>&1; then
    pipx install "graphifyy[sql]" || echo "[session-start] WARN: graphify install failed"
  else
    echo "[session-start] WARN: no uv or pipx — skipping graphify"
  fi
fi

# 3. Build the knowledge graph. AST-only: no LLM, no API key, no cost.
#    Without it the PreToolUse guards have nothing to consult. SessionStart also fires on
#    resume/clear/compact, so skip the ~9s rebuild unless a source file is actually newer
#    than the graph.
if command -v graphify >/dev/null 2>&1; then
  if [ ! -f graphify-out/graph.json ] \
     || [ -n "$(find src tests e2e -type f -newer graphify-out/graph.json -print -quit 2>/dev/null)" ]; then
    echo "[session-start] graphify update"
    graphify update . >/dev/null 2>&1 || echo "[session-start] WARN: graph build failed — run 'graphify update .' by hand"
  else
    echo "[session-start] graph current"
  fi
fi

# 4. Persist PATH for the session's own shells.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
fi

echo "[session-start] ready"
exit 0
