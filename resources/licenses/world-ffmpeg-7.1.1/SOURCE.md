# Worlds FFmpeg corresponding source and replacement

The optional packaged Worlds fallback uses an exact FFmpeg 7.1.1 shared build
with libvpx 1.15.2, libopus 1.5.2, and zlib 1.3.2. It is enabled only when its
closed runtime tree and Ed25519 manifest verify against a public key compiled
into that particular Modly build. A vendor package does not trust an unsigned
or silently modified replacement.

For every Modly release that contains this runtime, the exact archive
`modly-world-ffmpeg-7.1.1-sources.tar.xz`, its checksum, `GENERATION.v1.json`,
and the final `READY.v1.json` commit marker MUST be attached to the same GitHub
release as the corresponding Modly binary. Publication consumers reject a
generation until the exact marker-bound four-file closure is complete:

https://github.com/lightningpixel/modly/releases

The archive contains the four unmodified, SHA-256-pinned upstream source
archives, a canonical receipt recording successful verification of the
official FFmpeg detached signature and exact signer fingerprint, this
repository's build and assembly scripts, the supply-chain contract, and an
empty `changes.diff` when the sources were not modified. The downloaded raw
signature and key bundle are acquisition-only inputs and are deliberately not
archived; this prevents mutable upstream key/signature bytes from changing the
corresponding-source archive after their verification result is recorded.

Each tuple build report is released beside its binary. It binds the
supply-chain contract, runtime manifest, runtime signature, and build public
trust by SHA-256 and records tool identities, normalized configure arguments,
and the exact tuple loader authority (`$ORIGIN`, `@loader_path`, or no runtime
rpath on Windows). It says
`unverified-until-two-independent-builds-match` unless that comparison has
actually been performed.

## Recipient rebuild and replacement path

A recipient does not need the vendor private key. From the matching Modly
source checkout, extract the corresponding-source archive and generate a new
recipient-owned Ed25519 build key:

```sh
mkdir -p /absolute/empty/trust /absolute/empty/output
node scripts/world-ffmpeg-build-trust.mjs \
  --output /absolute/empty/trust \
  --key-id recipient-rebuild
```

Build and sign the shared runtime with that recipient key. The build is
native-only and rejects a host/target mismatch. A corresponding-source archive
uses `--source-mode canonical`, so no network or GPG key acquisition is needed:

```sh
bash scripts/build-world-ffmpeg-runtime.sh \
  --target linux-x64 \
  --source-cache "$PWD/upstream" \
  --source-mode canonical \
  --work-root /absolute/new/work \
  --output /absolute/empty/output \
  --inspector "$(command -v readelf)" \
  --signing-key-id recipient-rebuild \
  --private-key /absolute/empty/trust/private-key.pem \
  --trusted-keys /absolute/empty/trust/trusted-keys.v1.json
```

Install the audited output into the matching Modly source tree, compile that
recipient public key into the Electron main process, and package only the same
tuple:

```sh
node --no-warnings --experimental-strip-types \
  scripts/install-world-ffmpeg-build.mjs \
  --target linux-x64 \
  --source-resources /absolute/empty/output \
  --repository-resources "$PWD/resources" \
  --trust-file /absolute/empty/trust/trusted-keys.v1.json

WORLD_FFMPEG_BUILD_TRUST_FILE=/absolute/empty/trust/trusted-keys.v1.json \
  npm run build
```

Electron-builder helper archives are obtained only in the explicit network
preparation phase and checked against
`resources/packaging/electron-builder-tool-cache.v1.json`. The network phase
manually validates a bounded HTTPS redirect chain from the exact GitHub release
URL to GitHub's release-asset host, bounds every response, and retains the
pinned archive SHA-256 as the final authority. The directory supplied as
`ELECTRON_BUILDER_CACHE` at the clean-package boundary is therefore an immutable
archive store, not the directory exposed to electron-builder. Every package
attempt verifies that exact closed store, copies only its pinned archives to a
new owner-bound mutable cache generation using different single-link inodes,
and gives electron-builder only that generation. This permits its normal helper
extraction without changing or adding entries beside the pinned archives.
Concurrent attempts receive different generations. After the builder process
has closed and emitted resources have been verified, bounded idempotent cleanup
removes the owned generation and its durable lease; a later invocation safely
recovers a dead owner's exact generation while leaving live and foreign entries
untouched. Cleanup failure is a packaging failure, and the immutable archive
store is verified again before the package operation can succeed.

Packaging is entered through an OS script, not an already-running Node wrapper.
Both scripts accept zero arguments and directly execute the repository-pinned
Electron 44.1.1 binary with `ELECTRON_RUN_AS_NODE=1`; neither resolves Node,
PowerShell, or Electron through ambient `PATH`. The current tuple is derived
from that runtime and unsupported tuples fail before package inputs are used.
The POSIX script uses `/usr/bin/env -i` for the first process. The Windows
script clears Node, loader, and executable-lookup variables before the first
process; that first entry validates the case-insensitive `SystemRoot`/`WINDIR`
authority and then constructs a closed child environment with the exact derived
`PATH`, `COMSPEC`, and `PATHEXT`. It also rejects duplicate case-folded names.
The second pinned-Electron process requires empty `process.execArgv` and the
exact closed environment, so ambient preloads, shell startup variables, loader
variables, and package-tool overrides are not forwarded. It verifies the exact
cache before electron-builder starts and denies Node network APIs.

A dedicated child runner calls the pinned
electron-builder programmatic API with an internal target map and the fixed
`scripts/world-ffmpeg-electron-builder-config.json` snapshot. It never evaluates
the CLI wrapper that loads `electron-builder.env`, requires only the fixed
deny-network preload in `process.execArgv`, and rejects any environment outside
the closed package authority. Both package hooks run their verifier child under
the same exact deny-network Node authority. The outer wrapper independently
verifies the emitted application resources after electron-builder exits before
returning success:

```sh
mkdir -p /absolute/empty/electron-builder-cache
npm run prepare:package-tool-cache -- \
  --target linux-x64 \
  --cache /absolute/empty/electron-builder-cache

WORLD_FFMPEG_BUILD_TRUST_FILE=/absolute/empty/trust/trusted-keys.v1.json \
ELECTRON_BUILDER_CACHE=/absolute/empty/electron-builder-cache \
  ./scripts/world-ffmpeg-clean-package
```

Use `scripts\world-ffmpeg-clean-package.cmd` on Windows and the same zero-argument
POSIX command on macOS. `npm run package` builds and then invokes
`package:from-build`, while `npm run package:from-build` is a convenience alias
to the current-platform wrapper. CI and release packaging invoke the OS wrapper
directly; therefore the audited packaging boundary does not depend on an
already-running ambient Node process. A supported tuple with absent audited
inputs fails closed as `bundle-missing`; a host tuple outside linux-x64,
darwin-arm64, and win32-x64 fails as `unsupported-target`.

Source origins and integrity values are in
`resources/ffmpeg/supply-chain.v1.json`. The acquisition workflow additionally
verifies the official release-signing fingerprint
`FCF986EA15E6E293A5644F10B4322F04D67658D8` before producing the canonical
receipt.

This file describes the provided mechanism and is not a legal opinion or a
claim that independently reproducible binaries have already been demonstrated.
Release and package workflows fail closed when their exact runtime, trust,
build report, source generation, or package-tool cache is absent or invalid.
