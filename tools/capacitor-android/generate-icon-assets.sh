#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$ROOT/branding/app-icon-source.png"
BACKGROUND="$ROOT/branding/app-icon-background.png"
RESOURCE="$ROOT/android/app/src/main/res"

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick (magick) is required to regenerate the Android icons." >&2
  exit 1
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "Icon source not found: $SOURCE" >&2
  exit 1
fi
if [[ ! -f "$BACKGROUND" ]]; then
  echo "Icon background not found: $BACKGROUND" >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

# Keep a crisp, full-bleed blue/gold illustration behind the logo.
magick "$BACKGROUND" -resize 1024x1024\! -depth 8 -strip \
  "PNG24:$TEMP_DIR/background.png"
mkdir -p "$RESOURCE/drawable-nodpi"
cp "$TEMP_DIR/background.png" "$RESOURCE/drawable-nodpi/launcher_background_art.png"

# Remove only the connected dark backdrop from the supplied logo, preserving
# the sharp lettering and symbols as transparent foreground artwork.
magick "$SOURCE" -alpha set -fuzz 24% -fill none \
  -draw 'color 0,0 floodfill' -depth 8 "PNG32:$TEMP_DIR/foreground-source.png"

make_foreground_content() {
  local size="$1"
  local inner=$((size * 92 / 100))
  local offset=$(((size - inner) / 2))

  magick "$TEMP_DIR/foreground-source.png" -resize "${inner}x${inner}\!" \
    -depth 8 "PNG32:$TEMP_DIR/content.png"
  printf '%s %s\n' "$inner" "$offset"
}

while read -r density adaptive_size legacy_size; do
  directory="$RESOURCE/mipmap-$density"
  mkdir -p "$directory"

  read -r inner offset < <(make_foreground_content "$adaptive_size")
  magick -size "${adaptive_size}x${adaptive_size}" xc:none \
    "$TEMP_DIR/content.png" -geometry "+$offset+$offset" -compose Over -composite \
    -depth 8 "PNG32:$directory/ic_launcher_foreground.png"

  read -r inner offset < <(make_foreground_content "$legacy_size")
  magick "$TEMP_DIR/background.png" -resize "${legacy_size}x${legacy_size}\!" "$TEMP_DIR/legacy-background.png"
  magick "$TEMP_DIR/legacy-background.png" "$TEMP_DIR/content.png" \
    -geometry "+$offset+$offset" -compose Over -composite -depth 8 \
    "PNG24:$directory/ic_launcher.png"
  cp "$directory/ic_launcher.png" "$directory/ic_launcher_round.png"
done <<'DENSITIES'
mdpi 108 48
hdpi 162 72
xhdpi 216 96
xxhdpi 324 144
xxxhdpi 432 192
DENSITIES

echo "Generated sharp Android launcher icons with a full-bleed illustration and safe logo margins."
