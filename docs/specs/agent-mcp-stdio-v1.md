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

## Output channel

The server has no writable host bind. `/tmp` and `/output` are private 64 MiB
tmpfs mounts. Successful tools return artifacts in bounded MCP
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

Cancellation waits on an execution-settlement barrier created before the
executor is invoked. If an executor ignores abort beyond the bounded wait, the
API returns `cancellation_pending` while the action remains non-terminal and
`executing`; it never reports `cancelled` before publication cleanup settles.
