#!/usr/bin/env bash
# Copy the live app's data into the development copy (~/.claude-dashboard-dev), so it opens
# on your real customers, tickets and settings. Run it again any time to refresh the copy.
#
#   ./scripts/dev-seed.sh
#
# The live data is read, never changed. The dev copy runs no background jobs that write
# (see IS_DEV_COPY in server/paths.ts), so a seeded copy does not save, link or remind twice.
set -euo pipefail
LIVE="${LIVE_HOME:-$HOME/.claude-dashboard}"
DEV="${DEV_HOME:-$HOME/.claude-dashboard-dev}"
if lsof -ti tcp:5767 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "!  the dev copy is running (port 5767): stop it first, then seed"
  exit 1
fi
mkdir -p "$DEV"
# A consistent copy of the database while the live app keeps running.
sqlite3 "$LIVE/index.db" ".backup '$DEV/index.db'"
rm -f "$DEV/index.db-wal" "$DEV/index.db-shm"
for f in settings.json ba-edition.json models.json config.json commands.json calendar-watch.json mcp.json; do
  [ -f "$LIVE/$f" ] && cp "$LIVE/$f" "$DEV/$f"
done
echo "✓ dev copy seeded from $LIVE ($(du -sh "$DEV/index.db" | awk '{print $1}') database)"
