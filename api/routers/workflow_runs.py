from typing import Optional

from fastapi import APIRouter, BackgroundTasks, File, Form, Response, UploadFile, status

from schemas.workflow_runs import WorkflowRunAccepted, WorkflowRunCancelResponse, WorkflowRunStatus
from services.generation_jobs import (
    cancel_job,
    create_from_image_job,
    get_job_status,
    parse_params_object,
    validate_image_upload,
    validate_model_id,
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

    model_id = model_id.strip()
    validate_model_id(model_id)
    generator_registry.switch_model(model_id)

    model_params = parse_params_object(params, strict=True)
    image_bytes = await image.read()
    job = create_from_image_job(background_tasks, image_bytes, model_params)
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
