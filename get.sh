#!/bin/bash
# Install or update Claude Dashboard (BA edition) on a Mac. Nothing else needed:
# no git, Homebrew, Node or Bun. Paste this into Terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/MathijsRochus/claude-dashboard/qargo-ba-edition/get.sh | bash
#
# Run the same line again to update. It:
#   1. installs Claude Code with Anthropic's installer if it is missing, and signs you in;
#   2. downloads the app, built by GitHub from this repository, into /Applications;
#   3. asks how you want to use it: as an app with its own window, or in your browser
#      (the dashboard then starts by itself when you log in, at http://localhost:5757).
#
# Options: --app | --browser   skip the question
#          --yes               answer yes to every question
#
# Downloaded with curl, so macOS opens the app without a warning: only files a
# browser downloads are quarantined. Written for the bash 3.2 that ships with macOS.

set -euo pipefail

REPO="${CLAUDE_DASHBOARD_REPO:-MathijsRochus/claude-dashboard}"
TAG="${CLAUDE_DASHBOARD_TAG:-ba-app}"
ASSET="Claude-Dashboard-arm64.zip"
APP_NAME="Claude Dashboard"
APPS_DIR="${CLAUDE_DASHBOARD_APPS_DIR:-/Applications}"
LABEL="com.qargo.claude-dashboard"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
DATA_DIR="$HOME/.claude-dashboard"
PORT=5757
URL="http://localhost:$PORT"
DOWNLOAD="https://github.com/$REPO/releases/download/$TAG"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; X=$'\033[0m'
else
  B=""; D=""; R=""; G=""; Y=""; X=""
fi
ok()   { printf "  %s✓%s %s\n" "$G" "$X" "$*"; }
warn() { printf "  %s!%s %s\n" "$Y" "$X" "$*"; }
bad()  { printf "  %s✗%s %s\n" "$R" "$X" "$*"; }
hint() { printf "      %s%s%s\n" "$D" "$*" "$X"; }
step() { printf "\n%s%s%s\n" "$B" "$*" "$X"; }
die()  { bad "$1"; [ -n "${2:-}" ] && hint "$2"; printf "\n"; exit 1; }

MODE=""
YES=0
TMP=""

# The script itself arrives on stdin through the pipe, so questions are asked on
# the terminal directly. Without one (CI, a script), nothing is asked.
has_tty() { (exec </dev/tty) 2>/dev/null; }

ask_yes() {
  [ "$YES" = 1 ] && return 0
  has_tty || return 1
  local reply
  printf "      %s%s [Y/n]%s " "$B" "$1" "$X"
  read -r reply </dev/tty || return 1
  case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}

# A value out of a JSON file, with what every Mac has.
json_value() { plutil -extract "$2" raw -o - "$1" 2>/dev/null || true; }

running_health() {
  local f="$TMP/health.json"
  curl -fsS --max-time 2 "$URL/api/health" -o "$f" 2>/dev/null && echo "$f"
}

