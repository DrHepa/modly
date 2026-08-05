"""
Agent chat endpoint — runs an Ollama-powered tool-use loop against Modly's API.
"""
import json
import logging
import re
import time
import uuid
from typing import NoReturn

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/agent", tags=["agent"])

MODLY_API = "http://localhost:8765"
AUTOMATION_BRIDGE = "http://127.0.0.1:8766"

# Each timeout is an individual network-operation timeout. In particular, read
# is an inter-chunk inactivity limit; it is not a total response deadline.
OLLAMA_TIMEOUT = httpx.Timeout(connect=10.0, write=30.0, pool=10.0, read=300.0)

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are Modly's built-in AI assistant, specialized in 3D modeling and workflow automation.
You help users generate 3D models from images, optimize meshes, and manage workflows directly inside the Modly application.

## Available tools

- **list_models** — List 3D generation models downloaded locally, including loaded/active state when known.
- **list_processes** — Discover Modly process extensions exposed by the Electron automation bridge. These are Modly processes, not operating-system processes.
- **unload_models** — Unload all 3D generation models from GPU VRAM to free memory.
- **get_mesh_info** — Get info about the current mesh in the 3D viewer (path, triangle count).
- **decimate_mesh(path, target_faces)** — Reduce the polygon count of a mesh.
- **smooth_mesh(path, iterations)** — Apply Laplacian smoothing to a mesh.
- **get_generation_status(job_id)** — Poll the status of an ongoing 3D generation job.
- **list_workflows** — List all available workflows in Modly.
- **run_workflow(workflow_id)** — Execute a workflow in Modly by its ID. If the user attached an image in their message, it will automatically be used as the workflow's input image.
- **create_workflow(name, input_type, steps, description?)** — Create a new workflow from an ordered list of processing steps. Each step references an extension by its exact `id` and may override its params. The steps run in sequence, the output of one feeding the next. The input source is one of exactly three nodes — `image` (Image), `text` (Text), or `mesh` (Load 3D Mesh) — and an Add-to-Scene output node is appended automatically.

## Rules

