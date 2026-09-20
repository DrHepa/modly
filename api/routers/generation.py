import asyncio
import json
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Dict
from fastapi import APIRouter, File, Form, UploadFile, HTTPException, BackgroundTasks
from services.generators.base import smooth_progress, GenerationCancelled

import re as _re
# Import the module (not the name) so WORKSPACE_DIR is read at call time: the
# settings endpoint rebinds it when the user relocates the workspace, and a
# binding captured at import would keep writing output to the old directory.
import services.generator_registry as registry
from services.generator_registry import generator_registry
from schemas.generation import JobStatus, GenerateFromArtifactRequest, GenerateFromSceneRequest
from services.capture_input import TypedModelInput, revalidate_typed_model_input, validate_capture_input
from services.scene_input import validate_scene_input
from services.generation_lifecycle import (
    ExecutionReservation as _ExecutionReservation,
    generation_lifecycle,
)

router = APIRouter(tags=["generation"])

# Shared with workflow_runs.create_run_from_image so the two endpoints can't drift apart on
# what counts as a valid remesh mode the way they had drifted on `collection` before #238.
VALID_REMESH_MODES = ("quad", "triangle", "none")

_jobs: Dict[str, JobStatus] = {}
_cancelled: set = set()
_cancel_events: Dict[str, threading.Event] = {}
_completed_at: Dict[str, float] = {}
_job_execution_tokens = generation_lifecycle.tokens
_job_execution_targets = generation_lifecycle.targets
_job_reservations = generation_lifecycle.reservations

_JOB_TTL = 1800  # purge terminal jobs after 30 minutes


def _purge_old_jobs() -> None:
    cutoff = time.monotonic() - _JOB_TTL
    stale = [jid for jid, t in _completed_at.items() if t < cutoff]
    for jid in stale:
        _jobs.pop(jid, None)
        _cancelled.discard(jid)
        _cancel_events.pop(jid, None)
        _completed_at.pop(jid, None)
        generation_lifecycle.forget(jid)


def _register_job_execution(
    job_id: str,
    model_id: str | None = None,
    generator: object | None = None,
) -> str:
    if generator is None:
        active_id = getattr(generator_registry, "_active_id", None)
        generators = getattr(generator_registry, "_generators", None)
        generator = generators.get(active_id) if isinstance(generators, dict) else None
        model_id = model_id or active_id
        if generator is None:
            generator = generator_registry.get_active()
    return generation_lifecycle.register(job_id, model_id, generator)


async def _reserve_execution(job_id: str) -> _ExecutionReservation:
    if job_id not in _job_execution_tokens:
        _register_job_execution(job_id)
    return await generation_lifecycle.reserve(job_id)


def _release_execution(reservation: _ExecutionReservation) -> None:
    generation_lifecycle.release(reservation)


def _owned_generator(job_id: str) -> object | None:
    return generation_lifecycle.owned_generator(job_id)


def _stop_owned_execution(job_id: str) -> bool:
    return generation_lifecycle.request_cancel(job_id)


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

    if remesh not in VALID_REMESH_MODES:
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    collection = sanitize_collection(collection)

    # Verify the requested model exists in the registry
    try:
        requested_generator = generator_registry.get_generator(model_id)
    except ValueError as e:
        raise HTTPException(400, str(e))

    try:
        generator_registry.switch_model(model_id)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(409 if isinstance(exc, RuntimeError) else 400, str(exc)) from exc

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
    _register_job_execution(job_id, model_id, requested_generator)

    background_tasks.add_task(_run_generation, job_id, image_bytes, full_params, collection)

    return {"job_id": job_id}


