from fastapi import APIRouter, File, Form, UploadFile, HTTPException, BackgroundTasks

import services.generator_registry as registry
from schemas.generation import (
    GenerateFromArtifactRequest,
    GenerateFromNoneRequest,
    GenerateFromSceneRequest,
    GenerateFromTextRequest,
    GenerateFromVideoRequest,
)
from services.artifact_input import RESERVED_ARTIFACT_PARAMS, validate_artifact_input
from services.generation_inputs import GenerationInputPathError, resolve_workspace_video_input_path
from services.generation_jobs import (
    VALID_REMESH_MODES,
    ImageRequestBudget,
    cancel_job as cancel_generation_job,
    create_from_image_job,
    create_from_none_job,
    create_from_text_job,
    create_from_video_job,
    create_generation_job,
    get_job_status,
    get_workspace_dir,
    extract_declared_legacy_image_transports,
    extract_legacy_extra_image_paths,
    inject_trusted_host_transport_params,
    parse_params_object,
    sanitize_collection,
    read_validated_image_upload,
    sanitize_collection_name,
    snapshot_legacy_secondary_images,
    snapshot_declared_legacy_image_transports,
    validate_client_generation_params,
    validate_host_mesh_path,
    validate_secondary_image_metadata,
    validate_primary_image_metadata,
    reject_host_image_transport_params,
    validate_image_upload,
    validate_model_id,
    require_model_id,
    require_model_input,
)
from services.capture_input import validate_capture_input
from services.scene_input import validate_scene_input

router = APIRouter(tags=["generation"])


@router.post("/from-image")
async def generate_from_image(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    secondary_image: list[UploadFile] | None = File(None),
    secondary_image_slot: list[int] | None = Form(None),
    secondary_image_handle: list[str] | None = Form(None),
    primary_image_slot: int | None = Form(None),
    primary_image_handle: str | None = Form(None),
    mesh_path: str | None = Form(None),
    model_id: str = Form("sf3d"),
    collection: str = Form("Default"),
    remesh: str = Form("quad"),
    enable_texture: bool = Form(False),
    texture_resolution: int = Form(1024),
    params: str = Form("{}"),
):
    validate_image_upload(image)

    if remesh not in VALID_REMESH_MODES:
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    # Sanitize collection name: strip, forbid path separators and special chars
    collection = sanitize_collection(collection)

    model_id = require_model_id(model_id)
    manifest = validate_model_id(model_id)
    model_params, legacy_paths, legacy_paths_present = extract_legacy_extra_image_paths(
        parse_params_object(params, strict=False)
    )
    validate_primary_image_metadata(model_id, primary_image_slot, primary_image_handle)
    reject_host_image_transport_params(model_id, model_params)
    model_params, raw_declared_image_transports = extract_declared_legacy_image_transports(
        model_id, model_params
    )
    mesh_input_path = (
        validate_host_mesh_path(model_id, mesh_path)
        if mesh_path is not None
        else None
    )

    secondary_uploads = secondary_image or []
    secondary_slots = secondary_image_slot or []
    secondary_handles = secondary_image_handle or []
    if not (
        len(secondary_uploads) == len(secondary_slots) == len(secondary_handles)
    ):
        raise HTTPException(
            400,
            "secondary_image, secondary_image_slot, and secondary_image_handle counts must match",
        )
    if legacy_paths_present and secondary_uploads:
        raise HTTPException(
            400,
            "legacy extra_image_paths must not be combined with multipart secondary images",
        )
    validate_secondary_image_metadata(
        model_id, secondary_slots, secondary_handles,
        primary_image_slot=primary_image_slot, primary_image_handle=primary_image_handle,
    )

    model_params = validate_client_generation_params(
        model_id, model_params, extra_server_managed=frozenset({"mesh_path"})
    )
    image_budget = ImageRequestBudget()
    image_bytes, _primary_suffix = await read_validated_image_upload(image, image_budget)
    staged_secondary_images: list[tuple[int, str, bytes, str]] = []
    for upload, slot, handle in zip(
        secondary_uploads, secondary_slots, secondary_handles, strict=True
    ):
        data, suffix = await read_validated_image_upload(upload, image_budget)
        staged_secondary_images.append((slot, handle, data, suffix))
    if legacy_paths_present:
        staged_secondary_images = snapshot_legacy_secondary_images(
            model_id, legacy_paths, image_budget,
            primary_image_slot=primary_image_slot, primary_image_handle=primary_image_handle,
        )
    legacy_image_transports = snapshot_declared_legacy_image_transports(
        model_id, raw_declared_image_transports, image_budget
    )
    full_params = {
        "remesh": remesh,
        "enable_texture": enable_texture,
        "texture_resolution": texture_resolution,
        **model_params,
    }
    job = create_from_image_job(
        background_tasks, image_bytes, full_params, collection,
        manifest.get("output", "mesh"), model_id,
        secondary_images=staged_secondary_images,
        legacy_image_transports=legacy_image_transports,
        mesh_input_path=mesh_input_path,
        primary_image_slot=primary_image_slot,
        primary_image_handle=primary_image_handle,
    )
    return {"job_id": job.job_id}


