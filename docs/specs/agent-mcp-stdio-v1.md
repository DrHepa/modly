# Agent MCP stdio v1 security contract

Modly runs declared Agent MCP tools only through the governed main-process
broker. Version 1 is Linux-only and fails closed when the exact bubblewrap
sandbox probe is unavailable. There is no unsandboxed fallback.

## Runtime package

Each server declares `runtimeFiles`, an exact, extension-relative list of at
most 24 regular files. The declared entrypoint must be in that list. Every
listed file is opened without following symlinks, hashed and metadata-checked
through that same handle, and individually mounted read-only from its inherited
file descriptor. The extension directory itself is never mounted.

Servers therefore need a self-contained executable bundle or zipapp plus every
resource they use. Imports and resources omitted from `runtimeFiles` are not
available inside `/app`; directory entries, globs, and implicit dependency
trees are unsupported.

The read-only host paths `/usr`, `/bin`, `/lib`, and `/lib64` (when present)
are the explicit trusted computing base for the system loader and runtime.
They are host-managed dependencies, not extension-owned code and not part of
the extension approval hash.

### Named host runtimes

A server may request `hostRuntime: { id, executable }`; neither field may be
an absolute path. Electron main resolves the id from a closed registry,
canonicalizes and ownership-checks the configured root, rejects symlinks and
writable or current-user-owned ancestors/tree entries, and never special-cases
a numeric uid. Main records a bounded complete tree snapshot, hashes every
regular file, validates internal symlinks, and binds the full tree digest plus
the executable identity into the server, capability, proposal, and action
hashes. Tree metadata and executable bytes are revalidated before and after
execution. The exact root is mounted
read-only at `/runtime`, and the server receives only the deterministic
`MODLY_HOST_RUNTIME_EXECUTABLE=/runtime/<executable>` value. Missing or changed
runtimes are omitted with `MCP_RUNTIME_UNAVAILABLE`; there is no path fallback.

Typed `input_artifacts` name a required bounded string argument plus an
artifact kind/media allowlist. The model supplies only an inventoried artifact
id. Main resolves the authoritative `ArtifactRef` from the originating governed
session or a main-owned workspace resolver, binds it into the proposal, opens
and hashes the exact workspace bytes, and replaces the id only for execution
with `/input/<declaration-index>`. Inputs are inherited read-only FDs and are
revalidated before and after execution. Model/renderer paths and hashes are not
accepted.

## Output channel

For the default `artifact-v1` profile, the server has no writable host bind;
`/tmp` and `/output` are private 64 MiB tmpfs mounts. Successful tools return
artifacts in bounded MCP
`structuredContent` with exactly these fields:

- `id`
- `name` (one safe filename, not a path)
- `kind`
- `mediaType`
- `sha256`
- `dataBase64`

The raw MCP transport is capped before JSON parsing. The broker then validates
canonical base64, streams decoding and hashing, limits v1 to four artifacts,
256 KiB per artifact and 1 MiB aggregate, and atomically publishes verified
bytes under `Workflows/agent-actions/<action-id>/`. Path descriptors are not
accepted. Later verification failure or cancellation invokes the broker
transaction rollback before the action becomes terminal.

`relative-files-v1` is a separate opt-in profile and does not raise those
defaults. It permits at most 8 declared files, 32 MiB per file and 64 MiB
aggregate. Each tool declares exact required relative paths, kinds, media types
and one uniform hard per-file bound. The aggregate is derived exactly as the
declared slot count multiplied by that bound; heterogeneous file-size limits or
independent aggregate declarations are rejected before discovery. The broker mounts only a private main-owned staging child
on the final workspace filesystem, pre-creates the exact output files, and
writable-binds only those file descriptors at their declared `/output` paths.
The server runs under a hard `RLIMIT_FSIZE` equal to the profile per-file cap;
no writable host directory is mounted. The staging root is denied to renderer
filesystem IPC. The broker waits for server exit, rejects undeclared entries, symlinks,
hardlinks, special files, escapes and unstable identities, then hashes/copies
and atomically publishes the complete set. Any failure rolls back the set.

Capability metadata reports enforced maximums: initialization 10 s, tool-list
10 s, call 300 s, termination grace 250 ms, transport 4 MiB, message 2 MiB,
text content 64 KiB, plus the selected output profile. Inventory presence still
requires Linux and a successful activation probe for that output profile.
`artifact-v1` uses the bounded basic bubblewrap probe. `relative-files-v1`
additionally opens the trusted `prlimit`, creates and removes a real private
workspace-staging output slot, and proves that the production launch shape can
writable-bind that exact file descriptor. CPU and memory are not advertised
because this contract does not enforce them. Renderer inventory uses those
same production readiness profiles. When a required profile is unavailable,
only its MCP capabilities are omitted and the inventory returns
`MCP_SANDBOX_UNAVAILABLE`; test environments inject readiness rather than
treating a nested sandbox's namespace denial as evidence about the real host.

Cancellation waits on an execution-settlement barrier created before the
executor is invoked. If an executor ignores abort beyond the bounded wait, the
API returns `cancellation_pending` while the action remains non-terminal and
`executing`; it never reports `cancelled` before publication cleanup settles.