@router.post("/from-scene")
async def generate_from_scene(payload: GenerateFromSceneRequest, background_tasks: BackgroundTasks):
    if payload.remesh not in VALID_REMESH_MODES:
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")
    try:
        manifest = generator_registry.get_manifest(payload.model_id)
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc
    if manifest.get("input", "image") != "scene":
        raise HTTPException(400, "Model does not accept scene input")
    try:
        scene_manifest = validate_scene_input(registry.WORKSPACE_DIR, payload.scene_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    collection = sanitize_collection(payload.collection)
    try:
        requested_generator = generator_registry.get_generator(payload.model_id)
        generator_registry.switch_model(payload.model_id)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(409 if isinstance(exc, RuntimeError) else 400, str(exc)) from exc
    # Caller params never gain authority over the validated source path.
    full_params = {
        **{k: v for k, v in payload.params.items()
           if k not in {"scene_manifest_path", "scene_path", "input_scene_path"}},
        "remesh": payload.remesh,
        "enable_texture": payload.enable_texture,
        "texture_resolution": payload.texture_resolution,
        "scene_manifest_path": str(scene_manifest),
    }
    job_id = str(uuid.uuid4())
    _purge_old_jobs()
    _jobs[job_id] = JobStatus(job_id=job_id, status="pending", progress=0)
    _cancel_events[job_id] = threading.Event()
    _register_job_execution(job_id, payload.model_id, requested_generator)
    background_tasks.add_task(_run_generation, job_id, scene_manifest, full_params, collection)
    return {"job_id": job_id}


@router.post("/from-artifact")
async def generate_from_artifact(payload: GenerateFromArtifactRequest, background_tasks: BackgroundTasks):
    """Run a model with a validated workspace artifact while preserving legacy routes."""
    if payload.remesh not in VALID_REMESH_MODES:
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")
    try:
        manifest = generator_registry.get_manifest(payload.model_id)
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc
    if manifest.get("input", "image") != payload.input_kind:
        raise HTTPException(400, f"Model does not accept {payload.input_kind} input")
    try:
        artifact_path = (
            validate_capture_input(registry.WORKSPACE_DIR, payload.input_path)
            if payload.input_kind == "capture"
            else validate_scene_input(registry.WORKSPACE_DIR, payload.input_path)
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    collection = sanitize_collection(payload.collection)
    try:
        requested_generator = generator_registry.get_generator(payload.model_id)
        generator_registry.switch_model(payload.model_id)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(409 if isinstance(exc, RuntimeError) else 400, str(exc)) from exc
    reserved = {
        "scene_manifest_path", "scene_path", "input_scene_path",
        "capture_manifest_path", "capture_path", "input_capture_path",
        "typed_input_kind", "typed_input_path",
    }
    full_params = {
        **{key: value for key, value in payload.params.items() if key not in reserved},
        "remesh": payload.remesh,
        "enable_texture": payload.enable_texture,
        "texture_resolution": payload.texture_resolution,
        f"{payload.input_kind}_manifest_path": str(artifact_path),
    }
    job_id = str(uuid.uuid4())
    _purge_old_jobs()
    _jobs[job_id] = JobStatus(job_id=job_id, status="pending", progress=0)
    _cancel_events[job_id] = threading.Event()
    _register_job_execution(job_id, payload.model_id, requested_generator)
    background_tasks.add_task(
        _run_generation,
        job_id,
        TypedModelInput(payload.input_kind, artifact_path),
        full_params,
        collection,
    )
    return {"job_id": job_id}



@router.get("/status/{job_id}")
async def job_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return job


@router.post("/cancel/{job_id}")
async def cancel_job(job_id: str):
    return await cancel_generation_job(job_id)


def _signal_job_cancellation(job_id: str) -> None:
    """Mark and stop one job without releasing its execution reservation."""
    job = _jobs.get(job_id)
    if job is None:
        return
    _cancelled.add(job_id)
    if job_id in _cancel_events:
        _cancel_events[job_id].set()
    reservation_active = job_id in _job_reservations
    if job.status in ("pending", "running"):
        job.status = "cancelled"
    # Jobs which do not own a reservation cannot have a subprocess. They are
    # terminal immediately. Active jobs are stamped only by _run_generation's
    # finalizer after their owned load/process has actually stopped.
    if not reservation_active:
        _completed_at[job_id] = time.monotonic()
    # Kill the active generator subprocess immediately so inference stops now.
    # _run_generation will catch the resulting exception, see job_id in _cancelled,
    # and return cleanly without setting an error status.
    try:
        _stop_owned_execution(job_id)
    except Exception:
        pass


async def cancel_generation_job(job_id: str) -> dict:
    """Canonical token-owned cancellation used by every HTTP surface."""
    if job_id not in _jobs:
        raise HTTPException(404, f"Job {job_id} not found")
    _signal_job_cancellation(job_id)
    return {"cancelled": True}


def _requested_status(reservation: _ExecutionReservation) -> dict:
    target = reservation.target
    if target.model_id is not None and hasattr(generator_registry, "requested_status"):
        return generator_registry.requested_status(target.model_id, target.generator)
    generator = target.generator
    loaded = generator.is_loaded() if hasattr(generator, "is_loaded") else True
    return {
        "name": getattr(generator, "DISPLAY_NAME", target.model_id or "model"),
        # Test/legacy registries do not own the manifest/source closure needed
        # for a meaningful download check. Real GeneratorRegistry above does.
        "downloaded": True,
        "loaded": loaded,
    }


def _load_requested(reservation: _ExecutionReservation) -> object:
    target = reservation.target
    if target.model_id is not None and hasattr(generator_registry, "get_requested"):
        return generator_registry.get_requested(target.model_id, target.generator)
    generator = target.generator
    if hasattr(generator, "is_loaded") and not generator.is_loaded():
        generator.load()
    return generator


async def _run_blocking(function, *args, on_cancel=None):
    """Run blocking extension work without relying on a fork-sensitive wake fd.

    Extension loading may spawn a subprocess from this worker. On some POSIX
    event loops that can lose the executor completion wake byte until another
    timer fires. A small event poll keeps the API loop responsive and leaves
    the blocking operation off the event-loop thread.
    """
    done = threading.Event()
    result: list[object] = []
    error: list[BaseException] = []

    def invoke() -> None:
        try:
            result.append(function(*args))
        except BaseException as exc:
            error.append(exc)
        finally:
            done.set()

    worker = threading.Thread(target=invoke, daemon=False)
    worker.start()

    async def wait_until_exited() -> None:
        while not done.is_set():
            await asyncio.sleep(0.01)

    completion = asyncio.create_task(wait_until_exited())
    try:
        # Shield the completion observer so cancellation of the request task
        # cannot detach the blocking worker from its generator reservation.
        await asyncio.shield(completion)
    except asyncio.CancelledError:
        if on_cancel is not None:
            on_cancel()
        # Repeated cancellation must not release the lease early. Keep the
        # cleanup task shielded until the owned worker has actually returned.
        while not completion.done():
            try:
                await asyncio.shield(completion)
            except asyncio.CancelledError:
                continue
        worker.join()
        raise

    worker.join()
    if error:
        raise error[0]
    return result[0]


async def _run_generation(job_id: str, image_bytes: bytes | Path | TypedModelInput, params: dict, collection: str = "Default") -> None:
    job = _jobs[job_id]
    if job_id in _cancelled:
        job.status = "cancelled"
        _completed_at.setdefault(job_id, time.monotonic())
        return
    job.status = "running"
    reservation: _ExecutionReservation | None = None

    def progress_cb(pct: float, step: str = "") -> None:
        # Monotonic: the loading phase walks the bar up on a background thread and
        # extensions then report their own 0->100 scale, so an unguarded assignment
        # yanks the bar backwards on the first generation progress message.
        if pct > job.progress:
            job.progress = pct
        if step:
            job.step = step

    try:
        reservation = await _reserve_execution(job_id)
        if job_id in _cancelled:
            return

        # Check if the model needs to be loaded BEFORE calling get_active(),
        # because get_active() loads the model in a blocking manner.
        # active_status() is an instantaneous operation (simple dict lookup).
        active = _requested_status(reservation)
        if not active["loaded"]:
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
                gen = await _run_blocking(
                    _load_requested,
                    reservation,
                    on_cancel=lambda: _signal_job_cancellation(job_id),
                )
            finally:
                stop_load_evt.set()
        else:
            gen = await _run_blocking(
                _load_requested,
                reservation,
                on_cancel=lambda: _signal_job_cancellation(job_id),
            )

        if job_id in _cancelled:
            _stop_owned_execution(job_id)
            return

        # Direct output to the collection subfolder
        coll_dir = registry.WORKSPACE_DIR / collection
        coll_dir.mkdir(parents=True, exist_ok=True)
        gen.outputs_dir = coll_dir

        cancel_event = _cancel_events.get(job_id)
        import inspect
        supports_cancel = "cancel_event" in inspect.signature(gen.generate).parameters
        if isinstance(image_bytes, TypedModelInput):
            image_bytes = revalidate_typed_model_input(registry.WORKSPACE_DIR, image_bytes)
        elif isinstance(image_bytes, Path):
            image_bytes = validate_scene_input(
                registry.WORKSPACE_DIR,
                image_bytes.resolve().relative_to(registry.WORKSPACE_DIR.resolve()).as_posix(),
            )
        output_path = await _run_blocking(
            lambda: gen.generate(image_bytes, params, progress_cb, cancel_event)
            if supports_cancel
            else gen.generate(image_bytes, params, progress_cb),
            on_cancel=lambda: _signal_job_cancellation(job_id),
        )

        if job_id in _cancelled:
            return

        job.status   = "done"
        job.progress = 100
        _completed_at[job_id] = time.monotonic()
        try:
            rel = output_path.relative_to(registry.WORKSPACE_DIR)
            job.output_url = f"/workspace/{rel.as_posix()}"
        except ValueError:
            job.output_url = f"/workspace/{collection}/{output_path.name}"

    except asyncio.CancelledError:
        _signal_job_cancellation(job_id)
        job.status = "cancelled"
        _completed_at[job_id] = time.monotonic()
        raise
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
    finally:
        if reservation is not None:
            if job_id in _cancelled:
                _stop_owned_execution(job_id)
                job.status = "cancelled"
                _completed_at[job_id] = time.monotonic()
            _release_execution(reservation)
