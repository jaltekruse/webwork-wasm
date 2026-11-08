#!/bin/bash
# Publishes pg-wasm/dist to the gh-pages branch of this repository (GitHub
# Pages, "Deploy from a branch": gh-pages, / (root)).
#
#   pg-wasm/build.sh --opl-remote     # build first (OPL problems load from GitHub)
#   pg-wasm/tools/publish-gh-pages.sh
#
# The branch is replaced with a single commit containing the build.
set -euo pipefail

HERE="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null && pwd )"
ROOT="$( cd "$HERE/../.." && pwd )"
DIST="$ROOT/pg-wasm/dist"
[ -f "$DIST/index.html" ] || { echo "No build in $DIST (run pg-wasm/build.sh first)" >&2; exit 1; }

REMOTE="$(git -C "$ROOT" remote get-url origin)"
SRC="$(git -C "$ROOT" rev-parse --short HEAD)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -r "$DIST/." "$TMP/"
touch "$TMP/.nojekyll"   # otherwise GitHub Pages drops directories like node_modules
cd "$TMP"
git init -q -b gh-pages
git add -A
git commit -q -m "Demo site built from $SRC"
git push -f "$REMOTE" gh-pages
echo "Pushed. Enable GitHub Pages for the gh-pages branch in the repository settings if it isn't already."