@router.post("/from-video")
async def generate_from_video(
    payload: GenerateFromVideoRequest,
    background_tasks: BackgroundTasks,
):
    if payload.remesh not in ("quad", "triangle", "none"):
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    collection = sanitize_collection(payload.collection)
    model_id = require_model_input(payload.model_id, "video")
    manifest = validate_model_id(model_id)

    full_params = {
        "remesh": payload.remesh,
        "enable_texture": payload.enable_texture,
        "texture_resolution": payload.texture_resolution,
        **payload.params,
    }

    try:
        resolved_video_path = resolve_workspace_video_input_path(
            payload.video_path,
            workspace_dir=get_workspace_dir(),
        )
    except GenerationInputPathError as exc:
        raise HTTPException(400, str(exc)) from exc

    job = create_from_video_job(
        background_tasks,
        resolved_video_path,
        full_params,
        collection,
        manifest.get("output", "mesh"),
        model_id,
    )

    return {"job_id": job.job_id}


@router.post("/from-text")
async def generate_from_text(payload: GenerateFromTextRequest, background_tasks: BackgroundTasks):
    prompt = payload.prompt.strip()
    if not prompt:
        raise HTTPException(400, "prompt is required")
    if payload.remesh not in VALID_REMESH_MODES:
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")
    model_id = require_model_id(payload.model_id)
    manifest = validate_model_id(model_id)
    full_params = {
        "remesh": payload.remesh,
        "enable_texture": payload.enable_texture,
        "texture_resolution": payload.texture_resolution,
        **payload.params,
    }
    job = create_from_text_job(
        background_tasks, prompt, full_params, payload.collection,
        manifest.get("output", "mesh"), model_id,
    )
    return {"job_id": job.job_id}


@router.post("/from-artifact")
async def generate_from_artifact(
    request: GenerateFromArtifactRequest,
    background_tasks: BackgroundTasks,
):
    """Queue a validated typed artifact without serializing it as image bytes."""
    manifest = validate_model_id(request.model_id)
    from services.capture_input import _iter_declared_input_types
    declared = list(_iter_declared_input_types(manifest))
    if request.input_kind not in declared:
        raise HTTPException(400, f"Model {request.model_id} does not accept {request.input_kind} input")
    try:
        artifact = validate_artifact_input(registry.WORKSPACE_DIR, request.input_kind, request.input_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    if artifact.kind in ("capture", "video"):
        validated_params = validate_client_generation_params(
            request.model_id, request.params,
            extra_server_managed=RESERVED_ARTIFACT_PARAMS | frozenset({"mesh_path"}),
        )
    else:
        validated_params = request.params

    # The compatibility route historically exposed input_scene_path too. Strip
    # that transport alias on both routes; only the validated typed input owns it.
    params = {
        k: v for k, v in validated_params.items()
        if k not in RESERVED_ARTIFACT_PARAMS and k != "input_scene_path"
    }
    params = {"remesh": request.remesh, "enable_texture": request.enable_texture,
              "texture_resolution": request.texture_resolution, **params}
    if artifact.kind in ("scene", "capture"):
        params[f"{artifact.kind}_manifest_path"] = str(artifact.path)
    job = create_generation_job(
        background_tasks, artifact, params, request.collection,
        manifest.get("output", "mesh"), request.model_id,
    )
    return {"job_id": job.job_id}


@router.post("/from-none")
async def generate_from_none(
    payload: GenerateFromNoneRequest,
    background_tasks: BackgroundTasks,
):
    if payload.remesh not in ("quad", "triangle", "none"):
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    collection = sanitize_collection(payload.collection)
    model_id = require_model_input(payload.model_id, "none")
    manifest = validate_model_id(model_id)

    full_params = {
        "remesh": payload.remesh,
        "enable_texture": payload.enable_texture,
        "texture_resolution": payload.texture_resolution,
        **payload.params,
    }

    job = create_from_none_job(
        background_tasks,
        full_params,
        collection,
        manifest.get("output", "mesh"),
        model_id,
    )
    return {"job_id": job.job_id}


@router.post("/from-scene")
async def generate_from_scene(payload: GenerateFromSceneRequest, background_tasks: BackgroundTasks):
    """Adapt the legacy scene request to the authoritative typed-artifact route."""
    if payload.remesh not in VALID_REMESH_MODES:
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")
    return await generate_from_artifact(GenerateFromArtifactRequest(
        input_kind="scene",
        input_path=payload.scene_path,
        model_id=payload.model_id.strip(),
        collection=payload.collection,
        params={
            "remesh": payload.remesh,
            "enable_texture": payload.enable_texture,
            "texture_resolution": payload.texture_resolution,
            **payload.params,
        },
    ), background_tasks)


@router.get("/status/{job_id}")
async def job_status(job_id: str):
    return get_job_status(job_id)


@router.post("/cancel/{job_id}")
async def cancel_job(job_id: str):
    cancel_generation_job(job_id)
    return {"cancelled": True}
