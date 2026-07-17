import asyncio
from collections import OrderedDict
import json
import threading
import time
import traceback
import uuid
from typing import Dict, List, Tuple
from fastapi import APIRouter, File, Form, UploadFile, HTTPException, BackgroundTasks
from services.generators.base import smooth_progress, GenerationCancelled

import re as _re
from services.generator_registry import generator_registry, WORKSPACE_DIR
from schemas.generation import JobStatus

router = APIRouter(tags=["generation"])

_jobs: Dict[str, JobStatus] = {}
_cancelled: set = set()
_cancel_events: Dict[str, threading.Event] = {}
_completed_at: Dict[str, float] = {}

_JOB_TTL = 1800  # purge terminal jobs after 30 minutes
_INPUT_PORT_NAME_RE = _re.compile(r"^[a-z][a-z0-9_]*$")


def _purge_old_jobs() -> None:
    cutoff = time.monotonic() - _JOB_TTL
    stale = [jid for jid, t in _completed_at.items() if t < cutoff]
    for jid in stale:
        _jobs.pop(jid, None)
        _cancelled.discard(jid)
        _cancel_events.pop(jid, None)
        _completed_at.pop(jid, None)


def _normalize_named_v1_input_ports(manifest: dict) -> list[dict]:
    if manifest.get("io_contract") != "named-v1":
        raise HTTPException(400, "Model does not declare io_contract named-v1")

    raw_ports = manifest.get("input_ports")
    if not isinstance(raw_ports, list) or not raw_ports:
        raise HTTPException(400, "named-v1 model must declare a non-empty input_ports list")

    normalized: list[dict] = []
    seen: set[str] = set()
    allowed_keys = {"name", "type", "label", "required"}
    for idx, port in enumerate(raw_ports):
        if not isinstance(port, dict):
            raise HTTPException(400, f"input_ports[{idx}] must be an object")
        extra_keys = set(port.keys()) - allowed_keys
        if extra_keys:
            keys = ", ".join(sorted(extra_keys))
            raise HTTPException(400, f"input_ports[{idx}] contains unsupported field(s): {keys}")

        name = port.get("name")
        if not isinstance(name, str) or not name:
            raise HTTPException(400, f"input_ports[{idx}].name must be a non-empty string")
        if not _INPUT_PORT_NAME_RE.match(name):
            raise HTTPException(
                400,
                f"input port name '{name}' must be lowercase-safe "
                "(letters, numbers, underscore; starts with a letter)",
            )
        lowered = name.lower()
        if lowered in seen:
            raise HTTPException(400, f"Duplicate input port name '{name}'")
        seen.add(lowered)

        if port.get("type") != "image":
            raise HTTPException(400, f"input port '{name}' must have type 'image'")

        if "label" in port and not isinstance(port["label"], str):
            raise HTTPException(400, f"input port '{name}' label must be a string")
        if "required" not in port or not isinstance(port["required"], bool):
            raise HTTPException(400, f"input port '{name}' required must be present and boolean")
        required = port["required"]

        normalized.append({
            "name": name,
            "type": "image",
            "required": required,
            **({"label": port["label"]} if "label" in port else {}),
        })

    return normalized


def _primary_input_port(input_ports: list[dict]) -> str:
    for port in input_ports:
        if port["required"]:
            return port["name"]
    return input_ports[0]["name"]


def _order_named_images(
    input_ports: list[dict],
    submitted: List[Tuple[str, bytes]],
) -> "OrderedDict[str, bytes]":
    declared = {port["name"]: port for port in input_ports}
    counts = {port["name"]: 0 for port in input_ports}
    submitted_by_name: dict[str, bytes] = {}

    for raw_name, image_bytes in submitted:
        name = raw_name.strip()
        if name not in declared:
            raise HTTPException(400, f"Unknown input port '{name}'")
        if name in submitted_by_name:
            raise HTTPException(400, f"Duplicate image submitted for input port '{name}'")
        submitted_by_name[name] = image_bytes
        counts[name] += 1

    for port in input_ports:
        name = port["name"]
        if port["required"] and counts[name] == 0:
            raise HTTPException(400, f"Missing required image for input port '{name}'")

    if len(submitted_by_name) == 1:
        submitted_name = next(iter(submitted_by_name))
        primary_name = _primary_input_port(input_ports)
        if submitted_name != primary_name:
            raise HTTPException(
                400,
                f"Single named image submissions must target primary input port '{primary_name}'",
            )

    ordered: "OrderedDict[str, bytes]" = OrderedDict()
    for port in input_ports:
        name = port["name"]
        if name in submitted_by_name:
            ordered[name] = submitted_by_name[name]
    return ordered


