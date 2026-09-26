---
name: modly-cli
description: Use when an agent needs to call a running Modly desktop instance from the terminal for canonical asset automation or private Worlds read-and-propose commands.
version: 1.3.0
author: Modly
license: MIT
metadata:
  hermes:
    tags: [modly, image-to-3d, worlds, cli, automation, agents]
    related_skills: []
---

# Modly CLI

## Overview

Modly exposes a local API at `http://127.0.0.1:8765` while the official desktop app is running. The stdlib-only CLI at `tools/modly-cli/agent.py` is an agent helper over the canonical automation contract:

- `health`
- `model`
- `workflow-run`
- `capability`
- `process-run`

Final machine-readable JSON is printed to stdout. Progress JSON lines, when requested, are printed to stderr.

## Worlds from an installed Modly app

The packaged CLI and this skill are copied to the stable resource-relative paths
`resourcesPath/modly-cli/agent.py` and `resourcesPath/modly-cli/SKILL.md`.
Here, `resourcesPath` means Electron's `process.resourcesPath` for the running
Modly installation, **not** a Worlds workspace path or a source checkout. Ask
the user for the installed app's resources directory if it is not already known;
do not search private app data, credentials, or the user's filesystem for it.
The mounted path of a Linux AppImage may change on restart, so resolve it for
the current running installation. Set `MODLY_RESOURCES_PATH` to that directory
in a trusted terminal, then invoke:

```bash
python3 "$MODLY_RESOURCES_PATH/modly-cli/agent.py" world pair
python3 "$MODLY_RESOURCES_PATH/modly-cli/agent.py" world project list
```

Worlds CLI is currently Linux-only. Start Modly, open a World project and its
scene in Edit mode, then run `world pair` in a trusted terminal. The CLI asks
Modly to show a native, cancel-default consent dialog, followed by a separate
native one-time-code dialog; there is no Worlds CLI panel. Enter the code only
at the interactive terminal prompt; never place it in command arguments, a
prompt, a file, or a transcript. The terminal and Modly must run as the same
OS user with the same private `XDG_RUNTIME_DIR`. Pairing uses a private Unix
socket and a five-minute active-scene scoped session with at most eight admitted
automatic edits; it does not use a ChatGPT Pro OAuth
token, an OpenAI API key, or the localhost asset API.

Use returned opaque project keys, scene IDs, revisions, plan IDs, and cursors.
Do not invent identifiers or pass absolute workspace paths to Worlds:

During this pairing-only stage, `world query` is limited to `entities` and
`components` in the currently open scene. Project-wide scene and resource
catalogues are intentionally unavailable even when their identifiers are known.

```bash
python3 "$MODLY_RESOURCES_PATH/modly-cli/agent.py" world project open <project_key>
python3 "$MODLY_RESOURCES_PATH/modly-cli/agent.py" world plan <project_key> --scene-id <scene_id>
python3 "$MODLY_RESOURCES_PATH/modly-cli/agent.py" world query <project_key> --revision <revision> --kind entities --scene-id <scene_id> --plan <plan_id>
python3 "$MODLY_RESOURCES_PATH/modly-cli/agent.py" world query <project_key> --revision <revision> --kind entities --scene-id <scene_id> --cursor <nextCursor> --plan <plan_id>
python3 "$MODLY_RESOURCES_PATH/modly-cli/agent.py" world propose <project_key> --plan <plan_id> --json - < recipe.json
```

The proposal input is a bounded, typed `{"commands":[...]}` recipe on stdin;
derive commands only from the current plan and query observations. During the
approved lease, a valid proposal may apply automatically and consumes one of
the eight admissions even if dispatch or editing later fails. A
`direct-edit-dispatched` receipt proves dispatch only, never completion: verify
the result with a fresh `world project open` or `world query`. Apply, Reject,
Undo, edit, and status commands are not available through the CLI.
Never try to bypass pairing, invoke
internal IPC, or write Worlds project documents directly. A stale plan or
revision must be queried again rather than retried with guessed data. This
packaged skill is guidance for Codex, not evidence that the user has installed
it into Codex or that an external Codex task has passed native E2E.

## Prerequisites

Launch the official Modly desktop app first, then check readiness:

```bash
python tools/modly-cli/agent.py health
```

Use `--compact` when another agent needs single-line JSON:

```bash
python tools/modly-cli/agent.py --compact health
```

`GET /health` is checked before business operations. If the app is unavailable, failures are structured:

```json
{
  "ok": false,
  "code": "API_UNAVAILABLE",
  "message": "Cannot reach Modly API at ..."
}
```

## Canonical Commands

Inspect models through `/model/*`:

```bash
python tools/modly-cli/agent.py model list
python tools/modly-cli/agent.py model status
python tools/modly-cli/agent.py model params --model active
```

Start or resume workflow runs:

```bash
python tools/modly-cli/agent.py workflow-run start --image ./input.png --wait
python tools/modly-cli/agent.py workflow-run status <run_id>
python tools/modly-cli/agent.py workflow-run cancel <run_id>
```