find_claude() {
  if command -v claude >/dev/null 2>&1; then command -v claude; return; fi
  local c
  for c in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    if [ -x "$c" ]; then echo "$c"; return; fi
  done
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --app) MODE=app ;;
      --browser) MODE=browser ;;
      -y|--yes) YES=1 ;;
      -h|--help) sed -n '2,18p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die "unknown option: $1" "options: --app, --browser, --yes" ;;
    esac
    shift
  done

  TMP="$(mktemp -d "${TMPDIR:-/tmp}/claude-dashboard.XXXXXX")"
  trap 'rm -rf "$TMP"' EXIT

  printf "\n%sClaude Dashboard (BA edition)%s\n" "$B" "$X"

  # ── this Mac ────────────────────────────────────────────────────────────────
  [ "$(uname -s)" = Darwin ] || die "this installs a Mac app; it needs macOS"
  # hw.optional.arm64, not uname -m: a Terminal running under Rosetta reports x86_64.
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ] ||
    die "the app runs on Apple silicon Macs (M1 or later) only"

  # ── how to use it ───────────────────────────────────────────────────────────
  if [ -z "$MODE" ]; then
    local current=app
    [ -f "$AGENT" ] && current=browser
    if has_tty && [ "$YES" = 0 ]; then
      step "How do you want to use it?"
      printf "  %s1%s  App       its own window and Dock icon\n" "$B" "$X"
      printf "  %s2%s  Browser   a tab in your browser at %s; starts by itself when you log in\n" "$B" "$X" "$URL"
      if [ "$current" = app ]; then printf "\n      %s[1]%s " "$B" "$X"; else printf "\n      %s[2]%s " "$B" "$X"; fi
      local reply=""
      read -r reply </dev/tty || true
      case "$reply" in
        1|a*|A*) MODE=app ;;
        2|b*|B*) MODE=browser ;;
        *) MODE="$current" ;;
      esac
    else
      MODE="$current"
    fi
  fi

  # ── Claude Code ─────────────────────────────────────────────────────────────
  step "Claude Code"
  local claude
  claude="$(find_claude)"
  if [ -n "$claude" ]; then
    ok "found ($claude)"
  else
    warn "not installed; the dashboard runs its sessions on it"
    if ask_yes "Install it now with Anthropic's installer?"; then
      curl -fsSL https://claude.ai/install.sh | bash
      claude="$(find_claude)"
      [ -n "$claude" ] || die "Claude Code did not install" "try again, or see https://docs.claude.com/en/docs/claude-code/setup"
      ok "installed ($claude)"
    else
      die "the dashboard needs Claude Code" "install it from https://docs.claude.com/en/docs/claude-code/setup and run this again"
    fi
  fi

  if "$claude" auth status --json 2>/dev/null | grep -Eq '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
    ok "signed in"
  else
    warn "not signed in yet"
    if has_tty && ask_yes "Sign in now? Your browser opens on the Claude sign-in page."; then
      "$claude" auth login </dev/tty || true
    fi
    if "$claude" auth status --json 2>/dev/null | grep -Eq '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
      ok "signed in"
    else
      warn "still not signed in; sessions will not start until you are"
      hint "sign in later with: $claude auth login"
    fi
  fi

  # ── download ────────────────────────────────────────────────────────────────
  step "Download"
  local build
  build="$(curl -fsSL "$DOWNLOAD/build.txt" 2>/dev/null | head -1 || true)"
  [ -n "$build" ] || die "could not reach the download at $DOWNLOAD" "check your internet connection, then run this again"
  local dest="$APPS_DIR/$APP_NAME.app"
  if [ ! -w "$APPS_DIR" ]; then
    # Not an administrator: an Applications folder of their own works the same.
    APPS_DIR="$HOME/Applications"
    mkdir -p "$APPS_DIR"
    dest="$APPS_DIR/$APP_NAME.app"
  fi
  local installed=""
  [ -f "$dest/Contents/Resources/daemon/package.json" ] &&
    installed="$(json_value "$dest/Contents/Resources/daemon/package.json" build)"

  if [ -n "$installed" ] && [ "$installed" = "$build" ]; then
    ok "build $build is already installed"
  else
    # The zip and the unpacked app need about 1 GB together while it installs.
    local free_kb
    free_kb="$(df -Pk "$TMP" | awk 'NR==2 {print $4}')"
    if [ -n "$free_kb" ] && [ "$free_kb" -lt 1300000 ]; then
      die "not enough free disk space: $((free_kb / 1024)) MB free, about 1.3 GB needed" "free up some space, then run this again"
    fi
    printf "  downloading build %s\n" "$build"
    curl -fL --progress-bar "$DOWNLOAD/$ASSET" -o "$TMP/app.zip" ||
      die "the download failed" "run this again in a minute"
    ditto -x -k "$TMP/app.zip" "$TMP/x" || die "could not unpack the download" "check you have about 1.3 GB free, then run this again"
    rm -f "$TMP/app.zip"
    [ -d "$TMP/x/$APP_NAME.app" ] || die "the download did not contain the app"
    codesign --verify --strict "$TMP/x/$APP_NAME.app" 2>/dev/null || die "the downloaded app failed its signature check; nothing was changed"

    # ── install ───────────────────────────────────────────────────────────────
    step "Install"
    if pgrep -f "$dest/Contents/MacOS/" >/dev/null 2>&1; then
      printf "  quitting the running app (its sessions keep running)\n"
      osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
      local i=0
      while pgrep -f "$dest/Contents/MacOS/" >/dev/null 2>&1 && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
      pgrep -f "$dest/Contents/MacOS/" >/dev/null 2>&1 && die "the app is still open" "quit it (⌘Q), then run this again"
    fi
    rm -rf "$dest"
    # A move on the same disk takes no time and no extra space; a copy is the fallback.
    mv "$TMP/x/$APP_NAME.app" "$dest" 2>/dev/null || ditto "$TMP/x/$APP_NAME.app" "$dest"
    xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
    if [ -n "$installed" ]; then ok "updated $installed → $build"; else ok "installed in $APPS_DIR"; fi
  fi

  if [ -n "${CLAUDE_DASHBOARD_NO_START:-}" ]; then
    # For testing the download and install without stopping or starting anything.
    step "Start"
    ok "skipped (CLAUDE_DASHBOARD_NO_START); would set up: $MODE"
    return 0
  fi

  # ── a dashboard from another build ──────────────────────────────────────────
  # The background process outlives the app, so after an update an old one can
  # still be serving. Restarting it ends the sessions it runs; they stay in
  # History and can be resumed.
  local h running_build running_pid
  h="$(running_health || true)"
  if [ -n "$h" ]; then
    running_build="$(json_value "$h" build)"
    running_pid="$(json_value "$h" pid)"
    if [ -n "$running_build" ] && [ "$running_build" != "$build" ] && [ -n "$running_pid" ]; then
      step "Restart"
      warn "the dashboard running now is build $running_build"
      if ask_yes "Restart it on the new build? Running sessions stop; you can resume them from History."; then
        kill -TERM "$running_pid" 2>/dev/null || true
        local i=0
        while running_health >/dev/null && [ $i -lt 40 ]; do sleep 0.5; i=$((i + 1)); done
        ok "stopped"
      else
        hint "it switches over the next time it restarts"
      fi
    fi
  fi

  # ── app or browser ──────────────────────────────────────────────────────────
  step "Start"
  if [ "$MODE" = browser ]; then
    mkdir -p "$HOME/Library/LaunchAgents" "$DATA_DIR"
    # The same start the app makes (electron/daemon.ts), handed to launchd so it
    # comes up at login and comes back if it crashes, but stays down when the app
    # restarts it on purpose.
    cat >"$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$dest/Contents/Resources/bun</string>
    <string>run</string>
    <string>$dest/Contents/Resources/daemon/server/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>DASHBOARD_HOME</key><string>$DATA_DIR</string>
    <key>DASHBOARD_LINK_BASE</key><string>claude-dashboard://open</string>
    <key>PATH</key><string>$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$DATA_DIR/daemon.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/daemon.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    if running_health >/dev/null; then
      # One is already serving (the app started it). A second would only fail on the
      # port and be restarted over and over, so launchd takes over from the next login.
      ok "already running; from your next login it starts by itself"
    else
      launchctl bootstrap "gui/$(id -u)" "$AGENT"
    fi
    printf "  starting (the first start reads all your past sessions, which can take a minute)\n"
    local i=0
    while ! running_health >/dev/null && [ $i -lt 360 ]; do sleep 0.5; i=$((i + 1)); done
    running_health >/dev/null || die "the dashboard did not start" "see $DATA_DIR/daemon.log"
    ok "running at $URL, and from now on whenever you log in"
    open "$URL"
  else
    if [ -f "$AGENT" ]; then
      # Switching back from the browser: the app starts the dashboard itself.
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
      rm -f "$AGENT"
      ok "no longer starts at login; the app starts it"
    fi
    open "$dest"
    ok "opened $APP_NAME"
  fi

  printf "\n%s✓ done%s\n\n" "$G" "$X"
  printf "  Update later by running the same line again.\n"
  if [ "$MODE" = browser ]; then
    printf "  Bookmark %s. The app in %s opens the same dashboard in a window.\n" "$URL" "$APPS_DIR"
  else
    printf "  The same dashboard also opens in your browser at %s while the app is running.\n" "$URL"
  fi
  printf "  Turn on the BA features under Settings → BA edition.\n\n"
}

main "$@"
