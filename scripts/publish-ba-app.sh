#!/usr/bin/env bash
# Build the BA edition's Mac app and publish it on the rolling `ba-app` release
# that get.sh downloads, together with get.sh itself.
#
#   ./scripts/publish-ba-app.sh                     build, then publish to the repository get.sh installs from
#   ./scripts/publish-ba-app.sh --repo owner/name   publish somewhere else (a fork, to test)
#   ./scripts/publish-ba-app.sh --build-only        build into build/ba-app, publish nothing
#   ./scripts/publish-ba-app.sh --no-build          publish what is in build/ba-app
#
# Run it on your own Mac after a merge into qargo-ba-edition: the repository is
# private, where GitHub's Mac runners cost ten times their minutes, so the GitHub
# workflow (.github/workflows/ba-app.yml, --build-only then --no-build) only runs
# when started by hand. Building needs bun and an Apple silicon Mac; publishing
# needs the gh CLI with write access.
#
# Every build is a file of its own, Claude-Dashboard-arm64-<build>.zip, and
# build.txt names the current one. A publish uploads the new zip, then switches
# build.txt, then replaces get.sh, then deletes all but the newest two zips. An
# install never finds build.txt naming a zip that is not there, and one that is
# under way keeps its file. get.sh is the one from the commit the build came from.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/preflight.sh
source scripts/preflight.sh

REPO=""
BUILD_IT=1
PUBLISH_IT=1
TAG="ba-app"
OUT="build/ba-app"
PREFIX="Claude-Dashboard-arm64"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs owner/name}"; shift ;;
    --no-build) BUILD_IT=0 ;;
    --build-only) PUBLISH_IT=0 ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) bad "unknown option: $1"; exit 1 ;;
  esac
  shift
done

# ── build ─────────────────────────────────────────────────────────────────────
if [ "$BUILD_IT" = 1 ]; then
  if ! git diff --quiet HEAD -- . ':!build'; then
    warn "the checkout has uncommitted changes; the build includes them, but is named after $(git rev-parse --short HEAD)"
  fi
  ensure_bun_on_path
  bun install --frozen-lockfile
  if [ ! -d node_modules/electron/dist ]; then
    # Electron's download script runs under Node; Bun 1.4 fails it.
    if have node; then node node_modules/electron/install.js; else bun node_modules/electron/install.js; fi
  fi
  rm -rf "$OUT"
  mkdir -p "$OUT"
  ./scripts/build-app.sh --zip "$OUT/app.zip"
  BUILD="$(sed -nE 's/.*"build"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' build/app-daemon/package.json | head -1)"
  [ -n "$BUILD" ] || { bad "could not read the build name from build/app-daemon/package.json"; exit 1; }
  mv "$OUT/app.zip" "$OUT/$PREFIX-$BUILD.zip"
  # What publishing needs, kept with the build: its name, and the commit it was built from.
  echo "$BUILD" >"$OUT/build.txt"
  git rev-parse HEAD >"$OUT/commit.txt"
  git show HEAD:get.sh >"$OUT/get.sh"
  ok "built $BUILD in $OUT"
fi
[ "$PUBLISH_IT" = 1 ] || exit 0

# ── publish ───────────────────────────────────────────────────────────────────
have gh || { bad "the gh CLI is required"; hint "https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { bad "gh is not logged in"; hint "gh auth login"; exit 1; }
# By default the repository get.sh installs from, so the two cannot drift apart
# (gh's own guess follows the remotes, and can land on the upstream repository).
[ -n "$REPO" ] || REPO="$(sed -nE 's/^REPO="\$\{CLAUDE_DASHBOARD_REPO:-([^}]+)\}"$/\1/p' get.sh | head -1)"
[ -n "$REPO" ] || { bad "could not read the repository from get.sh; pass --repo owner/name"; exit 1; }

BUILD="$(head -1 "$OUT/build.txt" 2>/dev/null || true)"
SHA="$(head -1 "$OUT/commit.txt" 2>/dev/null || true)"
[ -n "$BUILD" ] && [ -n "$SHA" ] || { bad "no build in $OUT; build first"; exit 1; }
case "$BUILD" in *[!A-Za-z0-9._-]*) bad "unexpected build name: $BUILD"; exit 1 ;; esac
ZIP="$OUT/$PREFIX-$BUILD.zip"
NAME="$(basename "$ZIP")"
[ -f "$ZIP" ] || { bad "no $ZIP; build first"; exit 1; }
[ -s "$OUT/get.sh" ] || { bad "no $OUT/get.sh; build first"; exit 1; }

step "Publishing $BUILD to $REPO"

