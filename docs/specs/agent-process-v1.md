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

An extension may opt a `.pyz` entry into its setup-managed virtual environment
with this exact declaration:

```json
{
  "runtime": {
    "kind": "extension-python-venv-v1",
    "interpreter": "bin/python"
  }
}
```

This declaration is valid only for `.pyz`. Its source root is fixed to
`<extension>/venv`. Bounded relative links that resolve within that tree are
allowed, including layouts such as `lib64 -> lib`; cycles, dangling links, and
escapes are rejected. The `bin/python` chain may terminate outside the tree only
at the exact regular executable selected by Electron main. Discovery binds that
base interpreter's identity and content digest, the source identity, and a
portable complete-tree digest into the runtime, execution, capability, and
action hashes. Source entries must use one cooperative current-UID/group model;
group-write bits are accepted in that model because every copy is bracketed by
identity/hash scans, while world-write, special files/bits, hard links, mixed
ownership/groups, and incomplete or over-bound trees are rejected. A missing
or changing venv or selected base removes Agent eligibility with an actionable
runtime error. A failed production sandbox readiness probe removes the
capability from the runnable inventory.

### Optional governed local-model access

A Python zipapp may request this exact profile:

```json
{
  "modelAccess": {
    "schema": "modly.agent-model-access.v1",
    "profile": "ollama-responses-json-v1"
  }
}
```

No other fields or profiles are accepted. `modelAccess` is valid only with
`extension-python-venv-v1`; JavaScript and otherwise unsandboxed PROCESS
entries cannot request it. The normalized declaration participates in
`runtimeHash`, and therefore in the execution binding, capability hash,
proposal hash, approval lease, and action state hash.

Model access has an independent production readiness probe. A missing, false,
or throwing probe excludes only that Agent capability and reports
`PROCESS_MODEL_ACCESS_UNAVAILABLE`. Main also fails immediately with
`model_binding_unavailable` if an approved action cannot acquire or revalidate
its action-scoped provider lease. There is no fallback to the selected raw
Ollama endpoint, shared host networking, a cloud provider, or an undeclared
model.

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

The `model` object above is the legacy trusted context for a PROCESS that did
not declare `modelAccess`. A declared model-access PROCESS never receives the
raw host endpoint or mutable model name. After main revalidates the capability,
proposal, and selected model, it acquires one private lease and instead passes:

```json
{
  "proposalHash": "...",
  "modelAccess": {
    "schema": "modly.agent-model-execution-lease.v1",
    "assurance": "pinned-local-cooperative-host",
    "transport": "unix-http",
    "socketPath": "/run/modly/model/gateway.sock",
    "responsesPath": "/v1/responses",
    "model": "approved",
    "digest": "sha256:...",
    "bearerToken": "...",
    "expiresAt": "...",
    "bindingHash": "..."
  }
}
```

The bearer and lease metadata exist only in the main-to-child request. They are
not exposed through renderer IPC, public action summaries, or session
persistence.

The child is started with direct argv, `shell: false`, a detached owned process
group, inherited read-only file descriptors, a minimal environment, and the
private output directory as cwd/HOME/TMP. JavaScript uses the packaged runtime
in Node mode with a fixed FD-consuming ESM launcher. Legacy Python zipapps may
use Modly's configured host Python. A zipapp declaring
`extension-python-venv-v1` is always launched as
`/runtime/bin/python /app/process.pyz`; launcher selection never falls back to
the API Python, another host Python, cloud execution, renderer
`extensions.runProcess`, or the legacy runner.

For the declared runtime, main materializes a content-addressed snapshot under
`<userData>/agent-process-runtime-snapshots`. The cache root is `0700`; files
and directories in a completed snapshot have every write bit removed. Creation
uses a random incomplete directory, reflink when supported and a copy from the
already-open source FD otherwise, complete destination verification, and an
atomic rename. The terminal external interpreter link is materialized from the
verified selected-base handle, so `/runtime/bin/python` resolves wholly within
the snapshot. Reuse verifies the entire tree. Active reference-counted leases
cover queued preparation, readiness, and execution; maintenance removes only
inactive bounded incomplete, corrupt, and stale cache entries.

The approved entry, resources, inputs, snapshot root, and private output root
remain FD-authorized. Bubblewrap mounts the snapshot read-only at `/runtime`,
binds the private output at `/output`, mounts resources and inputs read-only,
unshares the network and other namespaces, clears the environment, and executes
`/runtime/bin/python /app/process.pyz`. Main revalidates the source venv,
completed snapshot, trusted bubblewrap executable, bundle/resources, inputs,
and private output directory immediately before launch and again after a
successful child exit, before publication.

For a declared model-access action, main additionally inherits one already-open
private gateway-directory FD and bubblewrap mounts only that directory read-only
at `/run/modly/model` while retaining `--unshare-all`. The pathname AF_UNIX
gateway accepts exactly one authenticated `POST /v1/responses`. Request and
response bodies, idle time, and total time are bounded. V1 accepts only
non-streaming, stateless requests without tools, rewrites the child sentinel
model `approved` to the provider-private alias, and rejects replay. Cancellation,
timeout, process failure, success, and shutdown revoke the lease, abort upstream
work, destroy connections, and remove the socket directory.

The gateway directory is `0700`, the socket is `0600`, and the bearer is random.
Because the current Node runtime exposes no `SO_PEERCRED` API, this v1 guarantee
is explicitly `pinned-local-cooperative-host`: it isolates the renderer,
sandbox, and ordinary host network, but does not claim resistance to malicious
same-UID or root host processes. A production provider must prove the approved
digest-to-private-model binding before returning a lease; until such a provider
is configured, model-access capabilities remain default-denied.

The sandbox also exposes bounded read-only host OS ABI, standard-library, and
library trees needed by ordinary Python and native packages. Those mounts are
an explicit Electron-host trust base visible to approved extension code; they
are not an automatic interpreter fallback, and their contents are not claimed
to be bound by the extension runtime hash. The governed launcher remains the
bound `/runtime/bin/python` regardless of what other executables approved code
could invoke explicitly from those read-only host mounts.

The only pathname-based action staging is output/publication staging beneath a
private app-owned `0700` root outside the workspace. That root and the workspace
publication directory must be on the same filesystem so the complete verified
artifact set can be published by one atomic rename. Readiness fails closed when
this invariant is unavailable. Renderer filesystem IPC cannot list, grant,
move, or delete the private action root, the Python snapshot root, their
descendants, or a containing ancestor. Other operations remain limited to
canonical configured storage roots or explicit directory-picker grants and
reject symlinks.

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
terminal result or terminal error is required. A result is:

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

An extension may instead emit one bounded error:

```json
{
  "type": "error",
  "code": "model_binding_unavailable",
  "message": "The approved model binding is unavailable.",
  "details": { "retryable": true }
}
```

The code uses stable lowercase underscore syntax. Message and optional JSON
details have strict character, byte, depth, node, and collection bounds. The
error fails the action, consumes the single-use execution approval, and
publishes no artifacts. Both terminal frame kinds are absolute: any later
stdout byte or frame, including whitespace, `progress`, `log`, or another
terminal frame, and any later stderr data fails the protocol and removes staged
outputs.

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

The snapshot boundary assumes other processes running directly as the same OS
user do not maliciously rewrite Modly's private user-data directory. Such
same-UID host tampering is outside this contract; renderer and sandboxed child
access remain explicitly denied.
