import asyncio
import inspect
import json
import threading
import traceback
import uuid
from pathlib import Path
from typing import Dict, Optional

from fastapi import BackgroundTasks, HTTPException, UploadFile

from schemas.generation import JobStatus, SceneCandidate
from services.generator_registry import WORKSPACE_DIR, generator_registry
from services.generators.base import GenerationCancelled, smooth_progress


_jobs: Dict[str, JobStatus] = {}
_cancelled: set[str] = set()
_cancel_events: Dict[str, threading.Event] = {}


def create_job() -> JobStatus:
    job_id = str(uuid.uuid4())
    job = JobStatus(job_id=job_id, status="pending", progress=0)
    _jobs[job_id] = job
    _cancel_events[job_id] = threading.Event()
    return job


def create_from_image_job(background_tasks: BackgroundTasks, image_bytes: bytes, params: dict, collection: str = "Default") -> JobStatus:
    job = create_job()
    background_tasks.add_task(_run_generation, job.job_id, image_bytes, params, collection)
    return job


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
    return SceneCandidate(
        kind="mesh",
        workspace_path=workspace_path,
        output_url=output_url,
        display_name=output_path.name,
    )


async def _run_generation(job_id: str, image_bytes: bytes, params: dict, collection: str = "Default") -> None:
    job = _jobs[job_id]
    job.status = "running"

    def progress_cb(pct: int, step: str = "") -> None:
        job.progress = pct
        if step:
            job.step = step

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
        output_path = await loop.run_in_executor(
            None,
            lambda: gen.generate(image_bytes, params, progress_cb, cancel_event)
            if supports_cancel
            else gen.generate(image_bytes, params, progress_cb),
        )

        if job_id in _cancelled:
            return

        job.status = "done"
        job.progress = 100
        job.output_url = build_output_url(output_path, collection)
        job.scene_candidate = build_scene_candidate(output_path, collection)

    except GenerationCancelled:
        job.status = "cancelled"
    except Exception as exc:
        if job_id in _cancelled:
            return
        tb = traceback.format_exc()
        print(f"[Generation ERROR] {exc}\n{tb}")
        job.status = "error"
        job.error = tb.strip()