# GitHub's API answers with a 5xx now and then, so every step is tried a few
# times, and judged by what the release then holds rather than by gh's exit
# status (gh can report a large upload as failed after it has succeeded).
retry() {
  local n=1
  until "$@"; do
    [ $n -ge 4 ] && return 1
    warn "GitHub did not answer properly; trying again in $((n * 10)) s" >&2
    sleep $((n * 10))
    n=$((n + 1))
  done
}
uploaded_size() {
  gh release view "$TAG" --repo "$REPO" --json assets \
    --jq ".assets[] | select(.name == \"$1\" and .state == \"uploaded\") | .size" 2>/dev/null
}
# Fails when GitHub does not answer, rather than reporting "no build".
current_build() {
  gh release download "$TAG" --repo "$REPO" -p build.txt -O - 2>/dev/null | head -1
}
# Sets PREVIOUS to the build installs get now, or to nothing when there is no
# build.txt yet. Fails when that cannot be told.
read_previous() {
  local names
  names="$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null)" || return 1
  PREVIOUS=""
  printf '%s\n' "$names" | grep -qx build.txt || return 0
  PREVIOUS="$(current_build)" || return 1
  [ -n "$PREVIOUS" ]
}
move_tag() {
  gh api -X PATCH "repos/$REPO/git/refs/tags/$TAG" -f sha="$SHA" -F force=true >/dev/null 2>&1 ||
    gh api -X POST "repos/$REPO/git/refs" -f ref="refs/tags/$TAG" -f sha="$SHA" >/dev/null 2>&1
}
have_release() {
  gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 ||
    gh release create "$TAG" --repo "$REPO" --title "Claude Dashboard (BA edition)" --notes "$NOTES" --latest=false >/dev/null
}
upload_zip() {
  [ "$(uploaded_size "$NAME")" = "$SIZE" ] && return 0
  gh release upload "$TAG" --repo "$REPO" "$ZIP" --clobber >/dev/null 2>&1 || true
  [ "$(uploaded_size "$NAME")" = "$SIZE" ]
}
# --clobber deletes build.txt before it uploads the new one, so a failed upload
# leaves none; get.sh waits out that gap, and restore_build closes it on failure.
put_build() {
  gh release upload "$TAG" --repo "$REPO" "$1/build.txt" --clobber >/dev/null 2>&1 || true
  [ "$(current_build || true)" = "$2" ]
}
switch_build() { put_build "$OUT" "$BUILD"; }
# Also replaced with --clobber, so for a moment there is none: get.sh then keeps
# using the copy it saved of itself.
put_installer() {
  gh release upload "$TAG" --repo "$REPO" "$OUT/get.sh" --clobber >/dev/null 2>&1 || true
  [ "$(uploaded_size get.sh)" = "$(wc -c <"$OUT/get.sh" | tr -d ' ')" ]
}
restore_build() { put_build "$OUT/previous" "$PREVIOUS"; }

# The tag follows the commit the build came from; the commit has to be on GitHub.
if ! retry gh api "repos/$REPO/commits/$SHA" --silent; then
  bad "commit ${SHA:0:7} is not on $REPO yet; push it first"
  exit 1
fi
NOTES="Built from ${SHA:0:7} ($BUILD). For Macs with Apple silicon and macOS 13 or later.

**Install:** download [get.sh](https://github.com/$REPO/releases/download/$TAG/get.sh), then run it in Terminal:

\`\`\`
bash ~/Downloads/get.sh
\`\`\`

**Update:**

\`\`\`
bash ~/.claude-dashboard/get.sh
\`\`\`"
retry move_tag || { bad "could not move the $TAG tag"; exit 1; }
retry have_release || { bad "could not create the $TAG release"; exit 1; }
PREVIOUS=""
PREVIOUS_KNOWN=1
if ! retry read_previous; then
  PREVIOUS_KNOWN=0
  warn "could not read the current build.txt; old zips are kept this time"
fi

# 1. The app, under its own name, so nothing that is being downloaded changes.
SIZE="$(wc -c <"$ZIP" | tr -d ' ')"
retry upload_zip || { bad "uploading $NAME failed; installs still get ${PREVIOUS:-nothing}"; exit 1; }
ok "uploaded $NAME"

# 2. Switch installs over. For the second this takes, get.sh retries.
if ! retry switch_build; then
  if [ -n "$PREVIOUS" ]; then
    mkdir -p "$OUT/previous"
    echo "$PREVIOUS" >"$OUT/previous/build.txt"
    if retry restore_build; then
      bad "build.txt did not update; installs still get $PREVIOUS"
    else
      bad "build.txt did not update, and putting back the one naming $PREVIOUS failed too"
      hint "installs fail until build.txt is back: run this again"
    fi
  else
    bad "build.txt did not update; run this again"
  fi
  exit 1
fi
ok "build.txt names $BUILD"
# Updates keep working without it (get.sh keeps a copy of itself); first installs need it.
if retry put_installer; then ok "uploaded get.sh"; else warn "get.sh did not upload, so first installs cannot download it; run this again"; fi
retry gh release edit "$TAG" --repo "$REPO" --notes "$NOTES" --latest=false >/dev/null ||
  warn "the release notes still describe the build before"

# 3. Keep this zip and the one before it, for an install that read build.txt just
# before. Not knowing which one that was, keep them all.
[ "$PREVIOUS_KNOWN" = 1 ] || { ok "https://github.com/$REPO/releases/tag/$TAG"; exit 0; }
gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' |
  { grep -E "^$PREFIX.*\.zip$" || true; } | while read -r old; do
    [ "$old" = "$NAME" ] || [ "$old" = "$PREFIX-$PREVIOUS.zip" ] && continue
    if retry gh release delete-asset "$TAG" "$old" --repo "$REPO" -y >/dev/null 2>&1; then
      ok "removed $old"
    else
      warn "could not remove $old; it does no harm"
    fi
  done
ok "https://github.com/$REPO/releases/tag/$TAG"
