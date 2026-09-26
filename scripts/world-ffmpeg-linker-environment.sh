# This file is sourced by build-world-ffmpeg-runtime.sh. Keep the Linux
# loader token in the environment so configure, make, and the recipe shell do
# not each reinterpret a dollar sign. GNU ld consumes LD_RUN_PATH directly.
world_ffmpeg_set_linker_environment() {
  unset LD_RUN_PATH
  case "$1" in
    linux-arm64|linux-x64)
      RUNTIME_RPATH='$ORIGIN'
      COMMON_LDFLAGS=''
      export LD_RUN_PATH="$RUNTIME_RPATH"
      ;;
    darwin-arm64)
      RUNTIME_RPATH='@loader_path'
      COMMON_LDFLAGS="-Wl,-rpath,$RUNTIME_RPATH"
      ;;
    win32-x64)
      RUNTIME_RPATH=''
      COMMON_LDFLAGS=''
      ;;
    *)
      printf '%s\n' 'Unsupported World FFmpeg linker target.' >&2
      return 1
      ;;
  esac
  export RUNTIME_RPATH COMMON_LDFLAGS
}
