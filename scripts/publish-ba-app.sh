#!/usr/bin/env bash
# Build the BA edition's Mac app on this Mac and publish it on the rolling
# `ba-app` release that get.sh downloads.
#
#   ./scripts/publish-ba-app.sh                     build, then publish to origin's repository
#   ./scripts/publish-ba-app.sh --repo owner/name   publish somewhere else (a fork, to test)
#   ./scripts/publish-ba-app.sh --no-build          publish the zip from the last build
#
# The GitHub workflow (.github/workflows/ba-app.yml) does the same on every push;
# this is for when GitHub has no Mac runner free, or to publish a build at once.
# Needs bun, the gh CLI logged in with write access to the repository, and an
# Apple silicon Mac.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/preflight.sh
source scripts/preflight.sh

REPO=""
BUILD_IT=1
ZIP="build/Claude-Dashboard-arm64.zip"
TAG="ba-app"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs owner/name}"; shift ;;
    --no-build) BUILD_IT=0 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) bad "unknown option: $1"; exit 1 ;;
  esac
  shift
done

have gh || { bad "the gh CLI is required"; hint "https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { bad "gh is not logged in"; hint "gh auth login"; exit 1; }
[ -n "$REPO" ] || REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
SHA="$(git rev-parse HEAD)"

if ! git diff --quiet HEAD -- . ':!build'; then
  warn "the checkout has uncommitted changes; the build includes them, but the release names $(git rev-parse --short HEAD)"
fi

if [ "$BUILD_IT" = 1 ]; then
  ensure_bun_on_path
  bun install --frozen-lockfile
  if [ ! -d node_modules/electron/dist ]; then
    # Electron's download script runs under Node; Bun 1.4 fails it.
    if have node; then node node_modules/electron/install.js; else bun node_modules/electron/install.js; fi
  fi
  ./scripts/build-app.sh --zip "$ZIP"
fi
[ -f "$ZIP" ] || { bad "no $ZIP; build first"; exit 1; }

BUILD="$(sed -nE 's/.*"build"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' build/app-daemon/package.json | head -1)"
[ -n "$BUILD" ] || { bad "could not read the build name from build/app-daemon/package.json"; exit 1; }
echo "$BUILD" > build/build.txt

step "Publishing $BUILD to $REPO"
# The tag follows the commit it was built from; the commit has to be on GitHub.
if ! gh api "repos/$REPO/commits/$SHA" >/dev/null 2>&1; then
  bad "commit $(git rev-parse --short HEAD) is not on $REPO yet; push it first"
  exit 1
fi
gh api -X PATCH "repos/$REPO/git/refs/tags/$TAG" -f sha="$SHA" -F force=true >/dev/null 2>&1 ||
  gh api -X POST "repos/$REPO/git/refs" -f ref="refs/tags/$TAG" -f sha="$SHA" >/dev/null
NOTES="Built from ${SHA:0:7} ($BUILD). Install or update on a Mac (Apple silicon) with:

\`\`\`
curl -fsSL https://raw.githubusercontent.com/$REPO/qargo-ba-edition/get.sh | bash
\`\`\`"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release edit "$TAG" --repo "$REPO" --notes "$NOTES" --latest=false >/dev/null
else
  gh release create "$TAG" --repo "$REPO" --title "Claude Dashboard (BA edition)" --notes "$NOTES" --latest=false >/dev/null
fi
# Replace each file by deleting it first: --clobber on a large upload can report
# "already exists" after it has in fact succeeded. build.txt goes last, so get.sh
# never sees a new build name before the app it names is there.
for f in "$ZIP" build/build.txt; do
  gh release delete-asset "$TAG" "$(basename "$f")" --repo "$REPO" -y >/dev/null 2>&1 || true
  gh release upload "$TAG" --repo "$REPO" "$f"
done
ok "https://github.com/$REPO/releases/tag/$TAG"
