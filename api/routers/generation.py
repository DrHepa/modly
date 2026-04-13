import re as _re

from fastapi import APIRouter, File, Form, UploadFile, HTTPException, BackgroundTasks
from services.generator_registry import generator_registry
from services.generation_jobs import (
    cancel_job as cancel_generation_job,
    create_from_image_job,
    get_job_status,
    parse_params_object,
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

    if remesh not in ("quad", "triangle", "none"):
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    # Sanitize collection name: strip, forbid path separators and special chars
    collection = collection.strip()
    if not collection or _re.search(r'[/:*?"<>|\\]', collection):
        collection = "Default"

    validate_model_id(model_id)

    generator_registry.switch_model(model_id)

    model_params = parse_params_object(params, strict=False)

    image_bytes = await image.read()
    full_params = {
        "remesh":             remesh,
        "enable_texture":     enable_texture,
        "texture_resolution": texture_resolution,
        **model_params,
    }

    job = create_from_image_job(background_tasks, image_bytes, full_params, collection)
    return {"job_id": job.job_id}



@router.get("/status/{job_id}")
async def job_status(job_id: str):
    return get_job_status(job_id)


@router.post("/cancel/{job_id}")
async def cancel_job(job_id: str):
    cancel_generation_job(job_id)
    return {"cancelled": True}