@router.post("/from-image")
async def generate_from_image(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    model_id: str = Form("sf3d"),
    collection: str = Form("Default"),
    remesh: str = Form("quad"),
    enable_texture: bool = Form(False),
    texture_resolution: int = Form(1024),
    params: str = Form("{}"),
):
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")

    if remesh not in ("quad", "triangle", "none"):
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    # Sanitize collection name: strip, forbid path separators and special chars
    collection = collection.strip()
    if not collection or _re.search(r'[/:*?"<>|\\]', collection):
        collection = "Default"

    # Verify the requested model exists in the registry.
    try:
        generator_registry.get_generator(model_id)
    except ValueError as e:
        raise HTTPException(400, str(e))

    manifest = None
    get_manifest = getattr(generator_registry, "get_manifest", None)
    if callable(get_manifest):
        try:
            manifest = get_manifest(model_id)
        except KeyError:
            # Built-in/legacy generators may not have extension manifests.
            manifest = None
    if isinstance(manifest, dict) and manifest.get("io_contract") == "named-v1":
        input_ports = _normalize_named_v1_input_ports(manifest)
        primary_name = _primary_input_port(input_ports)
        _order_named_images(input_ports, [(primary_name, b"")])

    generator_registry.switch_model(model_id)

    # Parse model-specific params from JSON and merge with common fields
    try:
        model_params = json.loads(params)
    except (json.JSONDecodeError, TypeError):
        model_params = {}

    job_id      = str(uuid.uuid4())
    image_bytes = await image.read()
    full_params = {
        "remesh":             remesh,
        "enable_texture":     enable_texture,
        "texture_resolution": texture_resolution,
        **model_params,
    }

    _purge_old_jobs()

    job = JobStatus(job_id=job_id, status="pending", progress=0)
    _jobs[job_id] = job
    _cancel_events[job_id] = threading.Event()

    background_tasks.add_task(_run_generation, job_id, image_bytes, full_params, collection)

    return {"job_id": job_id}


