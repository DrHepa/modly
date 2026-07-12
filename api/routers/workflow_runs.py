from typing import Optional

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Response, UploadFile, status

from schemas.generation import GenerateFromSceneRequest, GenerateFromTextRequest
from schemas.workflow_runs import WorkflowRunAccepted, WorkflowRunCancelResponse, WorkflowRunStatus
from services.generation_jobs import (
    cancel_job,
    create_from_image_job,
    create_from_none_job,
    create_from_scene_job,
    create_from_text_job,
    get_job_status,
    parse_params_object,
    require_model_input,
    resolve_validated_scene_manifest_path,
    validate_image_upload,
    validate_scene_manifest_path,
)
from services.generator_registry import generator_registry

router = APIRouter(tags=["workflow-runs"])


@router.post("/from-image", response_model=WorkflowRunAccepted, status_code=status.HTTP_202_ACCEPTED)
async def create_from_image_run(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    model_id: str = Form("sf3d"),
    params: Optional[str] = Form(None),
):
    validate_image_upload(image)

    model_id = require_model_input(model_id, "image")
    generator_registry.switch_model(model_id)

    model_params = parse_params_object(params, strict=True)
    image_bytes = await image.read()
    job = create_from_image_job(background_tasks, image_bytes, model_params)
    return WorkflowRunAccepted.from_job(job)


@router.post("/from-none", response_model=WorkflowRunAccepted, status_code=status.HTTP_202_ACCEPTED)
async def create_from_none_run(
    background_tasks: BackgroundTasks,
    model_id: str = Form(...),
    params: Optional[str] = Form(None),
):
    model_id = require_model_input(model_id, "none")
    generator_registry.switch_model(model_id)

    model_params = parse_params_object(params, strict=True)
    job = create_from_none_job(background_tasks, model_params)
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
    model_id = require_model_input(payload.model_id, "text")
    generator_registry.switch_model(model_id)

    job = create_from_text_job(
        background_tasks,
        prompt,
        {
            "remesh": payload.remesh,
            "enable_texture": payload.enable_texture,
            "texture_resolution": payload.texture_resolution,
            **payload.params,
        },
    )
    return WorkflowRunAccepted.from_job(job)


@router.post("/from-scene", response_model=WorkflowRunAccepted, status_code=status.HTTP_202_ACCEPTED)
async def create_from_scene_run(
    payload: GenerateFromSceneRequest,
    background_tasks: BackgroundTasks,
):
    if payload.remesh not in ("quad", "triangle", "none"):
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")
    model_id = require_model_input(payload.model_id, "scene")
    scene_path = validate_scene_manifest_path(payload.scene_path)
    scene_manifest_path = resolve_validated_scene_manifest_path(scene_path)
    generator_registry.switch_model(model_id)

    job = create_from_scene_job(
        background_tasks,
        {
            "remesh": payload.remesh,
            "enable_texture": payload.enable_texture,
            "texture_resolution": payload.texture_resolution,
            **payload.params,
            "scene_manifest_path": str(scene_manifest_path),
            "scene_path": scene_path,
            "input_scene_path": scene_path,
        },
    )
    return WorkflowRunAccepted.from_job(job)


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
