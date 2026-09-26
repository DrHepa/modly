# Third-Party Notices

## Mediabunny 1.55.4

Modly uses Mediabunny 1.55.4 for WebM VP9/Opus assembly in the isolated Worlds render Worker.

- Copyright: Mediabunny contributors
- License: Mozilla Public License 2.0 (MPL-2.0)
- Source: https://github.com/Vanilagy/mediabunny/tree/v1.55.4
- Project: https://mediabunny.dev/

The complete license text and source provenance are packaged under
`licenses/mediabunny-1.55.4/`.

## Optional Worlds FFmpeg runtime

When an audited native bundle is present, Modly uses FFmpeg 7.1.1 built as an
LGPL-2.1-or-later shared runtime. The build contract disables GPL, nonfree, and
version-3 components and enables only the Worlds pipe/fd VP9/Opus surface.

- FFmpeg 7.1.1 — LGPL-2.1-or-later — https://ffmpeg.org/
- libvpx 1.15.2 — BSD-3-Clause with the WebM patent grant — https://chromium.googlesource.com/webm/libvpx/
- libopus 1.5.2 — BSD-3-Clause with referenced royalty-free patent grants — https://opus-codec.org/
- zlib 1.3.2 — Zlib license — https://zlib.net/

The license texts, exact source hashes, build configuration, and corresponding-
source release contract are packaged under `licenses/world-ffmpeg-7.1.1/`.
No FFmpeg runtime is accepted from PATH or downloaded while Modly runs.
