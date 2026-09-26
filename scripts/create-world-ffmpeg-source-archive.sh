#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 022

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
ARCHIVE_NAME='modly-world-ffmpeg-7.1.1-sources.tar.xz'

usage() {
  printf '%s\n' 'Usage: create-world-ffmpeg-source-archive.sh --source-cache <abs-dir> --work-root <abs-new-dir> --destination <abs-existing-dir> --gpg <abs-tool> --gpgv <abs-tool>' >&2
  exit 2
}

SOURCE_CACHE=''
WORK_ROOT=''
DESTINATION=''
GPG=''
GPGV=''
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --source-cache) SOURCE_CACHE="$2" ;;
    --work-root) WORK_ROOT="$2" ;;
    --destination) DESTINATION="$2" ;;
    --gpg) GPG="$2" ;;
    --gpgv) GPGV="$2" ;;
    *) usage ;;
  esac
  shift 2
done
for value in "$SOURCE_CACHE" "$WORK_ROOT" "$DESTINATION" "$GPG" "$GPGV"; do [[ "$value" == /* ]] || usage; done
[[ -d "$DESTINATION" && ! -L "$DESTINATION" ]] || { printf '%s\n' 'Destination must be an ordinary directory.' >&2; exit 1; }
NODE_BIN="$(command -v node)" || { printf '%s\n' 'node is required' >&2; exit 1; }
PREPARED="$WORK_ROOT/.world-ffmpeg-source-generation"
ROOT="$WORK_ROOT/modly-world-ffmpeg-7.1.1-sources"
FINAL_GENERATION="$DESTINATION/modly-world-ffmpeg-7.1.1-sources"

prepare_archive() {
  local tar_bin xz_bin sha256_bin partial
  tar_bin="$(command -v tar)" || { printf '%s\n' 'GNU tar is required' >&2; return 1; }
  xz_bin="$(command -v xz)" || { printf '%s\n' 'xz is required' >&2; return 1; }
  sha256_bin="$(command -v sha256sum)" || { printf '%s\n' 'sha256sum is required' >&2; return 1; }
  "$tar_bin" --version | head -1 | grep -q 'GNU tar' \
    || { printf '%s\n' 'GNU tar is required for deterministic archive metadata.' >&2; return 1; }
  [[ -d "$ROOT" && ! -L "$ROOT" && ! -e "$PREPARED" && ! -L "$PREPARED" ]] \
    || { printf '%s\n' 'Source archive preparation state is invalid.' >&2; return 1; }
  mkdir --mode=0755 -- "$PREPARED"
  partial="$PREPARED/$ARCHIVE_NAME"
  "$tar_bin" --sort=name --format=posix --mtime='@1740961320' --owner=0 --group=0 --numeric-owner \
    --pax-option=delete=atime,delete=ctime --directory "$WORK_ROOT" \
    --create --file - "$(basename -- "$ROOT")" | "$xz_bin" --threads=1 --check=crc64 --stdout > "$partial"
  "$sha256_bin" "$partial" | sed "s#  $partial\$#  $ARCHIVE_NAME#" > "$PREPARED/$ARCHIVE_NAME.sha256"
}

FINAL_VERIFIED=false
FINAL_PRESENT=false
if [[ -e "$FINAL_GENERATION" || -L "$FINAL_GENERATION" ]]; then
  FINAL_PRESENT=true
  if "$NODE_BIN" "$SCRIPT_DIR/world-ffmpeg-source-publication.mjs" --verify "$FINAL_GENERATION" >/dev/null 2>&1; then
    FINAL_VERIFIED=true
  fi
fi

"$NODE_BIN" "$SCRIPT_DIR/verify-world-ffmpeg-sources.mjs" \
  --cache "$SOURCE_CACHE" --mode acquisition --gpg "$GPG" --gpgv "$GPGV"

if [[ -e "$WORK_ROOT" ]]; then
  [[ -d "$WORK_ROOT" && ! -L "$WORK_ROOT" ]] || {
    printf '%s\n' 'Existing work root has no authoritative source-publication owner.' >&2
    exit 1
  }
  if [[ -e "$PREPARED" || -L "$PREPARED" ]]; then
    [[ -d "$PREPARED" && ! -L "$PREPARED" ]] || {
      printf '%s\n' 'Existing source-publication owner is invalid.' >&2
      exit 1
    }
  elif [[ "$FINAL_VERIFIED" == true && -d "$ROOT" && ! -L "$ROOT" ]]; then
    # A terminal generation can outlive best-effort cleanup of its prepared
    # owner. Recreate the deterministic candidate from the retained work root;
    # the publication authority compares its exact bytes before accepting it.
    prepare_archive
  else
    if [[ "$FINAL_PRESENT" == true ]]; then
      printf '%s\n' 'Existing final generation is invalid and has no authoritative source-publication owner.' >&2
    else
      printf '%s\n' 'Existing work root has no authoritative source-publication owner.' >&2
    fi
    exit 1
  fi
else
  # When a completed publication outlives the entire work root, rebuild the
  # deterministic candidate from the explicitly supplied, verified source
  # cache. The publisher accepts it only if its archive and checksum bytes
  # match the already-verified terminal generation exactly.
  mkdir -p -- "$ROOT/upstream" "$ROOT/scripts" "$ROOT/resources/ffmpeg" \
    "$ROOT/resources/licenses/world-ffmpeg-7.1.1"
  for name in ffmpeg-7.1.1.tar.xz libvpx-1.15.2.tar.gz opus-1.5.2.tar.gz zlib-1.3.2.tar.gz; do
    cp -- "$SOURCE_CACHE/$name" "$ROOT/upstream/$name"
  done
  "$NODE_BIN" "$SCRIPT_DIR/verify-world-ffmpeg-sources.mjs" \
    --cache "$SOURCE_CACHE" --mode acquisition --gpg "$GPG" --gpgv "$GPGV" \
    --receipt-output "$ROOT/upstream/ffmpeg-7.1.1-release-verification.v1.json"
  for name in build-world-ffmpeg-runtime.sh world-ffmpeg-linker-environment.sh stage-world-ffmpeg-runtime.mjs assemble-world-ffmpeg-runtime.mjs world-ffmpeg-runtime-assembler.mjs world-ffmpeg-binary-audit.mjs world-ffmpeg-parser-inspector.c world-ffmpeg-durability.mjs verify-world-ffmpeg-sources.mjs world-ffmpeg-supply-chain.mjs world-ffmpeg-release-material.mjs world-ffmpeg-build-trust.mjs world-ffmpeg-build-report.mjs write-world-ffmpeg-build-report.mjs; do
    cp -- "$SCRIPT_DIR/$name" "$ROOT/scripts/$name"
  done
  cp -- "$REPOSITORY_ROOT/resources/ffmpeg/supply-chain.v1.json" "$ROOT/resources/ffmpeg/supply-chain.v1.json"
  cp -- "$REPOSITORY_ROOT/THIRD_PARTY_NOTICES.md" "$ROOT/THIRD_PARTY_NOTICES.md"
  cp -- "$REPOSITORY_ROOT/resources/licenses/world-ffmpeg-7.1.1/"* "$ROOT/resources/licenses/world-ffmpeg-7.1.1/"
  : > "$ROOT/changes.diff"
  find "$ROOT" -type d -exec chmod 0755 {} +
  find "$ROOT" -type f -exec chmod 0644 {} +
  chmod 0755 "$ROOT/scripts/build-world-ffmpeg-runtime.sh"
  "$NODE_BIN" "$ROOT/scripts/verify-world-ffmpeg-sources.mjs" \
    --cache "$ROOT/upstream" --mode canonical
  prepare_archive
fi
"$NODE_BIN" "$SCRIPT_DIR/world-ffmpeg-source-publication.mjs" \
  --prepared "$PREPARED" --destination "$DESTINATION"
"$NODE_BIN" "$SCRIPT_DIR/world-ffmpeg-source-publication.mjs" \
  --verify "$DESTINATION/modly-world-ffmpeg-7.1.1-sources"
printf 'Created corresponding-source generation: %s\n' "$DESTINATION/modly-world-ffmpeg-7.1.1-sources"
