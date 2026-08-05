import asyncio
import base64
import inspect
import json
import logging
import re as _re
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, Optional, Tuple, Union

from fastapi import BackgroundTasks, HTTPException, UploadFile

import services.generator_registry as registry
from schemas.generation import JobStatus, SceneCandidate
from services.artifact_input import TypedArtifactInput
from services.generator_registry import generator_registry
from services.generators.base import GenerationCancelled, smooth_progress


# Shared by both image routes so the two endpoints can't drift apart on
# what counts as a valid remesh mode the way they had drifted on `collection` before #238.
VALID_REMESH_MODES = ("quad", "triangle", "none")

_jobs: Dict[str, JobStatus] = {}
_cancelled: set = set()
_cancel_events: Dict[str, threading.Event] = {}
_last_logged_snapshots: Dict[str, Tuple[str, int, Optional[str]]] = {}
# Job state and its log snapshot share one short publication/retirement boundary.
# Reentrant because transition owners call _log_job_progress while holding it.
_log_lock = threading.RLock()
_generation_logger = logging.getLogger("modly.generation.jobs")
_completed_at: Dict[str, float] = {}
_job_generators: Dict[str, object] = {}
# A pinned generation owns the complete switch/load/generate lifecycle.  Keeping
# that lifecycle on one dedicated worker provides process-wide serialization
# without parking default-executor workers on a blocking lock acquisition.
_pinned_generation_executor = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="modly-pinned-generation",
)

_JOB_TTL = 1800  # purge terminal jobs after 30 minutes
IMAGE_OUTPUT_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"})
MESH_OUTPUT_SUFFIXES = frozenset({".glb", ".gltf", ".obj", ".stl", ".ply", ".fbx", ".usd", ".usda", ".usdc", ".usdz"})
VIDEO_OUTPUT_SUFFIXES = frozenset({".mp4", ".mov", ".webm", ".mkv", ".avi"})
AUDIO_OUTPUT_SUFFIXES = frozenset({".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac"})


def get_workspace_dir() -> Path:
    """Return the runtime workspace root shared with extension subprocesses."""
    import services.generator_registry as registry_module

    return registry_module.WORKSPACE_DIR


def _log_job_progress(job: JobStatus) -> bool:
    with _log_lock:
        if _jobs.get(job.job_id) is not job:
            return False
        snapshot = (job.status, job.progress, job.step)
        previous = _last_logged_snapshots.get(job.job_id)
        if previous == snapshot:
            return False
        _last_logged_snapshots[job.job_id] = snapshot
        # Extension step text can echo prompts, paths or exception details. Keep
        # it intact in the API/snapshot, but log only whether it changed.
        step_changed = snapshot[2] != (previous[2] if previous else None)
        _generation_logger.info(
            "generation job progress job_id=%s status=%s progress=%s step_changed=%s",
            job.job_id,
            snapshot[0],
            snapshot[1],
            step_changed,
        )
    return True


def _purge_old_jobs() -> None:
    cutoff = time.monotonic() - _JOB_TTL
    with _log_lock:
        stale = [jid for jid, t in _completed_at.items() if t < cutoff]
        for jid in stale:
            _jobs.pop(jid, None)
            _cancelled.discard(jid)
            _cancel_events.pop(jid, None)
            _job_generators.pop(jid, None)
            _completed_at.pop(jid, None)
            _last_logged_snapshots.pop(jid, None)


