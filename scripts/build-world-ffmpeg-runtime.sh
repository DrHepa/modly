#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 022

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

usage() {
  printf '%s\n' 'Usage: build-world-ffmpeg-runtime.sh --target <tuple> --source-cache <abs-dir> --source-mode <acquisition|canonical> --work-root <abs-new-dir> --output <abs-empty-dir> --inspector <abs-tool> --signing-key-id <id> --private-key <abs-file> --trusted-keys <abs-json> [--gpg <abs-tool> --gpgv <abs-tool>]' >&2
  exit 2
}

TARGET=''
SOURCE_CACHE=''
SOURCE_MODE=''
WORK_ROOT=''
OUTPUT=''
SIGNING_KEY_ID=''
PRIVATE_KEY=''
TRUSTED_KEYS=''
INSPECTOR=''
GPG=''
GPGV=''
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --target) TARGET="$2" ;;
    --source-cache) SOURCE_CACHE="$2" ;;
    --source-mode) SOURCE_MODE="$2" ;;
    --work-root) WORK_ROOT="$2" ;;
    --output) OUTPUT="$2" ;;
    --signing-key-id) SIGNING_KEY_ID="$2" ;;
    --private-key) PRIVATE_KEY="$2" ;;
    --trusted-keys) TRUSTED_KEYS="$2" ;;
    --inspector) INSPECTOR="$2" ;;
    --gpg) GPG="$2" ;;
    --gpgv) GPGV="$2" ;;
    *) usage ;;
  esac
  shift 2
done

