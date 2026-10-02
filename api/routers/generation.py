from fastapi import APIRouter, File, Form, UploadFile, HTTPException, BackgroundTasks
from schemas.generation import (
    GenerateFromArtifactRequest,
    GenerateFromNoneRequest,
    GenerateFromSceneRequest,
    GenerateFromTextRequest,
)
from services.generator_registry import generator_registry
from services.generation_jobs import (
    ImageRequestBudget,
    cancel_job as cancel_generation_job,
    create_from_image_job,
    create_from_artifact_job,
    create_from_none_job,
    create_from_scene_job,
    create_from_text_job,
    get_job_status,
    get_workspace_dir,
    extract_declared_legacy_image_transports,
    extract_legacy_extra_image_paths,
    inject_trusted_host_transport_params,
    parse_params_object,
    require_model_input,
    read_validated_image_upload,
    resolve_validated_scene_manifest_path,
    sanitize_collection_name,
    snapshot_legacy_secondary_images,
    snapshot_declared_legacy_image_transports,
    validate_client_generation_params,
    validate_host_mesh_path,
    validate_secondary_image_metadata,
    validate_image_upload,
    validate_scene_manifest_path,
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
    mesh_path: str | None = Form(None),
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
    collection = sanitize_collection_name(collection)

    model_id = require_model_input(model_id, "image")
    model_params, legacy_paths, legacy_paths_present = extract_legacy_extra_image_paths(
        parse_params_object(params, strict=False)
    )
    model_params, raw_declared_image_transports = extract_declared_legacy_image_transports(
        model_id, model_params
    )
    model_params = validate_client_generation_params(
        model_id,
        model_params,
        extra_server_managed=frozenset({"mesh_path"}),
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
    validate_secondary_image_metadata(model_id, secondary_slots, secondary_handles)

    image_budget = ImageRequestBudget()
    image_bytes, _primary_suffix = await read_validated_image_upload(image, image_budget)
    staged_secondary_images: list[tuple[int, str, bytes, str]] = []
    for upload, slot, handle in zip(
        secondary_uploads, secondary_slots, secondary_handles, strict=True
    ):
        data, suffix = await read_validated_image_upload(upload, image_budget)
        staged_secondary_images.append((slot, handle, data, suffix))
    if legacy_paths_present:
        staged_secondary_images = snapshot_legacy_secondary_images(model_id, legacy_paths, image_budget)
    legacy_image_transports = snapshot_declared_legacy_image_transports(
        model_id, raw_declared_image_transports, image_budget
    )
    generator_registry.switch_model(model_id)
    full_params = {
        "remesh":             remesh,
        "enable_texture":     enable_texture,
        "texture_resolution": texture_resolution,
        **model_params,
    }

    job = create_from_image_job(
        background_tasks,
        image_bytes,
        full_params,
        collection,
        model_id=model_id,
        secondary_images=staged_secondary_images,
        legacy_image_transports=legacy_image_transports,
        mesh_input_path=mesh_input_path,
    )
    return {"job_id": job.job_id}


@router.post("/from-text")
async def generate_from_text(
    payload: GenerateFromTextRequest,
    background_tasks: BackgroundTasks,
):
    prompt = payload.prompt.strip()
    if not prompt:
        raise HTTPException(400, "prompt is required")

    if payload.remesh not in ("quad", "triangle", "none"):
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    collection = sanitize_collection_name(payload.collection)

    model_id = require_model_input(payload.model_id, "text")
    client_params = validate_client_generation_params(model_id, payload.params)
    generator_registry.switch_model(model_id)

    full_params = {
        "remesh": payload.remesh,
        "enable_texture": payload.enable_texture,
        "texture_resolution": payload.texture_resolution,
        **client_params,
    }

    job = create_from_text_job(background_tasks, prompt, full_params, collection, model_id=model_id)
    return {"job_id": job.job_id}


@router.post("/from-none")
async def generate_from_none(
    payload: GenerateFromNoneRequest,
    background_tasks: BackgroundTasks,
):
    if payload.remesh not in ("quad", "triangle", "none"):
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    collection = sanitize_collection_name(payload.collection)
    model_id = require_model_input(payload.model_id, "none")
    client_params = validate_client_generation_params(model_id, payload.params)
    generator_registry.switch_model(model_id)

    full_params = {
        "remesh": payload.remesh,
        "enable_texture": payload.enable_texture,
        "texture_resolution": payload.texture_resolution,
        **client_params,
    }

    job = create_from_none_job(
        background_tasks,
        full_params,
        collection,
        model_id=model_id,
    )
    return {"job_id": job.job_id}


@router.post("/from-scene")
async def generate_from_scene(
    payload: GenerateFromSceneRequest,
    background_tasks: BackgroundTasks,
):
    if payload.remesh not in ("quad", "triangle", "none"):
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    collection = sanitize_collection_name(payload.collection)
    model_id = require_model_input(payload.model_id, "scene")
    scene_path = validate_scene_manifest_path(payload.scene_path)
    scene_manifest_path = resolve_validated_scene_manifest_path(scene_path)

    client_params = validate_client_generation_params(model_id, payload.params)
    generator_registry.switch_model(model_id)

    full_params = inject_trusted_host_transport_params(client_params, {
        "scene_manifest_path": str(scene_manifest_path),
        "scene_path": scene_path,
        "input_scene_path": scene_path,
    })
    full_params = {
        "remesh": payload.remesh,
        "enable_texture": payload.enable_texture,
        "texture_resolution": payload.texture_resolution,
        **full_params,
    }

    job = create_from_scene_job(background_tasks, full_params, collection, model_id=model_id)
    return {"job_id": job.job_id}


@router.post("/from-artifact")
async def generate_from_artifact(
    payload: GenerateFromArtifactRequest,
    background_tasks: BackgroundTasks,
):
    if payload.remesh not in ("quad", "triangle", "none"):
        raise HTTPException(400, "remesh must be 'quad', 'triangle', or 'none'")

    collection = sanitize_collection_name(payload.collection)
    model_id = require_model_input(payload.model_id, payload.input_kind)
    try:
        workspace_dir = get_workspace_dir().resolve()
        if payload.input_kind == "capture":
            artifact_path = validate_capture_input(workspace_dir, payload.input_path)
            artifact_snapshot = None
            artifact_relative_path = artifact_path.relative_to(workspace_dir).as_posix()
        elif payload.input_kind == "scene":
            artifact_path = validate_scene_input(workspace_dir, payload.input_path)
            artifact_snapshot = None
            artifact_relative_path = artifact_path.relative_to(workspace_dir).as_posix()
        else:
            from services.video_input import validate_video_input

            artifact_path, artifact_snapshot = validate_video_input(workspace_dir, payload.input_path)
            artifact_relative_path = artifact_path.relative_to(workspace_dir).as_posix()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    client_params = validate_client_generation_params(model_id, payload.params)
    generator_registry.switch_model(model_id)
    trusted_transport_params = ({
        "scene_manifest_path": str(artifact_path),
        "scene_path": artifact_relative_path,
        "input_scene_path": artifact_relative_path,
    } if payload.input_kind == "scene" else {
        f"{payload.input_kind}_manifest_path": str(artifact_path),
    } if payload.input_kind == "capture" else {})
    full_params = {
        **inject_trusted_host_transport_params(client_params, trusted_transport_params),
        "remesh": payload.remesh,
        "enable_texture": payload.enable_texture,
        "texture_resolution": payload.texture_resolution,
    }
    job = create_from_artifact_job(
        background_tasks,
        payload.input_kind,
        artifact_path,
        full_params,
        collection,
        artifact_snapshot=artifact_snapshot,
        model_id=model_id,
    )
    return {"job_id": job.job_id}



@router.get("/status/{job_id}")
async def job_status(job_id: str):
    return get_job_status(job_id)


@router.post("/cancel/{job_id}")
async def cancel_job(job_id: str):
    cancel_generation_job(job_id)
    return {"cancelled": True}
