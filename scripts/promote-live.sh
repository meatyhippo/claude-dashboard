#!/usr/bin/env bash
# Put this checkout into the installed app (the live one), then restart its daemon.
#
#   ./scripts/promote-live.sh          wait until no session is working, then promote
#   ./scripts/promote-live.sh --now    don't wait
#   ./scripts/promote-live.sh --full   rebuild and reinstall the whole app (for electron/ changes;
#                                      quits the app window)
#
# The daemon restart takes a few seconds; open chats reconnect on their own.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="/Applications/Claude Dashboard.app"
RR="$APP/Contents/Resources"
WAIT=1
FULL=0
for a in "$@"; do
  case "$a" in
    --now) WAIT=0 ;;
    --full) FULL=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a"; exit 1 ;;
  esac
done

echo "→ checking types"
node_modules/.bin/tsc --noEmit -p .

if [ "$FULL" = 1 ]; then
  osascript -e 'quit app "Claude Dashboard"' || true
  exec ./scripts/build-app.sh --install
fi

busy() {
  curl -s --max-time 5 localhost:5757/api/agents | python3 -c "import json,sys
d=json.load(sys.stdin); a=d if isinstance(d,list) else d.get('agents',[])
b=[x.get('title') or '?' for x in a if x.get('status') in ('thinking','starting','awaiting_permission','permission')]
print(', '.join(b)); sys.exit(1 if b else 0)" 2>/dev/null
}
if [ "$WAIT" = 1 ]; then
  until out=$(busy); do echo "… waiting for: $out"; sleep 10; done
fi

echo "→ building the UI"
node_modules/.bin/vite build --logLevel warn
echo "→ copying into $APP"
rsync -a --delete dist/ "$RR/daemon/dist/"
rsync -a server/ "$RR/daemon/server/"
rsync -a shared/ "$RR/daemon/shared/"
codesign --force --sign - --entitlements scripts/entitlements.plist --timestamp=none "$APP" 2>/dev/null
echo "→ restarting the live daemon"
lsof -ti tcp:5757 -sTCP:LISTEN | xargs kill 2>/dev/null || true
sleep 2
env -u ELECTRON_RUN_AS_NODE PORT=5757 DASHBOARD_HOME="$HOME/.claude-dashboard" nohup "$RR/bun" run "$RR/daemon/server/index.ts" >> "$HOME/.claude-dashboard/daemon.log" 2>&1 &
for _ in $(seq 1 20); do curl -s -o /dev/null localhost:5757/api/agents && break; sleep 1; done
curl -s -o /dev/null -w "✓ live app updated (daemon answers %{http_code})\n" localhost:5757/api/agents
