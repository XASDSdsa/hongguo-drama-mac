#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -m)" != arm64 ]; then
  echo "The bundled macOS report engine requires an Apple Silicon build machine." >&2
  exit 1
fi

version=26.8.2
archive_version=26.8.2.2
checksum=9f24fe83ab1ed5c95eb3df580119f32932f713e577feeac02bf619fb00749b55
root="$(cd "$(dirname "$0")/.." && pwd)"
destination="$root/build/libreoffice/darwin-arm64"
stamp="$destination/runtime-version.txt"
if [ -x "$destination/LibreOffice.app/Contents/MacOS/soffice" ] &&
  [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$version" ]; then
  exit 0
fi

temp="$(mktemp -d "${TMPDIR:-/tmp}/report-office.XXXXXXXX")"
mount="$temp/mount"
mounted=false
cleanup() {
  if [ "$mounted" = true ]; then hdiutil detach "$mount" -quiet || true; fi
  rm -rf -- "$temp"
}
trap cleanup EXIT

mkdir -p "$mount" "$temp/staged"
image="$temp/libreoffice.dmg"
stable="https://download.documentfoundation.org/libreoffice/stable/$version/mac/aarch64/LibreOffice_${version}_MacOS_aarch64.dmg"
archived="https://downloadarchive.documentfoundation.org/libreoffice/old/$archive_version/mac/aarch64/LibreOffice_${archive_version}_MacOS_aarch64.dmg"
if ! curl --fail --location --retry 3 --silent --show-error "$stable" --output "$image"; then
  curl --fail --location --retry 3 --silent --show-error "$archived" --output "$image"
fi
printf '%s  %s\n' "$checksum" "$image" | shasum -a 256 -c -
hdiutil attach "$image" -readonly -nobrowse -mountpoint "$mount" -quiet
mounted=true
ditto "$mount/LibreOffice.app" "$temp/staged/LibreOffice.app"
codesign --verify --deep --strict "$temp/staged/LibreOffice.app"
printf '%s\n' "$version" > "$temp/staged/runtime-version.txt"
mkdir -p "$(dirname "$destination")"
rm -rf -- "$destination"
mv "$temp/staged" "$destination"
echo "Bundled LibreOffice $version is ready for macOS arm64."
