from fastapi import APIRouter, File, Form, UploadFile, HTTPException, BackgroundTasks

import services.generator_registry as registry
from schemas.generation import (
    GenerateFromArtifactRequest,
    GenerateFromNoneRequest,
    GenerateFromSceneRequest,
    GenerateFromTextRequest,
)
from services.artifact_input import RESERVED_ARTIFACT_PARAMS, validate_artifact_input
from services.generation_jobs import (
    VALID_REMESH_MODES,
    cancel_job as cancel_generation_job,
    create_from_image_job,
    create_from_none_job,
    create_from_text_job,
    create_generation_job,
    get_job_status,
    parse_params_object,
    sanitize_collection,
    validate_image_upload,
    validate_model_id,
    require_model_input,
)

router = APIRouter(tags=["generation"])


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
    validate_image_upload(image)

    if remesh not in VALID_REMESH_MODES:
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    collection = sanitize_collection(collection)
    model_id = require_model_input(model_id, "image")
    manifest = validate_model_id(model_id)
    model_params = parse_params_object(params, strict=False)
    image_bytes = await image.read()
    full_params = {
        "remesh": remesh,
        "enable_texture": enable_texture,
        "texture_resolution": texture_resolution,
        **model_params,
    }
    job = create_from_image_job(
        background_tasks, image_bytes, full_params, collection,
        manifest.get("output", "mesh"), model_id,
    )
    return {"job_id": job.job_id}


@router.post("/from-text")
async def generate_from_text(payload: GenerateFromTextRequest, background_tasks: BackgroundTasks):
    prompt = payload.prompt.strip()
    if not prompt:
        raise HTTPException(400, "prompt is required")
    if payload.remesh not in VALID_REMESH_MODES:
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")
    model_id = require_model_input(payload.model_id, "text")
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
    declared = manifest.get("inputs") or [manifest.get("input", "image")]
    if request.input_kind not in declared:
        raise HTTPException(400, f"Model {request.model_id} does not accept {request.input_kind} input")
    try:
        artifact = validate_artifact_input(registry.WORKSPACE_DIR, request.input_kind, request.input_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    # The compatibility route historically exposed input_scene_path too. Strip
    # that transport alias on both routes; only the validated typed input owns it.
    params = {
        k: v for k, v in request.params.items()
        if k not in RESERVED_ARTIFACT_PARAMS and k != "input_scene_path"
    }
    params["scene_manifest_path"] = str(artifact.path)
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