@router.post("/from-images")
async def generate_from_images(
    background_tasks: BackgroundTasks,
    images: List[UploadFile] = File(...),
    image_names: List[str] = Form(...),
    model_id: str = Form("sf3d"),
    collection: str = Form("Default"),
    remesh: str = Form("quad"),
    enable_texture: bool = Form(False),
    texture_resolution: int = Form(1024),
    params: str = Form("{}"),
):
    if len(images) != len(image_names):
        raise HTTPException(400, "images and image_names must have the same count")
    if not images:
        raise HTTPException(400, "At least one image is required")

    for image in images:
        if not image.content_type or not image.content_type.startswith("image/"):
            raise HTTPException(400, "Every file must be an image")

    if remesh not in ("quad", "triangle", "none"):
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    collection = collection.strip()
    if not collection or _re.search(r'[/:*?"<>|\\]', collection):
        collection = "Default"

    try:
        generator_registry.get_generator(model_id)
        manifest = generator_registry.get_manifest(model_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except KeyError as e:
        raise HTTPException(400, str(e))

    input_ports = _normalize_named_v1_input_ports(manifest)
    generator_registry.switch_model(model_id)

    try:
        model_params = json.loads(params)
    except (json.JSONDecodeError, TypeError):
        model_params = {}

    submitted: List[Tuple[str, bytes]] = []
    for image_name, image in zip(image_names, images):
        submitted.append((image_name, await image.read()))

    named_images = _order_named_images(input_ports, submitted)
    full_params = {
        "remesh":             remesh,
        "enable_texture":     enable_texture,
        "texture_resolution": texture_resolution,
        **model_params,
    }

    job_id = str(uuid.uuid4())

    _purge_old_jobs()

    job = JobStatus(
        job_id=job_id,
        status="pending",
        progress=0,
        input_ports=list(named_images.keys()),
    )
    _jobs[job_id] = job
    _cancel_events[job_id] = threading.Event()

    background_tasks.add_task(_run_generation, job_id, named_images, full_params, collection)

    return {"job_id": job_id}



@router.get("/status/{job_id}")
async def job_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return job


@router.post("/cancel/{job_id}")
async def cancel_job(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    _cancelled.add(job_id)
    if job_id in _cancel_events:
        _cancel_events[job_id].set()
    if job.status in ("pending", "running"):
        job.status = "cancelled"
        _completed_at[job_id] = time.monotonic()
    # Kill the active generator subprocess immediately so inference stops now.
    # _run_generation will catch the resulting exception, see job_id in _cancelled,
    # and return cleanly without setting an error status.
    try:
        gen = generator_registry._generators.get(generator_registry._active_id)
        if gen is not None and hasattr(gen, "_proc") and gen._proc and gen._proc.poll() is None:
            gen._proc.kill()
            gen._loaded = False
            gen._proc = None
    except Exception:
        pass
    return {"cancelled": True}


async def _run_generation(job_id: str, image_bytes: bytes | dict[str, bytes], params: dict, collection: str = "Default") -> None:
    job = _jobs[job_id]
    job.status = "running"

    def progress_cb(pct: int, step: str = "") -> None:
        if pct > job.progress:
            job.progress = pct
        if step:
            job.step = step

    try:
        loop = asyncio.get_running_loop()

        # Check if the model needs to be loaded BEFORE calling get_active(),
        # because get_active() loads the model in a blocking manner.
        # active_status() is an instantaneous operation (simple dict lookup).
        if not generator_registry.active_status()["loaded"]:
            active = generator_registry.active_status()
            model_name = active['name']
            init_label = f"Downloading {model_name}…" if not active['downloaded'] else f"Loading {model_name}…"
            progress_cb(0, init_label)
            stop_load_evt = threading.Event()
            load_thread = threading.Thread(
                target=smooth_progress,
                args=(progress_cb, 0, 9, init_label, stop_load_evt, 4.0),
                daemon=True,
            )
            load_thread.start()
            try:
                gen = await loop.run_in_executor(None, generator_registry.get_active)
            finally:
                stop_load_evt.set()
        else:
            gen = await loop.run_in_executor(None, generator_registry.get_active)

        if job_id in _cancelled:
            return

        # Direct output to the collection subfolder
        coll_dir = WORKSPACE_DIR / collection
        coll_dir.mkdir(parents=True, exist_ok=True)
        gen.outputs_dir = coll_dir

        cancel_event = _cancel_events.get(job_id)
        import inspect
        if isinstance(image_bytes, dict):
            named_images = image_bytes
            if len(named_images) > 1:
                if not callable(getattr(gen, "generate_v2", None)):
                    active_id = generator_registry.active_status()["id"]
                    raise RuntimeError(
                        f"[{active_id}] Multiple named image inputs require "
                        "generate_v2(named_images, params, progress_cb, cancel_event)."
                    )
                output_path = await loop.run_in_executor(
                    None,
                    lambda: gen.generate_v2(named_images, params, progress_cb, cancel_event),
                )
            else:
                primary_image = next(iter(named_images.values()))
                supports_cancel = "cancel_event" in inspect.signature(gen.generate).parameters
                output_path = await loop.run_in_executor(
                    None,
                    lambda: gen.generate(primary_image, params, progress_cb, cancel_event)
                            if supports_cancel
                            else gen.generate(primary_image, params, progress_cb),
                )
        else:
            supports_cancel = "cancel_event" in inspect.signature(gen.generate).parameters
            output_path = await loop.run_in_executor(
                None,
                lambda: gen.generate(image_bytes, params, progress_cb, cancel_event)
                        if supports_cancel
                        else gen.generate(image_bytes, params, progress_cb),
            )

        if job_id in _cancelled:
            return

        job.status   = "done"
        job.progress = 100
        _completed_at[job_id] = time.monotonic()
        try:
            rel = output_path.relative_to(WORKSPACE_DIR)
            job.output_url = f"/workspace/{rel.as_posix()}"
        except ValueError:
            job.output_url = f"/workspace/{collection}/{output_path.name}"

    except GenerationCancelled:
        job.status = "cancelled"
        _completed_at[job_id] = time.monotonic()
    except Exception as exc:
        if job_id in _cancelled:
            return
        tb = traceback.format_exc()
        msg = f"[Generation ERROR] {exc}\n{tb}"
        try:
            print(msg)
        except UnicodeEncodeError:
            print(msg.encode("ascii", errors="replace").decode("ascii"))
        job.status = "error"
        job.error  = tb.strip()
        _completed_at[job_id] = time.monotonic()
