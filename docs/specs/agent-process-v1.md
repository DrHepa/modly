# Agent process v1 security contract

Modly runs an extension PROCESS node as an Agent capability only through the
governed Electron-main executor. The normal workflow PROCESS ABI is unchanged.
Missing or invalid Agent metadata removes only Agent eligibility; it does not
hide or disable the ordinary extension.

## Opt-in metadata

The node's `agent` declaration remains a
`modly.agent-capability-declaration.v1` object and must include:

```json
{
  "process": {
    "schema": "modly.agent-process.v1",
    "runtimeFiles": ["processor.mjs"],
    "resourceFiles": ["assets/prompt-template.json"],
    "artifacts": {
      "maxCount": 2,
      "maxTotalBytes": 10485760,
      "allowed": [
        { "kind": "plan", "mediaTypes": ["text/markdown"], "maxBytes": 65536 },
        { "kind": "glb", "mediaTypes": ["model/gltf-binary"], "maxBytes": 10420224 }
      ]
    }
  }
}
```

Governed PROCESS v1 is Linux-only. `runtimeFiles` must contain exactly the
manifest `entry`, which must be one self-contained ESM JavaScript bundle
(`.js`/`.mjs`) or Python zipapp (`.pyz`). Multiple loose code files, package
trees, relative imports, implicit dependencies, and ordinary `.py` scripts are
default-denied. JavaScript is loaded by a fixed host launcher from the inherited
entry FD, so it must not depend on its extension pathname.

Optional non-code data files are declared separately in `resourceFiles`.
Executable permissions and code/archive extensions are rejected for resources.
Each resource is consumed only through its exact inherited read-only FD; it is
never copied into an executable tree. Directories, globs, traversal, symlinks,
and undeclared files are rejected.

Discovery opens every declared file with `O_NOFOLLOW`, hashes through that
handle, records its file identity, and binds the categorized identities,
artifact policy, and entry to the public capability hash. Absolute host paths
are never exposed in the renderer inventory.

Before launch, main re-resolves the capability and local Ollama model lease,
opens the bound bundle/resources and input artifacts with `O_NOFOLLOW`, and
fstat/hash-validates those same read-only handles. The handles themselves are
inherited into the child and referenced as `/proc/self/fd/N`; runtime and input
bytes are never consumed from mutable copied workspace paths. Main revalidates
the same handles immediately before spawn and after process exit. Runtime
changes fail as `capability_stale`; input changes fail as `invalid_artifact`.

## Launch and trusted request

Only main constructs `trustedContext`. Renderer arguments containing
`trustedContext` or its reserved fields are rejected. The trusted request is a
single bounded JSON document on stdin:

```json
{
  "schema": "modly.agent-process-request.v1",
  "arguments": { "input": "chair", "params": {} },
  "trustedContext": {
    "actionId": "...",
    "originSessionId": "...",
    "model": { "provider": "ollama", "endpoint": "http://127.0.0.1:11434", "model": "...", "digest": "sha256:..." },
    "inputArtifacts": [{ "artifact": {}, "fdPath": "/proc/self/fd/5" }],
    "resources": [{ "path": "assets/prompt-template.json", "fdPath": "/proc/self/fd/4" }],
    "dirs": { "output": "..." },
    "capabilityHash": "...",
    "runtimeHash": "..."
  }
}
```

The child is started with direct argv, `shell: false`, a detached owned process
group, inherited read-only file descriptors, a minimal environment, and the
private output directory as cwd/HOME/TMP. JavaScript uses the packaged runtime
in Node mode with a fixed FD-consuming ESM launcher. Python zipapps use Modly's
host-managed Python, never an extension-controlled or system fallback. There is
no cloud, renderer `extensions.runProcess`, or legacy runner fallback.

The only pathname-based action staging is output/publication staging beneath a
private app-owned `0700` root outside the workspace. That root and the workspace
publication directory must be on the same filesystem so the complete verified
artifact set can be published by one atomic rename. Readiness fails closed when
this invariant is unavailable. Renderer filesystem IPC cannot list, move, or
delete this private root or arbitrary user-data paths; those operations are
limited to canonical configured storage roots or explicit directory-picker
grants and reject symlinks.

Startup, idle, total, line, message, log, request, and result limits are hard
bounds. Timeout, cancellation, and protocol failure terminate the owned group
with TERM followed by KILL after a grace period. Main tracks Linux `/proc` PID,
start-time, and PGID identity for every owned group member. TERM and then KILL
are sent to every still-owned member even when the group leader has already
exited; unrelated or PID-reused processes are never signalled. Non-Linux
readiness fails closed.

## NDJSON output and publication

Stdout is bounded NDJSON. Optional events are `{ "type": "progress",
"value": 0.5 }` and `{ "type": "log", "message": "..." }`. Exactly one
terminal result is required:

```json
{
  "schema": "modly.agent-process-result.v1",
  "type": "result",
  "artifacts": [
    {
      "path": "model.glb",
      "kind": "glb",
      "mediaType": "model/gltf-binary",
      "sizeBytes": 4,
      "sha256": "..."
    }
  ]
}
```

The result frame is absolutely terminal. Any later non-empty stdout frame or
data, including `progress`, `log`, or another `result`, and any later stderr
data fails the protocol and removes staged outputs.

Every descriptor must point inside the action output directory and match the
approved kind/media/size policy. Main rejects traversal and symlinks, opens
with `O_NOFOLLOW`, streams SHA-256, checks stable file identity and declared
size/digest, and copies only verified bytes into a publication directory. The
whole set is renamed atomically to `Workflows/agent-actions/<action-id>/` and
returned as `ArtifactRefV1` values.

Publication is transactional. Partial validation, child failure, post-publish
verification failure, or cancellation removes the entire action publication.
The existing Agent action settlement barrier waits for the idempotent rollback
before exposing a terminal cancelled or failed state.
