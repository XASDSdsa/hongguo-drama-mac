#!/usr/bin/env bash
# Build current FFmpeg with the NVENC API supported by the reported Windows driver.
set -euo pipefail
ROOT=${1:?Usage: build-ffmpeg-source-win.sh BUILD_DIRECTORY [JOBS]}
JOBS=${2:-4}
[[ ${MSYSTEM:-} == MINGW64 ]] || { echo 'Run in an MSYS2 MINGW64 shell' >&2; exit 1; }
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { echo 'JOBS must be a positive integer' >&2; exit 1; }
SCRIPT=$(realpath "$0")
mkdir -p "$ROOT"
ROOT=$(cd "$ROOT" && pwd)
ARCHIVES="$ROOT/archives"
SOURCES="$ROOT/sources"
PREFIX="$ROOT/prefix"
ARTIFACTS="$ROOT/artifacts"
NAME=ffmpeg-9.0.2-nvenc12.2-win-x64
mkdir -p "$ARCHIVES" "$SOURCES" "$PREFIX/include" "$PREFIX/lib/pkgconfig" "$ROOT/logs" "$ARTIFACTS/$NAME/bin" "$ARTIFACTS/$NAME/licenses"
trap 'echo "Build failed; recent diagnostic logs:" >&2; for f in "$ROOT"/logs/*.log "$ROOT"/build-ffmpeg/ffbuild/config.log; do [[ ! -f "$f" ]] || { echo "$f" >&2; tail -n 70 "$f" >&2; }; done' ERR
export PATH=/mingw64/bin:/usr/bin:$PATH
export PKG_CONFIG_PATH=
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH LDFLAGS CFLAGS CPPFLAGS || true