for value in "$SOURCE_CACHE" "$WORK_ROOT" "$OUTPUT" "$INSPECTOR" "$PRIVATE_KEY" "$TRUSTED_KEYS"; do
  [[ "$value" == /* ]] || usage
done
[[ "$SIGNING_KEY_ID" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || usage
case "$SOURCE_MODE" in
  acquisition)
    for value in "$GPG" "$GPGV"; do [[ "$value" == /* ]] || usage; done
    ;;
  canonical)
    [[ -z "$GPG" && -z "$GPGV" ]] || usage
    ;;
  *) usage ;;
esac
case "$TARGET" in linux-arm64|linux-x64|darwin-arm64|win32-x64) ;; *) usage ;; esac

NODE_BIN="$(command -v node)" || { printf '%s\n' 'node is required' >&2; exit 1; }
MAKE_BIN="$(command -v make)" || { printf '%s\n' 'make is required' >&2; exit 1; }
TAR_BIN="$(command -v tar)" || { printf '%s\n' 'tar is required' >&2; exit 1; }
CC_BIN="$(command -v "${CC:-cc}")" || { printf '%s\n' 'a C compiler is required' >&2; exit 1; }
RANLIB_BIN="$(command -v "${RANLIB:-ranlib}")" || { printf '%s\n' 'ranlib is required' >&2; exit 1; }
STRIP_BIN="$(command -v "${STRIP:-strip}")" || { printf '%s\n' 'strip is required' >&2; exit 1; }
JOBS="${WORLD_FFMPEG_BUILD_JOBS:-1}"
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { printf '%s\n' 'WORLD_FFMPEG_BUILD_JOBS must be a positive integer' >&2; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Linux-aarch64) HOST_TARGET='linux-arm64'; VPX_TARGET='arm64-linux-gcc' ;;
  Linux-x86_64) HOST_TARGET='linux-x64'; VPX_TARGET='x86_64-linux-gcc' ;;
  Darwin-arm64) HOST_TARGET='darwin-arm64'; VPX_TARGET='arm64-darwin20-gcc' ;;
  MINGW*-x86_64|MSYS*-x86_64) HOST_TARGET='win32-x64'; VPX_TARGET='x86_64-win64-gcc' ;;
  *) printf '%s\n' 'Unsupported native build host.' >&2; exit 1 ;;
esac
[[ "$HOST_TARGET" == "$TARGET" ]] || { printf '%s\n' 'Cross-target builds are not accepted by this audited native script.' >&2; exit 1; }
if [[ "$TARGET" == 'darwin-arm64' ]]; then
  [[ -f /usr/bin/xcrun && -x /usr/bin/xcrun && ! -L /usr/bin/xcrun ]] \
    || { printf '%s\n' 'The exact Apple /usr/bin/xcrun authority is required.' >&2; exit 1; }
  AR_BIN="$(/usr/bin/xcrun --find ar)" \
    || { printf '%s\n' 'xcrun could not select the Apple ar tool.' >&2; exit 1; }
  [[ "$AR_BIN" == /* && -f "$AR_BIN" && -x "$AR_BIN" ]] \
    || { printf '%s\n' 'xcrun selected an invalid Apple ar tool.' >&2; exit 1; }
else
  AR_BIN="$(command -v "${AR:-ar}")" || { printf '%s\n' 'ar is required' >&2; exit 1; }
fi
[[ ! -e "$WORK_ROOT" ]] || { printf '%s\n' 'Work root must not already exist.' >&2; exit 1; }
[[ -d "$OUTPUT" && ! -L "$OUTPUT" ]] || { printf '%s\n' 'Output must be an existing ordinary directory.' >&2; exit 1; }
[[ -z "$(find "$OUTPUT" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { printf '%s\n' 'Output directory must be empty.' >&2; exit 1; }
mkdir -p -- "$WORK_ROOT/sources" "$WORK_ROOT/prefix"

if [[ "$SOURCE_MODE" == 'acquisition' ]]; then
  "$NODE_BIN" "$SCRIPT_DIR/verify-world-ffmpeg-sources.mjs" \
    --cache "$SOURCE_CACHE" --mode acquisition --gpg "$GPG" --gpgv "$GPGV"
else
  "$NODE_BIN" "$SCRIPT_DIR/verify-world-ffmpeg-sources.mjs" \
    --cache "$SOURCE_CACHE" --mode canonical
fi

for archive in ffmpeg-7.1.1.tar.xz libvpx-1.15.2.tar.gz opus-1.5.2.tar.gz zlib-1.3.2.tar.gz; do
  "$TAR_BIN" --extract --file "$SOURCE_CACHE/$archive" --directory "$WORK_ROOT/sources" --no-same-owner --no-same-permissions
done

export SOURCE_DATE_EPOCH=1740961320
export TZ=UTC
export LC_ALL=C
export LANG=C
export ZERO_AR_DATE=1
export CC="$CC_BIN"
export AR="$AR_BIN"
export RANLIB="$RANLIB_BIN"
export STRIP="$STRIP_BIN"
export ARFLAGS=crD
PREFIX="$WORK_ROOT/prefix"
COMMON_CFLAGS="-O2 -g0 -ffile-prefix-map=$WORK_ROOT=. -fdebug-prefix-map=$WORK_ROOT=."
# shellcheck source=world-ffmpeg-linker-environment.sh
source "$SCRIPT_DIR/world-ffmpeg-linker-environment.sh"
world_ffmpeg_set_linker_environment "$TARGET"
export CFLAGS="$COMMON_CFLAGS"
export CPPFLAGS="-I$PREFIX/include"
export LDFLAGS="-L$PREFIX/lib $COMMON_LDFLAGS"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"

(
  cd -- "$WORK_ROOT/sources/zlib-1.3.2"
  ./configure --prefix="$PREFIX" --shared
  "$MAKE_BIN" -j"$JOBS"
  "$MAKE_BIN" install
)
(
  cd -- "$WORK_ROOT/sources/opus-1.5.2"
  ./configure --prefix="$PREFIX" --disable-static --enable-shared --disable-doc --disable-extra-programs
  "$MAKE_BIN" -j"$JOBS"
  "$MAKE_BIN" install
)
(
  cd -- "$WORK_ROOT/sources/libvpx-1.15.2"
  ./configure --prefix="$PREFIX" --target="$VPX_TARGET" --disable-static --enable-shared \
    --disable-examples --disable-tools --disable-docs --disable-unit-tests --disable-vp8 --enable-vp9 \
    --disable-webm-io --disable-libyuv
  "$MAKE_BIN" -j"$JOBS"
  "$MAKE_BIN" install
)

mapfile -t FFMPEG_FLAGS < <(
  "$NODE_BIN" - "$REPOSITORY_ROOT/resources/ffmpeg/supply-chain.v1.json" <<'NODE'
const fs = require('fs')
const contract = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
for (const flag of contract.ffmpegConfigure) process.stdout.write(`${flag}\n`)
NODE
)
(
  cd -- "$WORK_ROOT/sources/ffmpeg-7.1.1"
  ./configure --prefix="$PREFIX" --bindir="$PREFIX/bin" --libdir="$PREFIX/lib" --shlibdir="$PREFIX/lib" \
    --extra-cflags="$CFLAGS $CPPFLAGS" --extra-ldflags="$LDFLAGS" "${FFMPEG_FLAGS[@]}"
  "$MAKE_BIN" -j"$JOBS"
  "$MAKE_BIN" install
)

# Revalidate the authoritative archives immediately before runtime staging and
# signing. A mutable or contaminated build environment is never a reproducible
# authority, but this closes accidental source-cache drift during a long build.
if [[ "$SOURCE_MODE" == 'acquisition' ]]; then
  "$NODE_BIN" "$SCRIPT_DIR/verify-world-ffmpeg-sources.mjs" \
    --cache "$SOURCE_CACHE" --mode acquisition --gpg "$GPG" --gpgv "$GPGV"
else
  "$NODE_BIN" "$SCRIPT_DIR/verify-world-ffmpeg-sources.mjs" \
    --cache "$SOURCE_CACHE" --mode canonical
fi

if [[ "$TARGET" == 'darwin-arm64' ]]; then
  INSTALL_NAME_TOOL="$(command -v install_name_tool)" || { printf '%s\n' 'install_name_tool is required' >&2; exit 1; }
  while IFS= read -r library; do
    name="$(basename -- "$library")"
    "$INSTALL_NAME_TOOL" -id "@rpath/$name" "$library"
  done < <(find "$PREFIX/lib" -maxdepth 1 -type f -name '*.dylib' -print | LC_ALL=C sort)
  while IFS= read -r binary; do
    while IFS= read -r dependency; do
      name="$(basename -- "$dependency")"
      if [[ -f "$PREFIX/lib/$name" ]]; then "$INSTALL_NAME_TOOL" -change "$dependency" "@rpath/$name" "$binary"; fi
    done < <("$INSPECTOR" -L "$binary" | tail -n +2 | sed -E 's/^[[:space:]]*([^[:space:]]+).*/\1/')
  done < <(find "$PREFIX/bin" "$PREFIX/lib" -maxdepth 1 -type f \( -name 'ffmpeg' -o -name '*.dylib' \) -print | LC_ALL=C sort)
fi

"$NODE_BIN" "$SCRIPT_DIR/stage-world-ffmpeg-runtime.mjs" \
  --prefix "$PREFIX" --output "$OUTPUT" --target "$TARGET" --inspector "$INSPECTOR"
BUNDLE_ROOT="$OUTPUT/ffmpeg/$TARGET"
PARSER_INSPECTOR="$WORK_ROOT/world-ffmpeg-parser-inspector"
PARSER_LINK_FLAGS=()
if [[ "$TARGET" == linux-* ]]; then PARSER_LINK_FLAGS+=(-ldl); fi
"$CC_BIN" -std=c11 -O2 -Wall -Wextra -Werror -I"$PREFIX/include" \
  "$SCRIPT_DIR/world-ffmpeg-parser-inspector.c" -o "$PARSER_INSPECTOR" "${PARSER_LINK_FLAGS[@]}"
"$NODE_BIN" "$SCRIPT_DIR/assemble-world-ffmpeg-runtime.mjs" \
  --bundle-root "$BUNDLE_ROOT" --target "$TARGET" --signing-key-id "$SIGNING_KEY_ID" \
  --private-key "$PRIVATE_KEY" --trusted-keys "$TRUSTED_KEYS" --inspector "$INSPECTOR" \
  --parser-inspector "$PARSER_INSPECTOR" \
  --parser-list "$WORK_ROOT/sources/ffmpeg-7.1.1/libavcodec/parser_list.c"

"$NODE_BIN" "$SCRIPT_DIR/write-world-ffmpeg-build-report.mjs" \
  --target "$TARGET" --output "$OUTPUT" --bundle-root "$BUNDLE_ROOT" \
  --supply-chain "$REPOSITORY_ROOT/resources/ffmpeg/supply-chain.v1.json" \
  --trust-file "$TRUSTED_KEYS" --signing-key-id "$SIGNING_KEY_ID" \
  --cc "$CC_BIN" --ar "$AR_BIN" --inspector "$INSPECTOR" --runtime-rpath "$RUNTIME_RPATH"

printf 'Built signed FFmpeg 7.1.1 runtime at %s\n' "$BUNDLE_ROOT"