def sanitize_collection(collection: str) -> str:
    """Normalize a caller-supplied collection name into a safe workspace subfolder.

    The value becomes a directory under the workspace (``WORKSPACE_DIR / collection``), so a
    name carrying a path separator or a drive/wildcard character could escape that root or fail
    to create on Windows. Such a name, or an empty one, falls back to ``"Default"`` rather than
    raising, because a generation the caller already paid for should still land somewhere
    sensible. Shared so every entry point that routes output into a collection sanitizes it the
    same way; a second copy of this rule is a second chance to forget a character.

    Legality and containment are different questions, so they are asked separately: the
    reserved characters above are refused outright, and containment is put to the path
    library rather than to the spelling -- the same ``relative_to`` check
    ``generator_registry._path_belongs_to`` uses, so the two containment checks in this
    backend agree rather than drifting on their own semantics. A character blocklist alone
    lets ``".."`` through -- it contains none of the listed characters -- and
    ``WORKSPACE_DIR / ".."`` resolves to the workspace's *parent*, so the generated mesh
    would land outside the root.

    A name ending in a dot or space is refused too, even once it clears both checks above:
    Windows silently drops trailing dots/spaces from the final path component it actually
    creates, so ``mkdir()`` on ``"Exports..."`` lands in the very same folder as
    ``"Exports"`` -- two collections that look distinct to this function would otherwise
    merge their output on disk without either caller being told.
    """
    collection = (collection or "").strip()
    if (
        not collection
        or _re.search(r'[/:*?"<>|\\]', collection)
        or collection != collection.rstrip(". ")
    ):
        return "Default"

    try:
        (registry.WORKSPACE_DIR / collection).resolve().relative_to(
            registry.WORKSPACE_DIR.resolve()
        )
    except (OSError, ValueError):
        return "Default"

    return collection


def create_job() -> JobStatus:
    _purge_old_jobs()
    job_id = str(uuid.uuid4())
    job = JobStatus(job_id=job_id, status="pending", progress=0)
    with _log_lock:
        _jobs[job_id] = job
        _cancel_events[job_id] = threading.Event()
        _last_logged_snapshots.pop(job_id, None)
    return job


def create_generation_job(
    background_tasks: BackgroundTasks,
    model_input: Union[bytes, Path, TypedArtifactInput],
    params: dict,
    collection: str = "Default",
    output_kind: str = "mesh",
    model_id: Optional[str] = None,
) -> JobStatus:
    job = create_job()
    background_tasks.add_task(
        _run_generation, job.job_id, model_input, params,
        sanitize_collection(collection), output_kind, model_id,
    )
    return job


def create_from_image_job(
    background_tasks: BackgroundTasks,
    image_bytes: bytes,
    params: dict,
    collection: str = "Default",
    output_kind: str = "mesh",
    model_id: Optional[str] = None,
) -> JobStatus:
    return create_generation_job(
        background_tasks, image_bytes, params, collection, output_kind, model_id,
    )


def create_from_video_job(
    background_tasks: BackgroundTasks,
    video_path: Path,
    params: dict,
    collection: str = "Default",
    output_kind: str = "mesh",
    model_id: Optional[str] = None,
) -> JobStatus:
    return create_generation_job(
        background_tasks, video_path, params, collection, output_kind, model_id,
    )


def create_from_text_job(
    background_tasks: BackgroundTasks,
    prompt: str,
    params: dict,
    collection: str = "Default",
    output_kind: str = "mesh",
    model_id: Optional[str] = None,
) -> JobStatus:
    # Legacy generators still consume image bytes. Match the existing text-only
    # workflow ABI with a valid placeholder PNG and both prompt aliases, while
    # leaving scheduling, variants, cancellation and artifacts to the shared owner.
    placeholder = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    )
    generation_params = dict(params)
    generation_params.setdefault("prompt", prompt)
    generation_params.setdefault("text", prompt)
    return create_generation_job(
        background_tasks, placeholder, generation_params, collection, output_kind, model_id,
    )