fetch() {
  local name=$1 sha=$2 url=$3
  [[ -f "$ARCHIVES/$name" ]] || curl -fL --retry 3 --connect-timeout 30 --silent --show-error "$url" -o "$ARCHIVES/$name"
  printf '%s  %s\n' "$sha" "$ARCHIVES/$name" | sha256sum -c -
  printf '%s  %s  %s\n' "$sha" "$name" "$url" >> "$ROOT/SOURCES.txt"
}
: > "$ROOT/SOURCES.txt"
fetch ffmpeg-9.0.2.tar.xz 8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
fetch nv-codec-headers-n12.2.72.0.tar.gz dbeaec433d93b850714760282f1d0992b1254fc3b5a6cb7d76fc1340a1e47563 https://github.com/FFmpeg/nv-codec-headers/archive/refs/tags/n12.2.72.0.tar.gz
fetch libvpl-2.17.0.tar.gz 4de3e2faf1e8307fb282e4a43f443191810f6a6b0a484fffa7995ba1c814c6ec https://github.com/intel/libvpl/archive/refs/tags/v2.17.0.tar.gz
fetch AMF-1.5.2.tar.gz 8a70b6dc85261e6e6e57769bd81ac1e09c0a4c96bbd5e358ffbc2dee51e8e50a https://github.com/GPUOpen-LibrariesAndSDKs/AMF/archive/refs/tags/v1.5.2.tar.gz
fetch zlib-1.3.2.tar.xz d7a0654783a4da529d1bb793b7ad9c3318020af77667bcae35f95d0e42a792f3 https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.xz
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
X264_ARCHIVE="$ARCHIVES/x264-$X264_COMMIT.tar.gz"
# Pin Git content rather than a generated gzip checksum, which differs across platforms.
FETCH_DIR=$(mktemp -d "$ROOT/x264-fetch.XXXXXX")
git -C "$FETCH_DIR" init --quiet
git -C "$FETCH_DIR" fetch --quiet --depth 1 https://code.videolan.org/videolan/x264.git "$X264_COMMIT"
[[ $(git -C "$FETCH_DIR" rev-parse --verify 'FETCH_HEAD^{commit}') == "$X264_COMMIT" ]]
X264_TREE=$(git -C "$FETCH_DIR" rev-parse --verify 'FETCH_HEAD^{tree}')
git -C "$FETCH_DIR" archive --format=tar --prefix="x264-$X264_COMMIT/" "$X264_COMMIT" | gzip -n > "$X264_ARCHIVE"
X264_SHA=$(sha256sum "$X264_ARCHIVE" | cut -d ' ' -f 1)
printf '%s  %s  %s\n' "$X264_SHA" "x264-$X264_COMMIT.tar.gz" "https://code.videolan.org/videolan/x264.git#$X264_COMMIT" >> "$ROOT/SOURCES.txt"
printf 'x264 Git commit: %s\nx264 Git tree: %s\n' "$X264_COMMIT" "$X264_TREE" >> "$ROOT/SOURCES.txt"
for archive in "$ARCHIVES"/*; do tar -xf "$archive" -C "$SOURCES"; done

make -C "$SOURCES/nv-codec-headers-n12.2.72.0" PREFIX="$PREFIX" install > "$ROOT/logs/nv-codec-install.log" 2>&1
mkdir -p "$PREFIX/include/AMF"
cp -r "$SOURCES/AMF-1.5.2/amf/public/include/core" "$SOURCES/AMF-1.5.2/amf/public/include/components" "$PREFIX/include/AMF/"
# The legacy MSVC shim must not replace the secure CRT functions provided by MinGW.
VPL_DEFS="$SOURCES/libvpl-2.17.0/libvpl/src/windows/mfx_dispatcher_defs.h"
grep -Fxq '#if _MSC_VER < 1400' "$VPL_DEFS"
cp "$VPL_DEFS" "$ROOT/mfx_dispatcher_defs.h.original"
sed -i 's/^#if _MSC_VER < 1400$/#if defined(_MSC_VER) \&\& _MSC_VER < 1400/' "$VPL_DEFS"
diff -u --label a/libvpl/src/windows/mfx_dispatcher_defs.h --label b/libvpl/src/windows/mfx_dispatcher_defs.h \
  "$ROOT/mfx_dispatcher_defs.h.original" "$VPL_DEFS" > "$ROOT/libvpl-mingw-secure-crt.patch" || [[ $? == 1 ]]
printf 'libvpl patch: restrict legacy MSVC secure-CRT shims to defined _MSC_VER (build script).\n' >> "$ROOT/SOURCES.txt"
cmake -S "$SOURCES/libvpl-2.17.0" -B "$ROOT/build-vpl" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF -DINSTALL_EXAMPLES=OFF \
  > "$ROOT/logs/vpl-configure.log" 2>&1
cmake --build "$ROOT/build-vpl" --parallel "$JOBS" > "$ROOT/logs/vpl-build.log" 2>&1
cmake --install "$ROOT/build-vpl" > "$ROOT/logs/vpl-install.log" 2>&1
cmake -S "$SOURCES/zlib-1.3.2" -B "$ROOT/build-zlib" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DZLIB_BUILD_SHARED=OFF -DZLIB_BUILD_STATIC=ON -DZLIB_BUILD_TESTING=OFF \
  > "$ROOT/logs/zlib-configure.log" 2>&1
cmake --build "$ROOT/build-zlib" --target zlibstatic --parallel "$JOBS" > "$ROOT/logs/zlib-build.log" 2>&1
cp "$ROOT/build-zlib/libzs.a" "$PREFIX/lib/libz.a"
cp "$SOURCES/zlib-1.3.2/zlib.h" "$ROOT/build-zlib/zconf.h" "$PREFIX/include/"
mkdir -p "$ROOT/build-x264" "$ROOT/build-ffmpeg"
cd "$ROOT/build-x264"
"$SOURCES/x264-$X264_COMMIT/configure" --prefix="$PREFIX" --host=x86_64-w64-mingw32 \
  --enable-static --disable-cli --disable-opencl --disable-avs --disable-swscale \
  --disable-lavf --disable-ffms --disable-gpac --disable-lsmash --disable-bashcompletion \
  > "$ROOT/logs/x264-configure.log" 2>&1
make -j "$JOBS" > "$ROOT/logs/x264-build.log" 2>&1
make install-lib-static > "$ROOT/logs/x264-install.log" 2>&1
cd "$ROOT/build-ffmpeg"
"$SOURCES/ffmpeg-9.0.2/configure" --prefix="$PREFIX" --arch=x86_64 --target-os=mingw32 \
  --extra-version=hongguo-nvenc12.2 \
  --disable-autodetect --disable-shared --enable-static --disable-doc --disable-debug --disable-ffplay \
  --enable-gpl --enable-version3 --enable-libx264 --enable-libvpl --enable-ffnvcodec --enable-nvenc --enable-amf \
  --enable-d3d11va --enable-dxva2 --enable-zlib --enable-schannel --enable-w32threads --disable-pthreads \
  --pkg-config-flags=--static --extra-cflags="-I$PREFIX/include" \
  --extra-ldflags="-L$PREFIX/lib -static -static-libgcc -static-libstdc++" --extra-libs=-lstdc++ \
  > "$ROOT/logs/ffmpeg-configure.log" 2>&1
make -j "$JOBS" ffmpeg.exe ffprobe.exe > "$ROOT/logs/ffmpeg-build.log" 2>&1
install -m 755 ffmpeg.exe ffprobe.exe "$ARTIFACTS/$NAME/bin/"
for license in "$SOURCES/ffmpeg-9.0.2/"COPYING*; do cp "$license" "$ARTIFACTS/$NAME/licenses/$(basename "$license").txt"; done
cp "$SOURCES/ffmpeg-9.0.2/LICENSE.md" "$ARTIFACTS/$NAME/licenses/FFmpeg-LICENSE.txt"
cp "$SOURCES/x264-$X264_COMMIT/COPYING" "$ARTIFACTS/$NAME/licenses/x264-COPYING.txt"
cp "$SOURCES/libvpl-2.17.0/LICENSE" "$ARTIFACTS/$NAME/licenses/libvpl-LICENSE.txt"
cp "$SOURCES/libvpl-2.17.0/third-party-programs.txt" "$ARTIFACTS/$NAME/licenses/libvpl-third-party-programs.txt"
cp "$SOURCES/AMF-1.5.2/LICENSE.txt" "$ARTIFACTS/$NAME/licenses/AMF-LICENSE.txt"
cp "$SOURCES/zlib-1.3.2/LICENSE" "$ARTIFACTS/$NAME/licenses/zlib-LICENSE.txt"
# NV codec headers carry their MIT license in each header.
cp "$PREFIX/include/ffnvcodec/nvEncodeAPI.h" "$ARTIFACTS/$NAME/licenses/nvEncodeAPI-LICENSE.txt"

REPORT="$ARTIFACTS/$NAME/BUILD-REPORT.txt"
{
  printf 'Build: %s\nNVENC API: 12.2 (headers n12.2.72.0)\n' "$NAME"
  printf 'Hardware encoding requires an installed compatible GPU and driver; hosted CI verifies presence, not physical GPU execution.\n'
  cat "$ROOT/SOURCES.txt"
  gcc --version
  pacman -Q
  ./ffmpeg.exe -version
  ./ffprobe.exe -version
  ./ffmpeg.exe -hide_banner -encoders
  ./ffmpeg.exe -hide_banner -filters
} > "$REPORT" 2>&1
./ffmpeg.exe -hide_banner -encoders > "$ROOT/encoders.txt" 2>&1
for encoder in libx264 h264_nvenc h264_amf h264_qsv aac; do grep -Eq "[[:space:]]$encoder[[:space:]]" "$ROOT/encoders.txt"; done
for encoder in h264_nvenc h264_amf h264_qsv; do ./ffmpeg.exe -hide_banner -h "encoder=$encoder" >> "$REPORT" 2>&1; done
printf '#include <ffnvcodec/nvEncodeAPI.h>\n' | gcc -I"$PREFIX/include" -E -dM -x c - > "$ROOT/nvenc-macros.txt"
grep -Eq '^#define NVENCAPI_MAJOR_VERSION 12$' "$ROOT/nvenc-macros.txt"
grep -Eq '^#define NVENCAPI_MINOR_VERSION 2$' "$ROOT/nvenc-macros.txt"
grep -E '^#define NVENCAPI_(MAJOR|MINOR)_VERSION ' "$ROOT/nvenc-macros.txt" >> "$REPORT"
# Keep only system DLL imports: no MSYS, GCC, or libvpl DLL may be needed at runtime.
for tool in "$ARTIFACTS/$NAME/bin/ffmpeg.exe" "$ARTIFACTS/$NAME/bin/ffprobe.exe"; do
  objdump -f "$tool" >> "$REPORT"
  objdump -f "$tool" | grep -q 'pei-x86-64'
  objdump -p "$tool" | sed -n 's/^[[:space:]]*DLL Name: //p' > "$ROOT/imports.txt"
  cat "$ROOT/imports.txt" >> "$REPORT"
  while IFS= read -r dep; do
    case "${dep,,}" in
      kernel32.dll|msvcrt.dll|ucrtbase.dll|advapi32.dll|bcrypt.dll|crypt32.dll|ncrypt.dll|gdi32.dll|ole32.dll|oleaut32.dll|shell32.dll|shlwapi.dll|user32.dll|userenv.dll|ws2_32.dll|secur32.dll|d3d11.dll|dxgi.dll|dxva2.dll|setupapi.dll|version.dll|winmm.dll|imm32.dll|ntdll.dll|psapi.dll|avicap32.dll|msvfw32.dll|api-ms-win-*.dll) ;;
      *) echo "Unexpected non-system dependency: $dep" >&2; exit 1;;
    esac
  done < "$ROOT/imports.txt"
done
(cd "$ARTIFACTS/$NAME" && sha256sum bin/ffmpeg.exe bin/ffprobe.exe) > "$ARTIFACTS/$NAME/SHA256SUMS"
cp "$ROOT/SOURCES.txt" "$ARTIFACTS/$NAME/"
mkdir -p "$ROOT/corresponding-source"
cp "$SCRIPT" "$ROOT/SOURCES.txt" "$ROOT/libvpl-mingw-secure-crt.patch" "$ROOT/corresponding-source/"
cp "$REPORT" "$ROOT/corresponding-source/BUILD-REPORT.txt"
cp ffbuild/config.log config.h config_components.h "$ROOT/corresponding-source/"
cp -r "$ARCHIVES" "$ROOT/corresponding-source/"
tar -cJf "$ARTIFACTS/$NAME-source.tar.xz" -C "$ROOT" corresponding-source
(cd "$ARTIFACTS" && zip -qr "$NAME.zip" "$NAME")
(cd "$ARTIFACTS" && sha256sum "$NAME.zip" "$NAME-source.tar.xz") > "$ARTIFACTS/$NAME.sha256"
echo "Built and verified: $ARTIFACTS/$NAME.zip"
