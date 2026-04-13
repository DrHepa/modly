from typing import Optional

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Response, UploadFile, status

from schemas.workflow_runs import WorkflowRunAccepted, WorkflowRunCancelResponse, WorkflowRunStatus
from services.generation_jobs import (
    VALID_REMESH_MODES,
    cancel_job,
    create_from_image_job,
    get_job_status,
    parse_params_object,
    sanitize_collection,
    validate_image_upload,
    validate_model_id,
)

router = APIRouter(tags=["workflow-runs"])


@router.post("/from-image", response_model=WorkflowRunAccepted, status_code=status.HTTP_202_ACCEPTED)
async def create_from_image_run(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    model_id: str = Form("sf3d"),
    collection: str = Form("Default"),
    params: Optional[str] = Form(None),
):
    validate_image_upload(image)
    model_params = parse_params_object(params, strict=True)
    full_params = {
        "remesh": "quad",
        "enable_texture": False,
        "texture_resolution": 1024,
        **model_params,
    }
    if full_params["remesh"] not in VALID_REMESH_MODES:
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    collection = sanitize_collection(collection)
    model_id = model_id.strip()
    manifest = validate_model_id(model_id)
    image_bytes = await image.read()
    job = create_from_image_job(
        background_tasks, image_bytes, full_params, collection,
        manifest.get("output", "mesh"), model_id,
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