def create_from_none_job(
    background_tasks: BackgroundTasks,
    params: dict,
    collection: str = "Default",
    output_kind: str = "mesh",
    model_id: Optional[str] = None,
) -> JobStatus:
    if model_id is not None:
        model_id = require_model_input(model_id, "none")
    return create_generation_job(
        background_tasks, b"", params, collection, output_kind, model_id,
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
    with _log_lock:
        job = require_job(job_id)

        if job.status not in ("pending", "running"):
            return job

        _cancelled.add(job_id)

        cancel_event = _cancel_events.get(job_id)
        if cancel_event is not None:
            cancel_event.set()

        job.status = "cancelled"
        _completed_at[job_id] = time.monotonic()
        _log_job_progress(job)
        gen = _job_generators.get(job_id)

    try:
        # Queued cancellation must never kill the generator owned by another job.
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


def validate_model_id(model_id: str) -> dict:
    try:
        generator_registry.get_generator(model_id)
        return generator_registry.get_manifest(model_id)
    except (KeyError, ValueError) as exc:
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


def get_workspace_path(output_path: Path) -> Optional[str]:
    try:
        return output_path.resolve().relative_to(registry.WORKSPACE_DIR.resolve()).as_posix()
    except ValueError:
        return None


def build_output_url(output_path: Path, collection: str = "Default") -> str:
    workspace_path = get_workspace_path(output_path)
    if workspace_path is not None:
        return f"/workspace/{workspace_path}"

    return f"/workspace/{collection}/{output_path.name}"


def build_scene_candidate(output_path: Optional[Path], collection: str = "Default") -> Optional[SceneCandidate]:
    if output_path is None:
        return None

    workspace_path = get_workspace_path(output_path)
    if workspace_path is None:
        return None

    output_url = build_output_url(output_path, collection)
    return SceneCandidate(
        kind=detect_output_kind(output_path) or "mesh",
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

    return isinstance(manifest, dict) and manifest.get("schema") == "modly.scene-manifest.v1"


def detect_output_kind(output_path: Optional[Path]) -> Optional[str]:
    if output_path is None:
        return None

    suffix = output_path.suffix.lower()
    if suffix == ".json" and is_scene_manifest_path(output_path):
        return "scene"

    if suffix in MESH_OUTPUT_SUFFIXES:
        return "mesh"

    if suffix in IMAGE_OUTPUT_SUFFIXES:
        return "image"

    if suffix in VIDEO_OUTPUT_SUFFIXES:
        return "video"

    if suffix in AUDIO_OUTPUT_SUFFIXES:
        return "audio"

    return None


async def _run_generation(
    job_id: str,
    model_input: Union[bytes, Path, TypedArtifactInput],
    params: dict,
    collection: str = "Default",
    output_kind: str = "mesh",
    model_id: Optional[str] = None,
) -> None:
    # Pinned jobs share one model lifecycle. Switching is deliberately deferred
    # until this job runs on the dedicated worker: request-time switches can
    # otherwise unload a running job or leave A loading beside B.  Crucially,
    # queued jobs are executor work items rather than default-executor threads
    # blocked on a lock, so cancelling a waiter cannot orphan queue ownership or
    # starve the worker that performs generation.
    loop = asyncio.get_running_loop()
    executor = _pinned_generation_executor if model_id is not None else None
    # Shown while this job waits behind another one on the single worker;
    # _run_generation_impl clears it as soon as the job actually starts.
    with _log_lock:
        queued_job = _jobs.get(job_id)
        if queued_job is not None and executor is not None and queued_job.status == "pending":
            queued_job.step = "Waiting for the previous generation…"
            _log_job_progress(queued_job)
    future = loop.run_in_executor(
        executor,
        _run_generation_impl,
        job_id,
        model_input,
        params,
        collection,
        output_kind,
        model_id,
    )
    try:
        await future
    except asyncio.CancelledError:
        # asyncio cancellation attempts to cancel a queued concurrent future.
        # If it has already begun, the event lets the generator stop safely.
        with _log_lock:
            job = _jobs.get(job_id)
            if job is queued_job and job is not None and job.status in ("pending", "running"):
                _cancelled.add(job_id)
                cancel_event = _cancel_events.get(job_id)
                if cancel_event is not None:
                    cancel_event.set()
                job.status = "cancelled"
                _completed_at[job_id] = time.monotonic()
                _log_job_progress(job)
        raise


def _run_generation_impl(
    job_id: str,
    model_input: Union[bytes, Path, TypedArtifactInput],
    params: dict,
    collection: str,
    output_kind: str,
    model_id: Optional[str],
) -> None:
    with _log_lock:
        job = _jobs.get(job_id)
        if job is None or job.status != "pending" or job_id in _cancelled:
            return
        job.status = "running"
        job.step = None
        _log_job_progress(job)

    def progress_cb(pct: int, step: str = "") -> None:
        if job.status != "running":
            return
        # Monotonic: the loading phase walks the bar up on a background thread and
        # extensions then report their own 0->100 scale, so an unguarded assignment
        # yanks the bar backwards on the first generation progress message.
        if pct > job.progress:
            next_progress = pct
        else:
            next_progress = job.progress
        with _log_lock:
            # Cancellation/retirement may have won after the optimistic read.
            if _jobs.get(job_id) is not job or job.status != "running":
                return
            job.progress = max(job.progress, next_progress)
            if step:
                job.step = step
            _log_job_progress(job)

    try:
        # Refuse a selected weight variant that is not installed before loading
        # anything. Uses the job's model: the switch to it happens below.
        generator_registry.assert_weight_variant_installed(params, model_id)

        # Check if the model needs to be loaded BEFORE calling the generator
        # getter, because that call can load the model in a blocking manner.
        get_generator = (lambda: generator_registry.activate_ready_generator(model_id)) \
            if model_id is not None else generator_registry.get_active
        if model_id is not None:
            pinned_generator = generator_registry.get_generator(model_id)
            with _log_lock:
                if _jobs.get(job_id) is not job or job.status != "running":
                    return
                _job_generators[job_id] = pinned_generator
        status_reader = (lambda: generator_registry.model_status(model_id)) \
            if model_id is not None else generator_registry.active_status
        status = status_reader()
        if not status["loaded"]:
            active = status
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
                gen = get_generator()
            finally:
                stop_load_evt.set()
        else:
            gen = get_generator()

        with _log_lock:
            if _jobs.get(job_id) is not job or job.status != "running":
                return
            _job_generators[job_id] = gen

        # Direct output to the collection subfolder
        coll_dir = registry.WORKSPACE_DIR / collection
        coll_dir.mkdir(parents=True, exist_ok=True)
        gen.outputs_dir = coll_dir

        cancel_event = _cancel_events.get(job_id)
        if isinstance(model_input, TypedArtifactInput):
            # Revalidate just before crossing the inference boundary. The
            # subprocess runner repeats this check inside the worker.
            from services.artifact_input import revalidate_artifact_input
            model_input = revalidate_artifact_input(registry.WORKSPACE_DIR, model_input)
            supports_cancel = "cancel_event" in inspect.signature(gen.generate_artifact).parameters
            output_path = (
                gen.generate_artifact(model_input.kind, model_input.path, params, progress_cb, cancel_event)
                if supports_cancel
                else gen.generate_artifact(model_input.kind, model_input.path, params, progress_cb)
            )
        else:
            supports_cancel = "cancel_event" in inspect.signature(gen.generate).parameters
            output_path = (
                gen.generate(model_input, params, progress_cb, cancel_event)
                if supports_cancel
                else gen.generate(model_input, params, progress_cb)
            )

        if job_id in _cancelled:
            return

        output_path = Path(output_path).resolve(strict=True)
        if output_kind == "scene":
            from services.scene_input import validate_scene_input
            try:
                output_relative = output_path.relative_to(registry.WORKSPACE_DIR.resolve())
                output_path = validate_scene_input(registry.WORKSPACE_DIR, output_relative.as_posix())
            except (OSError, ValueError) as exc:
                raise ValueError("Generated scene output is not a valid workspace scene") from exc

        output_url = build_output_url(output_path, collection)
        # The private candidate is a mesh insertion descriptor, not a generic
        # artifact wrapper: scene/image/audio outputs retain only their URL.
        scene_candidate = build_scene_candidate(output_path, collection) if output_kind == "mesh" else None
        with _log_lock:
            if _jobs.get(job_id) is not job or job.status != "running":
                return
            job.status = "done"
            job.progress = 100
            _completed_at[job_id] = time.monotonic()
            job.output_url = output_url
            job.output_kind = detect_output_kind(output_path)
            job.scene_candidate = scene_candidate
            _log_job_progress(job)

    except GenerationCancelled:
        with _log_lock:
            if _jobs.get(job_id) is job and job.status == "running":
                job.status = "cancelled"
                _completed_at[job_id] = time.monotonic()
                _log_job_progress(job)
    except Exception:
        tb = traceback.format_exc()
        with _log_lock:
            if _jobs.get(job_id) is job and job.status == "running":
                job.status = "error"
                job.error = tb.strip()
                _completed_at[job_id] = time.monotonic()
                _log_job_progress(job)
    finally:
        with _log_lock:
            if _jobs.get(job_id) is job:
                _job_generators.pop(job_id, None)
