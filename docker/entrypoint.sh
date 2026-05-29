#!/bin/sh
# Gateway container entrypoint.
#
#   1. Wait for Microcks to be healthy.
#   2. Run `mock sync` so every spec under /app/specs/ is loaded into
#      Microcks before we start taking traffic.
#   3. Hand off to `mock serve` (PID 1 so signals reach the gateway).
#
# Designed to be re-runnable: on container restart, `mock sync` is
# idempotent (replaces existing services), so a restart cleanly
# re-applies any spec changes that landed via the mounted volume.

set -eu

# ── 1. Wait for Microcks ──────────────────────────────────────────────
microcks_url="${MICROCKS_URL:-http://microcks:8080}"
echo "› entrypoint: waiting for Microcks at ${microcks_url}…"

i=0
max_wait="${MICROCKS_WAIT_SECONDS:-120}"
while [ "$i" -lt "$max_wait" ]; do
  if wget -q -O /dev/null --tries=1 --timeout=2 "${microcks_url}/api/services"; then
    echo "✓ entrypoint: Microcks is up after ${i}s."
    break
  fi
  i=$((i + 2))
  sleep 2
done

if [ "$i" -ge "$max_wait" ]; then
  echo "✗ entrypoint: Microcks never came up at ${microcks_url} after ${max_wait}s." >&2
  exit 1
fi

# ── 2. Sync specs ─────────────────────────────────────────────────────
# `mock sync` is tolerant — a single bad spec doesn't fail the run, but
# if literally every spec fails it exits non-zero, which kills the
# container and lets the orchestrator restart us.
echo "› entrypoint: syncing specs to Microcks…"
node /app/dist/cli.js sync || {
  echo "✗ entrypoint: spec sync failed completely. Restarting." >&2
  exit 1
}

# ── 3. Serve ──────────────────────────────────────────────────────────
echo "› entrypoint: starting gateway on :${PORT:-3000}…"
exec node /app/dist/cli.js serve