Generate from an image and export the finished mesh:

```bash
python tools/modly-cli/agent.py generate \
  --image ./input.png \
  --output ./export.glb \
  --progress
```

`generate` is a friendly wrapper around `POST /workflow-runs/from-image` and `GET /workflow-runs/{run_id}`. It does not silently fall back to `/generate/*`. The JSON includes recovery metadata:

```json
{
  "ok": true,
  "run": {"kind": "workflowRun", "id": "..."},
  "workspace_path": "Default/model.glb",
  "export_path": "/absolute/path/to/export.glb",
  "meta": {
    "status_command": "python tools/modly-cli/agent.py workflow-run status ...",
    "cancel_command": "python tools/modly-cli/agent.py workflow-run cancel ...",
    "legacy": false
  }
}
```

Use `--no-export` when the caller only needs the workspace path. The hidden `export` helper remains available to download an existing workspace mesh, but it is not part of the canonical root command set:

```bash
python tools/modly-cli/agent.py export --path Default/model.glb --output ./model.glb
```

Discover capabilities or process runs only when the running server exposes the canonical contract:

```bash
python tools/modly-cli/agent.py capability list
python tools/modly-cli/agent.py process-run status <run_id>
```

If the contract is absent, the CLI fails closed:

```json
{
  "ok": false,
  "code": "UNSUPPORTED_PROCESS",
  "message": "This process is not available through the canonical process-run contract."
}
```

## Model Selection

`--model auto` uses the active model reported by `/model/status`, then validates that id against `/model/all`. Explicit `--model` values are also validated against `/model/all`. The CLI does not infer hidden capabilities from model names, labels, or string fragments.

## Legacy Compatibility

The old `/generate/*` endpoints are explicit compatibility commands:

```bash
python tools/modly-cli/agent.py legacy job <job_id>
python tools/modly-cli/agent.py legacy cancel <job_id>
python tools/modly-cli/agent.py legacy generate --image ./input.png --output ./legacy.glb
```

Legacy responses include `meta.legacy: true`. Top-level `job`, `cancel`, `models`, and `params` aliases may still parse for older scripts, but they are not the documented canonical surface.

## Developer-Only API Helpers

Headless startup helpers live under `dev`:

```bash
python tools/modly-cli/agent.py dev serve-api --print-command
python tools/modly-cli/agent.py dev ensure-server
python tools/modly-cli/agent.py dev ensure-server --start --detach
```

These commands start or inspect only the FastAPI backend. They do not imply Electron/Desktop bridge readiness, scene operation readiness, extension process execution readiness, or full workflow support. Prefer launching the official desktop app for real agent workflows.

## Experimental ComfyUI Helpers

ComfyUI orchestration is outside the canonical Modly contract and lives under `experimental`:

```bash
python tools/modly-cli/agent.py experimental comfy-image \
  --workflow Trellis2Workflow \
  --prompt "clean object render, isolated on white" \
  --comfy-output ./source.png

python tools/modly-cli/agent.py experimental generate-from-workflow \
  --workflow Trellis2-Full \
  --prompt "clean orthographic product render of a stylized robot toy" \
  --output ./export.glb
```

`experimental generate-from-workflow --workflow <name> --output <path>` treats `--output` as the final artifact location. If the ComfyUI history contains a downloadable `.glb`, `.gltf`, `.obj`, `.stl`, or `.ply`, the CLI downloads that asset directly and does not call Modly health or generation. If the workflow only produces an image, the CLI downloads that image and falls back through the canonical Modly workflow-run generation path. If no supported asset or image is found, it fails with `code: "NO_WORKFLOW_OUTPUT"`.

## Hidden Helper Aliases

The top-level `status`, `export`, and `batch` helpers remain parseable for older scripts and agent ergonomics, but root help does not present them as canonical automation primitives. Prefer `health`, `model`, `workflow-run`, `capability`, and `process-run` when documenting the supported contract.

## Batch Workflow

The hidden `batch` helper generates meshes sequentially from a directory or manifest JSON through the canonical `generate` path:

```bash
python tools/modly-cli/agent.py batch \
  --input-dir ./images \
  --output-dir ./meshes \
  --continue-on-error

python tools/modly-cli/agent.py batch \
  --manifest ./jobs.json \
  --output-dir ./meshes
```

Manifest files may be a JSON list, or an object with `jobs` or `images`. Each entry can be a string image path or an object with `image`, optional `output`, and optional `format`.

## Verification Checklist

- [ ] `python tools/modly-cli/agent.py health` returns `ok: true`.
- [ ] `python tools/modly-cli/agent.py model list` returns model entries.
- [ ] `python tools/modly-cli/agent.py generate --image <image> --output <mesh>` returns `ok: true`, `run.kind: workflowRun`, and recovery metadata.
- [ ] The reported `export_path` exists and has non-zero size when export is enabled.
- [ ] `python tools/modly-cli/agent.py workflow-run status <run_id>` can resume polling from metadata.
- [ ] `python tools/modly-cli/test_agent.py` passes.
