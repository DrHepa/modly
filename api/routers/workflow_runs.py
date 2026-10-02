from typing import Optional

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Response, UploadFile, status

from schemas.generation import GenerateFromSceneRequest, GenerateFromTextRequest
from schemas.workflow_runs import WorkflowRunAccepted, WorkflowRunCancelResponse, WorkflowRunStatus
from services.generation_jobs import (
    VALID_REMESH_MODES,
    ImageRequestBudget,
    cancel_job,
    create_from_image_job,
    create_from_none_job,
    create_from_text_job,
    get_job_status,
    extract_declared_legacy_image_transports,
    extract_legacy_extra_image_paths,
    inject_trusted_host_transport_params,
    parse_params_object,
    sanitize_collection,
    require_model_id,
    require_model_input,
    validate_model_id,
    validate_image_upload,
    read_validated_image_upload,
    snapshot_legacy_secondary_images,
    snapshot_declared_legacy_image_transports,
    validate_host_mesh_path,
    validate_secondary_image_metadata,
    validate_primary_image_metadata,
    reject_host_image_transport_params,
)

router = APIRouter(tags=["workflow-runs"])


@router.post("/from-image", response_model=WorkflowRunAccepted, status_code=status.HTTP_202_ACCEPTED)
async def create_from_image_run(
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
    params: Optional[str] = Form(None),
):
    validate_image_upload(image)

    model_id = require_model_id(model_id)
    manifest = validate_model_id(model_id)
    model_params, legacy_paths, legacy_paths_present = extract_legacy_extra_image_paths(
        parse_params_object(params, strict=True)
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
    image_budget = ImageRequestBudget()
    image_bytes, _suffix = await read_validated_image_upload(image, image_budget)
    secondary_images: list[tuple[int, str, bytes, str]] = []
    for upload, slot, handle in zip(
        secondary_uploads, secondary_slots, secondary_handles, strict=True
    ):
        data, suffix = await read_validated_image_upload(upload, image_budget)
        secondary_images.append((slot, handle, data, suffix))
    if legacy_paths_present:
        secondary_images = snapshot_legacy_secondary_images(
            model_id, legacy_paths, image_budget,
            primary_image_slot=primary_image_slot, primary_image_handle=primary_image_handle,
        )
    legacy_image_transports = snapshot_declared_legacy_image_transports(
        model_id, raw_declared_image_transports, image_budget
    )
    full_params = {
        "remesh": "quad", "enable_texture": False, "texture_resolution": 1024,
        **model_params,
    }
    if full_params["remesh"] not in VALID_REMESH_MODES:
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")
    collection = sanitize_collection(collection)
    job = create_from_image_job(
        background_tasks, image_bytes, full_params, collection,
        manifest.get("output", "mesh"), model_id,
        secondary_images=secondary_images,
        legacy_image_transports=legacy_image_transports,
        mesh_input_path=mesh_input_path,
        primary_image_slot=primary_image_slot,
        primary_image_handle=primary_image_handle,
    )
    return WorkflowRunAccepted.from_job(job)


@router.post("/from-none", response_model=WorkflowRunAccepted, status_code=status.HTTP_202_ACCEPTED)
async def create_from_none_run(
    background_tasks: BackgroundTasks,
    model_id: str = Form(...),
    params: Optional[str] = Form(None),
):
    model_id = require_model_input(model_id, "none")
    manifest = validate_model_id(model_id)

    model_params = parse_params_object(params, strict=True)
    job = create_from_none_job(
        background_tasks, model_params, "Default", manifest.get("output", "mesh"), model_id,
    )
    return WorkflowRunAccepted.from_job(job)


@router.post("/from-text", response_model=WorkflowRunAccepted, status_code=status.HTTP_202_ACCEPTED)
async def create_from_text_run(
    payload: GenerateFromTextRequest,
    background_tasks: BackgroundTasks,
):
    prompt = payload.prompt.strip()
    if not prompt:
        raise HTTPException(400, "prompt is required")
    if payload.remesh not in ("quad", "triangle", "none"):
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")
    model_id = require_model_id(payload.model_id)
    manifest = validate_model_id(model_id)

    job = create_from_text_job(
        background_tasks,
        prompt,
        {
            "remesh": payload.remesh,
            "enable_texture": payload.enable_texture,
            "texture_resolution": payload.texture_resolution,
            **payload.params,
        },
        payload.collection, manifest.get("output", "mesh"), model_id,
    )
    return WorkflowRunAccepted.from_job(job)


@router.post("/from-scene", response_model=WorkflowRunAccepted, status_code=status.HTTP_202_ACCEPTED)
async def create_from_scene_run(
    payload: GenerateFromSceneRequest,
    background_tasks: BackgroundTasks,
):
    from routers.generation import generate_from_scene

    result = await generate_from_scene(payload, background_tasks)
    return WorkflowRunAccepted.from_job(get_job_status(result["job_id"]))


@router.get("/{run_id}", response_model=WorkflowRunStatus)
async def get_workflow_run(run_id: str):
    return WorkflowRunStatus.from_job(get_job_status(run_id))


@router.post("/{run_id}/cancel", response_model=WorkflowRunCancelResponse)
async def cancel_workflow_run(run_id: str, response: Response):
    current_job = get_job_status(run_id)
    was_active = current_job.status in ("pending", "running")
    job = cancel_job(run_id)
    response.status_code = status.HTTP_202_ACCEPTED if was_active else status.HTTP_200_OK
    return WorkflowRunCancelResponse.from_job(job)