- Always use tools to act on the scene — never just describe what you would do.
- For inventory questions about available Modly capabilities, call both list_models and list_processes.
- Only the tools exposed in this prompt are capabilities you can use. Never claim an unexposed capability.
- A downloaded model or discovered process is not necessarily runtime-ready. Treat unknown readiness as unknown and say so.
- If you need the current mesh path, call get_mesh_info first.
- If you need to run a workflow but don't know the ID, call list_workflows first.
- To create a workflow, ONLY use extension ids listed under "Available extensions" in the context. Never invent an id. Chain steps so each step's input type matches the previous step's output type.
- For a workflow's input, `input_type` MUST be exactly one of: `image`, `text`, or `mesh`. These map to the Image, Text, and Load 3D Mesh nodes. Never invent another input. Pick the one matching the first step's expected input.
- After each tool call, give a short one-sentence summary of what was done.
- Always reply in the same language the user is writing in.
- Be concise. No unnecessary explanations.\
"""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_models",
            "description": "List 3D generation models downloaded locally. Downloaded does not imply runtime-ready.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_processes",
            "description": (
                "Discover Modly process extensions through the Electron automation bridge. "
                "These are Modly processes, not operating-system processes; discovery does not prove runtime readiness."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "unload_models",
            "description": "Unload all 3D generation models from VRAM to free GPU memory.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_mesh_info",
            "description": "Get information about the current mesh loaded in the 3D viewer (triangle count, path, etc.).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "decimate_mesh",
            "description": "Reduce the polygon count of the current mesh using quadric edge collapse.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path to the mesh file (e.g. 'Default/mesh.glb'). Use get_mesh_info to obtain it.",
                    },
                    "target_faces": {
                        "type": "integer",
                        "description": "Target number of faces after decimation.",
                    },
                },
                "required": ["path", "target_faces"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "smooth_mesh",
            "description": "Apply Laplacian smoothing to the current mesh.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path to the mesh file. Use get_mesh_info to obtain it.",
                    },
                    "iterations": {
                        "type": "integer",
                        "description": "Number of smoothing iterations (1–20). More = smoother but loses detail.",
                    },
                },
                "required": ["path", "iterations"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_generation_status",
            "description": "Poll the status of an ongoing 3D generation job.",
            "parameters": {
                "type": "object",
                "properties": {
                    "job_id": {"type": "string", "description": "Job ID returned by a previous generation call."},
                },
                "required": ["job_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_workflows",
            "description": "List all workflows available in Modly.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_workflow",
            "description": "Execute a Modly workflow by its ID. The workflow runs in the background; progress is shown in the app.",
            "parameters": {
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "The workflow ID to execute. Use list_workflows to get available IDs."},
                },
                "required": ["workflow_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_workflow",
            "description": (
                "Create a new Modly workflow from an ordered list of steps. "
                "Each step references an extension by its exact id (see 'Available extensions' in context). "
                "Steps run in sequence; do not include the input itself as a step."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Short human-readable name for the workflow."},
                    "description": {"type": "string", "description": "Optional one-line description of what the workflow does."},
                    "input_type": {
                        "type": "string",
                        "enum": ["image", "text", "mesh"],
                        "description": (
                            "The workflow's input source node. Exactly one of: "
                            "'image' (Image node), 'text' (Text node), "
                            "'mesh' (Load 3D Mesh node, uses the current scene mesh). "
                            "Never use any other value."
                        ),
                    },
                    "steps": {
                        "type": "array",
                        "description": "Ordered processing steps. Each runs after the previous one.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "extension_id": {
                                    "type": "string",
                                    "description": "Exact extension id from 'Available extensions' (e.g. 'mesh-optimizer/optimize').",
                                },
                                "params": {
                                    "type": "object",
                                    "description": "Optional param overrides, keyed by param id. Omit to use defaults.",
                                },
                            },
                            "required": ["extension_id"],
                        },
                    },
                },
                "required": ["name", "input_type", "steps"],
            },
        },
    },
]


# Input kinds the agent may pick, mapped to the real Modly source-node types.
# Keep this in sync with the node palette in WorkflowsPage.tsx.
INPUT_NODES = {
    "image": {"type": "imageNode", "data": {"enabled": True, "params": {}, "showInGenerate": True}},
    "text":  {"type": "textNode",  "data": {"enabled": True, "params": {}}},
    "mesh":  {"type": "meshNode",  "data": {"enabled": True, "params": {"source": "current"}}},
}


def _build_workflow_graph(name: str, description: str, input_type: str, steps: list[dict]) -> dict:
    """Assemble a Modly workflow graph (nodes + edges) from a simplified step spec.

    Layout: one source node (Image / Text / Load 3D Mesh), one extensionNode per
    step, then an Add-to-Scene output node, all wired in a single linear chain with
    workflowEdge edges. id/timestamps are left for the frontend to stamp
    (crypto.randomUUID + ISO date), matching how the Workflows tab creates workflows.
    """
    spec = INPUT_NODES.get(input_type, INPUT_NODES["image"])
    input_node = {
        "id": uuid.uuid4().hex[:8],
        "type": spec["type"],
        "position": {"x": 250, "y": 50},
        "data": {**spec["data"]},
    }

    ext_nodes = []
    for i, step in enumerate(steps):
        ext_nodes.append({
            "id": uuid.uuid4().hex[:8],
            "type": "extensionNode",
            "position": {"x": 250, "y": 150 + i * 200},
            "data": {
                "extensionId": step["extension_id"],
                "enabled": True,
                "params": step.get("params") or {},
            },
        })

    output_node = {
        "id": uuid.uuid4().hex[:8],
        "type": "outputNode",
        "position": {"x": 250, "y": 150 + len(steps) * 200},
        "data": {"enabled": True, "params": {}},
    }

    all_nodes = [input_node, *ext_nodes, output_node]
    edges = [
        {
            "id": f"e-{all_nodes[i]['id']}-{all_nodes[i + 1]['id']}",
            "source": all_nodes[i]["id"],
            "target": all_nodes[i + 1]["id"],
            "type": "workflowEdge",
        }
        for i in range(len(all_nodes) - 1)
    ]

    return {"name": name, "description": description, "nodes": all_nodes, "edges": edges}


def _compact_json(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _sanitize_discovery_message(value: object) -> str:
    """Keep discovery summaries useful without leaking endpoints or local paths."""
    if not isinstance(value, str) or not value.strip():
        return "Capability discovery reported an unspecified error."

    message = " ".join(value.split())
    message = re.sub(r"https?://\S+", "[endpoint]", message)
    message = re.sub(r"(['\"])(?:[A-Za-z]:[\\/]|/).*?\1", r"\1[path]\1", message)
    message = re.sub(r"(?:[A-Za-z]:[\\/]|/)\S+", "[path]", message)
    if len(message) > 180:
        message = message[:177].rstrip() + "..."
    return message


def _discovery_error(
    code: str,
    message: str,
    *,
    retryable: bool,
    source: str | None = None,
) -> dict:
    result = {"code": code, "message": message, "retryable": retryable}
    if source:
        result["source"] = source
    return result


def _normalize_model_inventory(value: object) -> dict:
    if not isinstance(value, list):
        return {
            "complete": False,
            "models": [],
            "errors": [
                _discovery_error(
                    "invalid_model_inventory",
                    "Modly returned an invalid model inventory.",
                    retryable=True,
                )
            ],
        }

    models: list[dict] = []
    errors: list[dict] = []
    for item in value:
        if not isinstance(item, dict):
            errors.append(
                _discovery_error(
                    "invalid_model_entry",
                    "Modly returned an invalid model inventory entry.",
                    retryable=True,
                )
            )
            continue

        model_id = item.get("id")
        name = item.get("name")
        downloaded = item.get("downloaded")
        invalid_core = (
            not isinstance(model_id, str)
            or not model_id.strip()
            or not isinstance(name, str)
            or not name.strip()
            or not isinstance(downloaded, bool)
        )
        invalid_state = any(
            state in item and not isinstance(item[state], bool)
            for state in ("loaded", "active")
        )
        if invalid_core or invalid_state:
            errors.append(
                _discovery_error(
                    "invalid_model_entry",
                    "A model inventory entry has invalid ID, name, downloaded, loaded, or active fields.",
                    retryable=True,
                )
            )
        if invalid_core or downloaded is not True:
            continue

        model = {
            "id": model_id,
            "name": name,
            "downloaded": True,
        }
        for state in ("loaded", "active"):
            if isinstance(item.get(state), bool):
                model[state] = item[state]
        models.append(model)

    result: dict = {"complete": not errors, "models": models}
    if errors:
        result["errors"] = errors
    return result


def _normalize_process_ports(value: object) -> tuple[list[dict] | None, list[dict]]:
    if not isinstance(value, list):
        return None, [
            _discovery_error(
                "invalid_process_ports",
                "A discovered process has an invalid inputs list.",
                retryable=True,
            )
        ]

    ports: list[dict] = []
    errors: list[dict] = []
    for port in value:
        if not isinstance(port, dict):
            errors.append(
                _discovery_error(
                    "invalid_process_port",
                    "A discovered process has an invalid input-port entry.",
                    retryable=True,
                )
            )
            continue
        name = port.get("name")
        port_type = port.get("type")
        invalid = (
            not isinstance(name, str)
            or not name.strip()
            or not isinstance(port_type, str)
            or not port_type.strip()
            or ("label" in port and not isinstance(port["label"], str))
            or any(field in port and not isinstance(port[field], bool) for field in ("required", "multiple", "ordered"))
            or any(
                field in port
                and (
                    not isinstance(port[field], int)
                    or isinstance(port[field], bool)
                    or port[field] < 0
                )
                for field in ("min_items", "max_items")
            )
            or (
                isinstance(port.get("min_items"), int)
                and not isinstance(port.get("min_items"), bool)
                and isinstance(port.get("max_items"), int)
                and not isinstance(port.get("max_items"), bool)
                and port["max_items"] < port["min_items"]
            )
        )
        if invalid:
            errors.append(
                _discovery_error(
                    "invalid_process_port",
                    "A discovered process input port has invalid name, type, required, or cardinality fields.",
                    retryable=True,
                )
            )
            continue
        normalized = {"name": name, "type": port_type}
        for field in ("label",):
            if isinstance(port.get(field), str):
                normalized[field] = port[field]
        for field in ("required", "multiple", "ordered"):
            if isinstance(port.get(field), bool):
                normalized[field] = port[field]
        for field in ("min_items", "max_items"):
            if isinstance(port.get(field), int) and not isinstance(port.get(field), bool):
                normalized[field] = port[field]
        ports.append(normalized)
    return ports, errors


def _normalize_automation_metadata(value: object) -> tuple[dict | None, bool]:
    if not isinstance(value, dict):
        return None, False

    automation: dict = {}
    valid = True
    if "boundary" in value and value.get("boundary") not in {"electron", "ui_only"}:
        valid = False
    elif value.get("boundary") in {"electron", "ui_only"}:
        automation["boundary"] = value["boundary"]
    if "headless" in value and not isinstance(value.get("headless"), bool):
        valid = False
    elif isinstance(value.get("headless"), bool):
        automation["headless"] = value["headless"]
    return automation or None, valid


def _is_canonical_process_id(process_id: object, extension_id: object, node_id: object) -> bool:
    segments = (extension_id, node_id)
    return (
        isinstance(process_id, str)
        and all(
            isinstance(segment, str)
            and bool(segment)
            and segment == segment.strip()
            and "/" not in segment
            for segment in segments
        )
        and process_id == f"{extension_id}/{node_id}"
    )


def _normalize_process_inventory(value: object) -> dict:
    if not isinstance(value, dict) or not isinstance(value.get("processes"), list):
        return {
            "complete": False,
            "processes": [],
            "errors": [
                _discovery_error(
                    "invalid_process_inventory",
                    "The Modly automation bridge returned an invalid process inventory.",
                    retryable=True,
                )
            ],
        }

    errors: list[dict] = []
    raw_errors = value.get("errors")
    if raw_errors is not None and not isinstance(raw_errors, list):
        errors.append(
            _discovery_error(
                "invalid_discovery_errors",
                "The Modly automation bridge returned invalid discovery errors.",
                retryable=True,
            )
        )
    elif isinstance(raw_errors, list):
        for error in raw_errors:
            if not isinstance(error, dict):
                errors.append(
                    _discovery_error(
                        "invalid_discovery_error",
                        "The Modly automation bridge returned an invalid discovery error.",
                        retryable=True,
                    )
                )
                continue
            if error.get("source") == "backend-runtime":
                continue
            code = error.get("code")
            errors.append(
                _discovery_error(
                    code if isinstance(code, str) and code else "process_discovery_error",
                    _sanitize_discovery_message(error.get("message")),
                    retryable=error.get("retryable") is True,
                    source=error.get("source") if isinstance(error.get("source"), str) else None,
                )
            )

    processes: list[dict] = []
    for item in value["processes"]:
        if not isinstance(item, dict):
            errors.append(
                _discovery_error(
                    "invalid_process_entry",
                    "Modly returned an invalid process inventory entry.",
                    retryable=True,
                )
            )
            continue

        process_id = item.get("id")
        extension_id = item.get("extension_id")
        node_id = item.get("node_id")
        name = item.get("name")
        extension_name = item.get("extension_name")
        invalid_core = (
            not _is_canonical_process_id(process_id, extension_id, node_id)
            or not isinstance(name, str)
            or not name.strip()
            or not isinstance(extension_name, str)
            or not extension_name.strip()
            or not isinstance(item.get("builtin"), bool)
            or not isinstance(item.get("trusted"), bool)
            or ("ready" in item and item["ready"] is not None and not isinstance(item["ready"], bool))
            or any(field in item and (not isinstance(item[field], str) or not item[field].strip()) for field in ("input", "output"))
        )
        if invalid_core:
            errors.append(
                _discovery_error(
                    "invalid_process_entry",
                    "A discovered process has invalid canonical ID, name, trust, readiness, or port-kind fields.",
                    retryable=True,
                )
            )
            continue

        process = {
            "id": process_id,
            "name": name,
            "extension_id": extension_id,
            "node_id": node_id,
            "ready": item["ready"] if isinstance(item.get("ready"), bool) else "unknown",
            "extension_name": extension_name,
            "builtin": item["builtin"],
            "trusted": item["trusted"],
        }
        for field in ("input", "output"):
            if isinstance(item.get(field), str):
                process[field] = item[field]
        if "inputs" in item:
            ports, port_errors = _normalize_process_ports(item["inputs"])
            errors.extend(port_errors)
            if ports is not None:
                process["inputs"] = ports
        if "automation" in item:
            automation, automation_valid = _normalize_automation_metadata(item["automation"])
            if not automation_valid:
                errors.append(
                    _discovery_error(
                        "invalid_process_automation",
                        "A discovered process has invalid automation-boundary metadata.",
                        retryable=True,
                    )
                )
            if automation:
                process["automation"] = automation
        processes.append(process)

    result: dict = {"complete": not errors, "processes": processes}
    if errors:
        result["errors"] = errors
    return result


async def execute_tool(name: str, arguments: dict, context: dict) -> tuple[str, dict | None]:
    """Execute a tool and return (result_text, action_payload).
    action_payload carries data the frontend needs to react (e.g. new mesh URL).
    """
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            if name == "list_models":
                try:
                    r = await client.get(f"{MODLY_API}/model/all")
                    r.raise_for_status()
                    inventory = _normalize_model_inventory(r.json())
                except (httpx.HTTPError, ValueError):
                    inventory = {
                        "complete": False,
                        "models": [],
                        "errors": [
                            _discovery_error(
                                "model_discovery_unavailable",
                                "Modly model discovery is unavailable.",
                                retryable=True,
                            )
                        ],
                    }
                return _compact_json(inventory), None

            elif name == "list_processes":
                try:
                    r = await client.get(f"{AUTOMATION_BRIDGE}/automation/capabilities")
                    r.raise_for_status()
                    inventory = _normalize_process_inventory(r.json())
                except (httpx.HTTPError, ValueError):
                    inventory = {
                        "complete": False,
                        "processes": [],
                        "errors": [
                            _discovery_error(
                                "process_discovery_unavailable",
                                "Modly process discovery is unavailable through the Electron automation bridge.",
                                retryable=True,
                            )
                        ],
                    }
                return _compact_json(inventory), None

            elif name == "unload_models":
                await client.post(f"{MODLY_API}/model/unload-all")
                return "All 3D generation models have been unloaded from VRAM.", None

            elif name == "get_mesh_info":
                mesh_path = context.get("currentMeshPath")
                mesh_triangles = context.get("meshTriangles")
                if not mesh_path:
                    return "No mesh currently loaded in the viewer.", None
                info = f"Current mesh: {mesh_path}"
                if mesh_triangles:
                    info += f" ({mesh_triangles:,} triangles)"
                return info, None

            elif name == "decimate_mesh":
                r = await client.post(
                    f"{MODLY_API}/optimize/mesh",
                    json={"path": arguments["path"], "target_faces": arguments["target_faces"]},
                )
                r.raise_for_status()
                data = r.json()
                payload = {"type": "mesh_update", "url": data["url"], "face_count": data.get("face_count")}
                return f"Decimated to {data.get('face_count', '?')} faces.", payload

            elif name == "smooth_mesh":
                r = await client.post(
                    f"{MODLY_API}/optimize/smooth",
                    json={"path": arguments["path"], "iterations": arguments["iterations"]},
                )
                r.raise_for_status()
                data = r.json()
                payload = {"type": "mesh_update", "url": data["url"]}
                return f"Smoothed mesh ({arguments['iterations']} iterations).", payload

            elif name == "get_generation_status":
                r = await client.get(f"{MODLY_API}/generate/status/{arguments['job_id']}")
                r.raise_for_status()
                s = r.json()
                text = f"Status: {s['status']}, Progress: {s.get('progress', 0)}%"
                if s.get("step"):
                    text += f", Step: {s['step']}"
                if s.get("output_url"):
                    text += f", Output: {s['output_url']}"
                return text, None

            elif name == "list_workflows":
                workflows = context.get("workflows", [])
                if not workflows:
                    return "No workflows found. Create one in the Workflows tab.", None
                lines = "\n".join(f"- {w['id']}: {w['name']}" for w in workflows)
                return f"Available workflows:\n{lines}", None

            elif name == "run_workflow":
                workflow_id = arguments["workflow_id"]
                workflows = context.get("workflows", [])
                match = next((w for w in workflows if w["id"] == workflow_id), None)
                if not match:
                    return f"Workflow '{workflow_id}' not found. Use list_workflows to see available workflows.", None
                payload = {"type": "run_workflow", "workflow_id": workflow_id, "workflow_name": match["name"]}
                return f"Executing workflow '{match['name']}'…", payload

            elif name == "create_workflow":
                steps = arguments.get("steps") or []
                if not steps:
                    return "A workflow needs at least one step. Specify the extensions to chain.", None

                input_type = arguments.get("input_type") or "image"
                if input_type not in INPUT_NODES:
                    return (
                        f"Invalid input_type '{input_type}'. Use exactly one of: "
                        f"image (Image node), text (Text node), mesh (Load 3D Mesh node).",
                        None,
                    )

                extensions = context.get("extensions", [])
                valid_ids = {e["id"] for e in extensions}
                if valid_ids:
                    unknown = [s.get("extension_id") for s in steps if s.get("extension_id") not in valid_ids]
                    if unknown:
                        avail = ", ".join(sorted(valid_ids)) or "(none installed)"
                        return (
                            f"Unknown extension id(s): {', '.join(map(str, unknown))}. "
                            f"Use only these: {avail}.",
                            None,
                        )

                wf = _build_workflow_graph(
                    name=arguments.get("name") or "New Workflow",
                    description=arguments.get("description") or "",
                    input_type=input_type,
                    steps=steps,
                )
                payload = {"type": "create_workflow", "workflow": wf}
                return f"Created workflow '{wf['name']}' with {len(steps)} step(s).", payload

            else:
                return f"Unknown tool: {name}", None

        except httpx.HTTPStatusError as e:
            return f"API error {e.response.status_code}: {e.response.text[:200]}", None
        except Exception as e:
            return f"Error: {e}", None


class ChatMessage(BaseModel):
    role: str
    content: str
    images: list[str] = []


class AgentChatRequest(BaseModel):
    messages: list[ChatMessage]
    ollama_url: str = "http://localhost:11434"
    model: str = "qwen2.5:3b"
    context: dict = {}
    thinking: str = "auto"  # "auto" | "on" | "off"


class ActionDone(BaseModel):
    tool: str
    result: str
    payload: dict | None = None


class AgentChatResponse(BaseModel):
    message: str
    actions: list[ActionDone] = []
    thinking: str | None = None


def _extract_thinking(msg: dict) -> tuple[str, str | None]:
    """Return (clean_content, thinking_text). Handles both Ollama native field and <think> tags."""
    content = msg.get("content", "")
    thinking = msg.get("thinking") or None
    if not thinking:
        match = re.search(r"<think>(.*?)</think>", content, re.DOTALL)
        if match:
            thinking = match.group(1).strip()
            content = (content[: match.start()] + content[match.end() :]).strip()
    return content, thinking


class OllamaBoundaryError(Exception):
    def __init__(self, status_code: int, code: str, message: str, retryable: bool):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.safe_message = message
        self.retryable = retryable


def _invalid_stream(message: str = "Ollama returned an invalid streaming response.") -> OllamaBoundaryError:
    return OllamaBoundaryError(502, "ollama_invalid_stream", message, False)


def _normalize_stream_tool_calls(value: object) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise _invalid_stream()

    tool_calls: list[dict] = []
    for value_item in value:
        if not isinstance(value_item, dict) or not isinstance(value_item.get("function"), dict):
            raise _invalid_stream()
        function = value_item["function"]
        name = function.get("name")
        arguments = function.get("arguments", {})
        if not isinstance(name, str) or not name.strip() or not isinstance(arguments, dict):
            raise _invalid_stream()
        tool_call = dict(value_item)
        tool_call["function"] = {**function, "name": name, "arguments": arguments}
        tool_calls.append(tool_call)
    return tool_calls


def _stream_message_part(value: object, field: str) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise _invalid_stream(f"Ollama returned an invalid '{field}' value in its streaming response.")
    return value


def _log_ollama_round(round_number: int, started_at: float, terminal_frame: dict) -> None:
    metrics: dict[str, object] = {
        "round": round_number,
        "elapsed_ms": round((time.monotonic() - started_at) * 1000),
    }
    done_reason = terminal_frame.get("done_reason")
    if isinstance(done_reason, str):
        metrics["done_reason"] = done_reason[:64]
    for field in (
        "prompt_eval_count",
        "eval_count",
        "total_duration",
        "load_duration",
        "prompt_eval_duration",
        "eval_duration",
    ):
        value = terminal_frame.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            metrics[field] = value
    logger.info("Ollama agent round completed: %s", metrics)


async def _stream_ollama_round(
    client: httpx.AsyncClient,
    ollama_url: str,
    payload: dict,
    round_number: int,
) -> dict:
    """Consume one complete Ollama NDJSON chat round and reconstruct its assistant message."""
    started_at = time.monotonic()
    content_parts: list[str] = []
    thinking_parts: list[str] = []
    tool_calls: list[dict] = []
    terminal_frame: dict | None = None

    try:
        async with client.stream(
            "POST",
            f"{ollama_url.rstrip('/')}/api/chat",
            json={**payload, "stream": True},
        ) as response:
            if not response.is_success:
                retryable = response.status_code >= 500 or response.status_code in {408, 429}
                raise OllamaBoundaryError(
                    502,
                    "ollama_upstream_error",
                    "Ollama could not complete the request. Check the configured model and try again.",
                    retryable,
                )

            async for raw_line in response.aiter_lines():
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    frame = json.loads(line)
                except json.JSONDecodeError as error:
                    raise OllamaBoundaryError(
                        502,
                        "ollama_malformed_stream",
                        "Ollama returned malformed streaming data.",
                        False,
                    ) from error

                if not isinstance(frame, dict):
                    raise _invalid_stream()
                if "error" in frame:
                    raise OllamaBoundaryError(
                        502,
                        "ollama_error_frame",
                        "Ollama reported an error while generating the response. Check the model and try again.",
                        True,
                    )

                done = frame.get("done")
                message = frame.get("message")
                if not isinstance(done, bool) or not isinstance(message, dict):
                    raise _invalid_stream()
                role = message.get("role", "assistant")
                if role != "assistant":
                    raise _invalid_stream("Ollama returned a non-assistant message in its streaming response.")

                content_parts.append(_stream_message_part(message.get("content"), "content"))
                thinking_parts.append(_stream_message_part(message.get("thinking"), "thinking"))
                tool_calls.extend(_normalize_stream_tool_calls(message.get("tool_calls")))

                if done:
                    done_reason = frame.get("done_reason")
                    if done_reason is not None and not isinstance(done_reason, str):
                        raise _invalid_stream("Ollama returned an invalid done reason in its streaming response.")
                    terminal_frame = frame
                    break
    except OllamaBoundaryError:
        raise
    except (httpx.ConnectError, httpx.ConnectTimeout) as error:
        raise OllamaBoundaryError(
            503,
            "ollama_unavailable",
            "Cannot reach Ollama. Check that Ollama is running and try again.",
            True,
        ) from error
    except httpx.ReadTimeout as error:
        raise OllamaBoundaryError(
            504,
            "ollama_timeout",
            "Ollama stopped sending data before the response completed. Try again.",
            True,
        ) from error
    except httpx.TimeoutException as error:
        raise OllamaBoundaryError(
            504,
            "ollama_timeout",
            "Ollama timed out before the response completed. Try again.",
            True,
        ) from error
    except httpx.InvalidURL as error:
        raise OllamaBoundaryError(
            503,
            "ollama_unavailable",
            "The configured Ollama URL is invalid. Check the agent settings and try again.",
            False,
        ) from error
    except httpx.HTTPError as error:
        raise OllamaBoundaryError(
            502,
            "ollama_stream_error",
            "The connection to Ollama failed before the streaming response completed. Try again.",
            True,
        ) from error

    if terminal_frame is None:
        raise OllamaBoundaryError(
            502,
            "ollama_incomplete_stream",
            "Ollama closed the stream before completing the response. Try again.",
            True,
        )

    assistant_message: dict = {"role": "assistant", "content": "".join(content_parts)}
    thinking = "".join(thinking_parts)
    if thinking:
        assistant_message["thinking"] = thinking
    if tool_calls:
        assistant_message["tool_calls"] = tool_calls

    _log_ollama_round(round_number, started_at, terminal_frame)
    return assistant_message


def _serialize_actions(actions: list[ActionDone]) -> list[dict]:
    return [
        action.model_dump() if hasattr(action, "model_dump") else action.dict()
        for action in actions
    ]


def _raise_ollama_boundary_error(
    error: OllamaBoundaryError,
    round_number: int,
    actions: list[ActionDone],
) -> NoReturn:
    logger.warning(
        "Ollama agent round failed: round=%s code=%s completed_actions=%s",
        round_number,
        error.code,
        len(actions),
    )
    raise HTTPException(
        status_code=error.status_code,
        detail={
            "code": error.code,
            "message": error.safe_message,
            "retryable": error.retryable,
            "round": round_number,
            "actions": _serialize_actions(actions),
        },
    ) from error


@router.get("/models")
async def list_ollama_models(ollama_url: str = "http://localhost:11434"):
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            r = await client.get(f"{ollama_url}/api/tags")
            r.raise_for_status()
            models = [m["name"] for m in r.json().get("models", [])]
            return {"models": models}
        except Exception:
            return {"models": []}


@router.post("/chat", response_model=AgentChatResponse)
async def agent_chat(request: AgentChatRequest):
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Inject scene context so the LLM knows current state
    if request.context:
        ctx_lines = []
        if request.context.get("currentMeshPath"):
            ctx_lines.append(f"Current mesh path: {request.context['currentMeshPath']}")
        if request.context.get("meshTriangles"):
            ctx_lines.append(f"Current mesh triangles: {request.context['meshTriangles']:,}")
        if ctx_lines:
            messages.append({
                "role": "system",
                "content": "Scene context:\n" + "\n".join(ctx_lines),
            })

        extensions = request.context.get("extensions") or []
        if extensions:
            ext_lines = [
                f"- {e['id']} ({e.get('input', '?')}→{e.get('output', '?')}): {e.get('name', e['id'])}"
                for e in extensions
            ]
            messages.append({
                "role": "system",
                "content": (
                    "Available extensions (use the exact id when creating workflows):\n"
                    + "\n".join(ext_lines)
                ),
            })

    for m in request.messages:
        entry: dict = {"role": m.role, "content": m.content}
        if m.images:
            entry["images"] = m.images
        messages.append(entry)

    actions_done: list[ActionDone] = []
    all_thinking:  list[str]       = []

    # Build Ollama think param
    ollama_extra: dict = {}
    if request.thinking == "on":
        ollama_extra["think"] = True
    elif request.thinking == "off":
        ollama_extra["think"] = False

    async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT) as client:
        for round_number in range(1, 11):  # max tool-call rounds
            try:
                msg = await _stream_ollama_round(
                    client,
                    request.ollama_url,
                    {
                        "model": request.model,
                        "messages": messages,
                        "tools": TOOLS,
                        **ollama_extra,
                    },
                    round_number,
                )
            except OllamaBoundaryError as error:
                _raise_ollama_boundary_error(error, round_number, actions_done)

            messages.append(msg)

            clean_content, thinking_text = _extract_thinking(msg)
            if thinking_text:
                all_thinking.append(thinking_text)

            tool_calls = msg.get("tool_calls") or []
            if not tool_calls:
                combined_thinking = "\n\n---\n\n".join(all_thinking) if all_thinking else None
                return AgentChatResponse(
                    message=clean_content,
                    actions=actions_done,
                    thinking=combined_thinking,
                )

            for tc in tool_calls:
                fn = tc["function"]
                result_text, payload = await execute_tool(fn["name"], fn.get("arguments") or {}, request.context)
                actions_done.append(ActionDone(tool=fn["name"], result=result_text, payload=payload))
                messages.append({"role": "tool", "content": result_text, "tool_name": fn["name"]})

        has_workflow = any(a.tool == "run_workflow" for a in actions_done)
        if has_workflow:
            # Unload LLM from VRAM immediately so the workflow has full GPU memory
            try:
                await client.post(
                    f"{request.ollama_url}/api/generate",
                    json={"model": request.model, "keep_alive": 0},
                    timeout=5.0,
                )
            except Exception:
                pass

    combined_thinking = "\n\n---\n\n".join(all_thinking) if all_thinking else None
    return AgentChatResponse(message="Reached maximum tool iterations.", actions=actions_done, thinking=combined_thinking)
