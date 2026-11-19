#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$ROOT/branding/app-icon-source.png"
RESOURCE="$ROOT/android/app/src/main/res"

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick (magick) is required to regenerate the Android icons." >&2
  exit 1
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "Icon source not found: $SOURCE" >&2
  exit 1
fi
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

# Use the complete supplied artwork as the adaptive background. Android applies
# the device's launcher mask to this full image, so the original lettering and
# five symbols stay together instead of being clipped from an oversized layer.
magick "$SOURCE" -resize 1024x1024\! -depth 8 -strip \
  "PNG24:$TEMP_DIR/background.png"
mkdir -p "$RESOURCE/drawable-nodpi"
cp "$TEMP_DIR/background.png" "$RESOURCE/drawable-nodpi/launcher_background_art.png"

while read -r density adaptive_size legacy_size; do
  directory="$RESOURCE/mipmap-$density"
  mkdir -p "$directory"

  # All visual content is already in the background layer. Keep a transparent
  # foreground so Android's adaptive mask does not scale/crop a second logo.
  magick -size "${adaptive_size}x${adaptive_size}" xc:none -depth 8 \
    "PNG32:$directory/ic_launcher_foreground.png"

  magick "$SOURCE" -resize "${legacy_size}x${legacy_size}\!" -depth 8 \
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
