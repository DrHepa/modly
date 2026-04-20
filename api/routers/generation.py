from fastapi import APIRouter, File, Form, UploadFile, HTTPException, BackgroundTasks

import services.generator_registry as registry
from schemas.generation import GenerateFromArtifactRequest, GenerateFromTextRequest
from services.artifact_input import RESERVED_ARTIFACT_PARAMS, validate_artifact_input
from services.generation_jobs import (
    VALID_REMESH_MODES,
    cancel_job as cancel_generation_job,
    create_from_image_job,
    create_from_text_job,
    create_generation_job,
    get_job_status,
    parse_params_object,
    sanitize_collection,
    validate_image_upload,
    validate_model_id,
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
    manifest = validate_model_id(payload.model_id)
    full_params = {
        "remesh": payload.remesh,
        "enable_texture": payload.enable_texture,
        "texture_resolution": payload.texture_resolution,
        **payload.params,
    }
    job = create_from_text_job(
        background_tasks, prompt, full_params, payload.collection,
        manifest.get("output", "mesh"), payload.model_id,
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

    params = {k: v for k, v in request.params.items() if k not in RESERVED_ARTIFACT_PARAMS}
    params["scene_manifest_path"] = str(artifact.path)
    job = create_generation_job(
        background_tasks, artifact, params, request.collection,
        manifest.get("output", "mesh"), request.model_id,
    )
    return {"job_id": job.job_id}


@router.get("/status/{job_id}")
async def job_status(job_id: str):
    return get_job_status(job_id)


@router.post("/cancel/{job_id}")
async def cancel_job(job_id: str):
    cancel_generation_job(job_id)
    return {"cancelled": True}
