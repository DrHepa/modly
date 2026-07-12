import asyncio
import inspect
import json
import logging
import threading
import traceback
import uuid
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Dict, Optional, Tuple

from fastapi import BackgroundTasks, HTTPException, UploadFile

from schemas.generation import JobStatus, SceneCandidate
from services.generator_registry import WORKSPACE_DIR, generator_registry
from services.generators.base import GenerationCancelled, smooth_progress


_jobs: Dict[str, JobStatus] = {}
_cancelled: set[str] = set()
_cancel_events: Dict[str, threading.Event] = {}
_last_logged_snapshots: Dict[str, Tuple[str, int, Optional[str]]] = {}
_log_lock = threading.Lock()
_generation_logger = logging.getLogger("modly.generation.jobs")
SCENE_MANIFEST_SCHEMA = "modly.scene-manifest.v1"


def _log_job_progress(job: JobStatus) -> bool:
    snapshot = (job.status, job.progress, job.step)

    with _log_lock:
        if _last_logged_snapshots.get(job.job_id) == snapshot:
            return False
        _last_logged_snapshots[job.job_id] = snapshot

    _generation_logger.info(
        "generation job progress job_id=%s status=%s progress=%s step=%s",
        job.job_id,
        job.status,
        job.progress,
        job.step,
    )
    return True


def create_job() -> JobStatus:
    job_id = str(uuid.uuid4())
    job = JobStatus(job_id=job_id, status="pending", progress=0)
    _jobs[job_id] = job
    _cancel_events[job_id] = threading.Event()
    with _log_lock:
        _last_logged_snapshots.pop(job_id, None)
    return job


def create_generation_job(
    background_tasks: BackgroundTasks,
    *,
    params: dict,
    collection: str = "Default",
    image_bytes: Optional[bytes] = None,
    prompt: Optional[str] = None,
) -> JobStatus:
    job = create_job()
    background_tasks.add_task(
        _run_generation,
        job.job_id,
        image_bytes=image_bytes,
        prompt=prompt,
        params=params,
        collection=collection,
    )
    return job


def create_from_image_job(background_tasks: BackgroundTasks, image_bytes: bytes, params: dict, collection: str = "Default") -> JobStatus:
    return create_generation_job(
        background_tasks,
        image_bytes=image_bytes,
        params=params,
        collection=collection,
    )


def create_from_text_job(background_tasks: BackgroundTasks, prompt: str, params: dict, collection: str = "Default") -> JobStatus:
    return create_generation_job(
        background_tasks,
        prompt=prompt,
        params=params,
        collection=collection,
    )


def create_from_none_job(background_tasks: BackgroundTasks, params: dict, collection: str = "Default") -> JobStatus:
    return create_generation_job(
        background_tasks,
        image_bytes=b"",
        params=params,
        collection=collection,
    )


def create_from_scene_job(background_tasks: BackgroundTasks, params: dict, collection: str = "Default") -> JobStatus:
    return create_generation_job(
        background_tasks,
        params=params,
        collection=collection,
    )


def get_job(job_id: str) -> Optional[JobStatus]:
    return _jobs.get(job_id)


def require_job(job_id: str) -> JobStatus:
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return job


def get_job_status(job_id: str) -> JobStatus:
    return require_job(job_id)


def cancel_job(job_id: str) -> JobStatus:
    job = require_job(job_id)

    if job.status not in ("pending", "running"):
        return job

    _cancelled.add(job_id)

    cancel_event = _cancel_events.get(job_id)
    if cancel_event is not None:
        cancel_event.set()

    job.status = "cancelled"
    _log_job_progress(job)

    try:
        gen = generator_registry._generators.get(generator_registry._active_id)
        if gen is not None and hasattr(gen, "_proc") and gen._proc and gen._proc.poll() is None:
            gen._proc.kill()
            gen._loaded = False
            gen._proc = None
    except Exception:
        pass

    return job


def validate_image_upload(image: UploadFile) -> None:
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")


