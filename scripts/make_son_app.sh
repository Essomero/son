#!/bin/bash
# Build ~/Applications/Son.app — a double-clickable launcher for the whole
# agent: starts `uv run python son.py` in a Terminal window (or reuses the
# running instance), waits for :7860, opens the page in the default browser.
#
# Usage: ./scripts/make_son_app.sh        (from the repo root)
# Then:  open ~/Applications/Son.app      (or add it to the Dock)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC_APPLE="$REPO/scripts/Son.applescript"
SVG="$REPO/scripts/assets/app-icon.svg"
APPS_DIR="$HOME/Applications"
BUNDLE="$APPS_DIR/Son.app"
WORK="$REPO/scripts/assets/.iconwork"

UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
if [ ! -x "$UV" ]; then
  echo "error: can't find uv — install it or edit the UV line in this script" >&2
  exit 1
fi

# --- assemble the app bundle -------------------------------------------------
mkdir -p "$APPS_DIR"
rm -rf "$BUNDLE"

sed -e "s|__REPO__|$REPO|g" -e "s|__UV__|$UV|g" "$SRC_APPLE" | \
  osacompile -o "$BUNDLE"

# --- icon: SVG -> PNG -> iconset -> icns (best-effort) -----------------------
if command -v qlmanage >/dev/null && command -v sips >/dev/null && command -v iconutil >/dev/null; then
  rm -rf "$WORK"
  # iconutil requires the directory to end in ".iconset"
  ICONSET="$WORK/app-icon.iconset"
  mkdir -p "$ICONSET"
  # qlmanage keeps the source basename: app-icon.svg.png
  if qlmanage -t -s 1024 -o "$WORK" "$SVG" >/dev/null 2>&1 &&
     [ -f "$WORK/app-icon.svg.png" ]; then
    mv "$WORK/app-icon.svg.png" "$WORK/app-icon.png"
    for size in 16 32 128 256 512; do
      sips -z "$size" "$size" "$WORK/app-icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
      sips -z $((size * 2)) $((size * 2)) "$WORK/app-icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
    done
    if iconutil -c icns "$ICONSET" -o "$BUNDLE/Contents/Resources/applet.icns"; then
      echo "icon: applied"
    fi
  fi
fi

echo "Built $BUNDLE"
echo "Run it with:  open $BUNDLE   (or drag it to the Dock)"