def validate_model_id(model_id: str) -> None:
    try:
        generator_registry.get_generator(model_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


def require_model_id(model_id: str) -> str:
    canonical_model_id = model_id.strip()
    if not canonical_model_id:
        raise HTTPException(400, "model_id is required")

    validate_model_id(canonical_model_id)
    return canonical_model_id


def require_model_input(model_id: str, expected_input: str) -> str:
    """Require one canonical model to match an endpoint's input contract."""
    canonical_model_id = require_model_id(model_id)

    try:
        declared_input = generator_registry.get_model_input(canonical_model_id)
    except (KeyError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc

    if declared_input != expected_input:
        raise HTTPException(
            400,
            (
                f"Model '{canonical_model_id}' expects input '{declared_input}' but "
                f"this endpoint received '{expected_input}'."
            ),
        )

    return canonical_model_id


def validate_model_input(model_id: str, expected_input: str) -> None:
    require_model_input(model_id, expected_input)


def parse_params_object(params: Optional[str], *, strict: bool) -> dict:
    if params in (None, ""):
        return {}

    try:
        parsed = json.loads(params)
    except (json.JSONDecodeError, TypeError) as exc:
        if strict:
            raise HTTPException(400, "params must be a valid JSON object") from exc
        return {}

    if parsed is None:
        return {}

    if not isinstance(parsed, dict):
        if strict:
            raise HTTPException(400, "params must be a JSON object")
        return {}

    return parsed


def validate_scene_manifest_path(scene_path: str) -> str:
    candidate = scene_path.strip().replace("\\", "/")
    if not candidate:
        raise HTTPException(400, "scene_path is required")

    posix_path = PurePosixPath(candidate)
    windows_path = PureWindowsPath(candidate)
    if posix_path.is_absolute() or windows_path.is_absolute():
        raise HTTPException(400, "scene_path must be workspace-relative")

    if posix_path.suffix.lower() != ".json":
        raise HTTPException(400, "scene_path must reference a .json scene manifest")

    if any(part == ".." for part in posix_path.parts):
        raise HTTPException(400, "scene_path must not traverse outside the workspace")

    workspace_root = WORKSPACE_DIR.resolve()
    scene_file = (workspace_root / posix_path).resolve()
    if workspace_root != scene_file and workspace_root not in scene_file.parents:
        raise HTTPException(400, "scene_path must stay within the workspace")
    if not scene_file.exists() or not scene_file.is_file():
        raise HTTPException(404, "scene_path was not found in the workspace")

    try:
        manifest = json.loads(scene_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "scene_path must reference a valid JSON scene manifest") from exc

    if not isinstance(manifest, dict):
        raise HTTPException(400, "scene manifest must be a JSON object")
    if manifest.get("schema") != SCENE_MANIFEST_SCHEMA:
        raise HTTPException(400, f"scene manifest schema must be {SCENE_MANIFEST_SCHEMA}")

    scene_root = manifest.get("sceneRoot")
    if not isinstance(scene_root, str) or not scene_root.strip():
        raise HTTPException(400, "scene manifest sceneRoot is required")

    return scene_file.relative_to(workspace_root).as_posix()


def resolve_validated_scene_manifest_path(scene_path: str) -> Path:
    workspace_relative = validate_scene_manifest_path(scene_path)
    return (WORKSPACE_DIR.resolve() / workspace_relative).resolve()


def get_workspace_path(output_path: Path) -> Optional[str]:
    try:
        return output_path.relative_to(WORKSPACE_DIR).as_posix()
    except ValueError:
        return None


def build_output_url(output_path: Path, collection: str = "Default") -> str:
    workspace_path = get_workspace_path(output_path)
    if workspace_path is not None:
        return f"/workspace/{workspace_path}"

    try:
        rel = output_path.relative_to(WORKSPACE_DIR)
        return f"/workspace/{rel.as_posix()}"
    except ValueError:
        return f"/workspace/{collection}/{output_path.name}"


def build_scene_candidate(output_path: Optional[Path], collection: str = "Default") -> Optional[SceneCandidate]:
    if output_path is None:
        return None

    workspace_path = get_workspace_path(output_path)
    if workspace_path is None:
        return None

    output_url = build_output_url(output_path, collection)
    actual_output_kind = detect_output_kind(output_path) or "mesh"

    return SceneCandidate(
        kind=actual_output_kind,
        workspace_path=workspace_path,
        output_url=output_url,
        display_name=output_path.name,
    )


def is_scene_manifest_path(output_path: Path) -> bool:
    if output_path.suffix.lower() != ".json":
        return False

    try:
        manifest = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False

    return isinstance(manifest, dict) and manifest.get("schema") == SCENE_MANIFEST_SCHEMA


def detect_output_kind(output_path: Optional[Path]) -> Optional[str]:
    if output_path is None:
        return None

    suffix = output_path.suffix.lower()
    if suffix == ".json" and is_scene_manifest_path(output_path):
        return "scene"

    if suffix in {".glb", ".gltf", ".obj", ".stl", ".ply", ".fbx", ".usd", ".usda", ".usdc", ".usdz"}:
        return "mesh"

    return None


async def _run_generation(
    job_id: str,
    *,
    image_bytes: Optional[bytes] = None,
    prompt: Optional[str] = None,
    params: dict,
    collection: str = "Default",
) -> None:
    job = _jobs[job_id]
    job.status = "running"
    _log_job_progress(job)

    def progress_cb(pct: int, step: str = "") -> None:
        job.progress = pct
        if step:
            job.step = step
        _log_job_progress(job)

    try:
        loop = asyncio.get_running_loop()

        if not generator_registry.active_status()["loaded"]:
            active = generator_registry.active_status()
            model_name = active["name"]
            init_label = f"Downloading {model_name}…" if not active["downloaded"] else f"Loading {model_name}…"
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

        coll_dir = WORKSPACE_DIR / collection
        coll_dir.mkdir(parents=True, exist_ok=True)
        gen.outputs_dir = coll_dir

        cancel_event = _cancel_events.get(job_id)
        supports_cancel = "cancel_event" in inspect.signature(gen.generate).parameters
        generation_input = image_bytes if image_bytes is not None else b""
        generation_params = dict(params)
        if prompt is not None:
            generation_params.setdefault("prompt", prompt)

        output_path = await loop.run_in_executor(
            None,
            lambda: gen.generate(generation_input, generation_params, progress_cb, cancel_event)
            if supports_cancel
            else gen.generate(generation_input, generation_params, progress_cb),
        )

        if job_id in _cancelled:
            return

        job.status = "done"
        job.progress = 100
        job.output_url = build_output_url(output_path, collection)
        job.output_kind = detect_output_kind(output_path)
        job.scene_candidate = build_scene_candidate(output_path, collection)
        _log_job_progress(job)

    except GenerationCancelled:
        job.status = "cancelled"
        _log_job_progress(job)
    except Exception:
        if job_id in _cancelled:
            return
        tb = traceback.format_exc()
        job.status = "error"
        job.error = tb.strip()
        _log_job_progress(job)
