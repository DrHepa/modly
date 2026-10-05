import asyncio
import json
import os
import re
import socket
import threading
import time
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from fastapi import APIRouter, Header, HTTPException, Request as FastAPIRequest
from fastapi.responses import StreamingResponse
from services.generator_registry import generator_registry, MODELS_DIR
from services.model_sources import (
    resolve_download_path,
    resolve_model_root,
    resolve_source_destination,
    resolve_source_destination_at_root,
    validate_source_file_plan,
)
from services.hf_download_assets import (
    HfDownloadManifestError,
    resolve_confined_owner_dir,
    stream_hf_asset_downloads,
)
from services.https_download_assets import (
    HttpsDownloadManifestError,
    stream_https_asset_downloads,
)

router = APIRouter(tags=["model"])
_SAFE_MODEL_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class DownloadPaused(Exception):
    pass


class DownloadCancelled(Exception):
    pass


def _is_retryable_download_error(error: Exception) -> bool:
    status = getattr(error, "status_code", None)
    if status is None:
        status = getattr(getattr(error, "response", None), "status_code", None)
    if status is None and isinstance(error, HTTPError):
        status = error.code
    if isinstance(status, int):
        return status in {408, 425, 429} or status >= 500
    return True


_download_controls: dict[str, dict[str, threading.Event]] = {}


def _source_plan_error_response(message: str) -> StreamingResponse:
    async def stream():
        yield f'data: {json.dumps({"error": {"code": "source_plan_invalid", "stage": "validate", "message": message, "retryable": False}})}\n\n'

    return StreamingResponse(stream(), media_type="text/event-stream")


def _source_plan_validation_detail(message: str) -> dict:
    return {
        "code": "source_plan_invalid",
        "stage": "validate",
        "message": message,
        "retryable": False,
    }


def _download_control(model_id: str) -> dict[str, threading.Event]:
    """Return the current control for pause/cancel endpoints."""
    control = _download_controls.get(model_id)
    if control is None:
        control = {"pause": threading.Event(), "cancel": threading.Event()}
        _download_controls[model_id] = control
    return control


def _new_download_control(model_id: str) -> dict[str, threading.Event]:
    """Create a fresh control for a new download session."""
    existing = _download_controls.get(model_id)
    if existing is not None:
        if existing["pause"].is_set() or existing["cancel"].is_set():
            return existing
        raise HTTPException(
            409,
            {
                "code": "download_in_progress",
                "stage": "request",
                "message": f"Download already active for owner {model_id}",
                "retryable": False,
            },
        )
    control: dict[str, threading.Event] = {"pause": threading.Event(), "cancel": threading.Event()}
    _download_controls[model_id] = control
    return control


def _check_download_control(control: dict[str, threading.Event]) -> None:
    if control["cancel"].is_set():
        raise DownloadCancelled()
    if control["pause"].is_set():
        raise DownloadPaused()


def _target_owner_mismatch_detail(plan_kind: str, target_owner_id: str, owner_model_id: str) -> dict:
    return {
        "code": "target_owner_mismatch",
        "stage": "request",
        "message": (
            f"Target owner {target_owner_id} does not match the registered "
            f"{plan_kind} plan owner {owner_model_id}"
        ),
        "retryable": False,
    }


@router.get("/status")
async def model_status():
    """Status of the active model."""
    return generator_registry.active_status()


@router.get("/all")
async def all_models_status():
    """Status of all known models (downloaded, loaded, required VRAM)."""
    return generator_registry.all_status()


@router.get("/runtime-readiness")
async def model_runtime_readiness(model_ids: str):
    """Read-only optional runtime readiness by canonical model ID."""
    requested_ids = [model_id.strip() for model_id in model_ids.split(",") if model_id.strip()]
    for model_id in requested_ids:
        if not _is_safe_canonical_model_id(model_id):
            raise HTTPException(400, f"Invalid model ID: {model_id}")
    return {"readiness": generator_registry.runtime_readiness(requested_ids)}


def _is_safe_canonical_model_id(model_id: str) -> bool:
    if not isinstance(model_id, str) or not model_id:
        return False
    parts = model_id.split("/")
    return len(parts) == 2 and all(
        _SAFE_MODEL_SEGMENT_RE.fullmatch(part) for part in parts
    )


def _is_safe_weight_target_id(target_id: str) -> bool:
    if _is_safe_canonical_model_id(target_id):
        return True
    parts = target_id.split("/") if isinstance(target_id, str) else []
    return (
        len(parts) == 3
        and parts[1] == "_shared"
        and _SAFE_MODEL_SEGMENT_RE.fullmatch(parts[0]) is not None
        and _SAFE_MODEL_SEGMENT_RE.fullmatch(parts[2]) is not None
    )


@router.get("/params")
async def model_params(model_id: Optional[str] = None):
    """Parameter schema of the active model (or a specified model)."""
    try:
        return generator_registry.params_schema(model_id)
    except KeyError:
        if model_id is None:
            raise HTTPException(409, "No model selected")
        raise HTTPException(404, f"Unknown model ID: {model_id}")


@router.post("/switch")
async def switch_model(model_id: str):
    """Switch the active model."""
    try:
        generator_registry.switch_model(model_id)
        return {"active": model_id}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/unload-all")
async def unload_all_models():
    """Unloads all models from memory to free VRAM/RAM."""
    generator_registry.unload_all()
    # Force Python to release memory back to the OS
    import gc
    gc.collect()
    try:
        import ctypes, sys
        if sys.platform == "win32":
            k32 = ctypes.windll.kernel32
            k32.SetProcessWorkingSetSizeEx(k32.GetCurrentProcess(), -1, -1, 0)
    except Exception:
        pass
    return {"unloaded": True}


@router.post("/unload/{model_id:path}")
async def unload_model(model_id: str):
    """Unloads a model from memory so its files can be safely deleted."""
    try:
        gen = generator_registry.get_generator(model_id)
        gen.unload()
        return {"unloaded": True}
    except ValueError:
        return {"unloaded": True}  # already not loaded, that's fine


def _bearer_token(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    scheme, separator, credential = authorization.partition(" ")
    if separator and scheme.lower() == "bearer" and credential.strip():
        return credential.strip()
    return None


@router.get("/hf-download-assets")
async def hf_download_assets(
    model_id: str,
    target_owner_id: Optional[str] = None,
    authorization: Optional[str] = Header(default=None),
):
    """Stream a manifest-owned, pinned and allowlisted asset plan via SSE."""
    if not _is_safe_canonical_model_id(model_id):
        raise HTTPException(400, f"Invalid model ID: {model_id}")

    try:
        plan = generator_registry.get_hf_download_plan(model_id)
        if not plan:
            raise HTTPException(409, "Model does not declare hf_downloads assets")
        owner_dir = resolve_confined_owner_dir(
            MODELS_DIR,
            generator_registry.canonical_model_dir(model_id),
        )
    except KeyError as error:
        raise HTTPException(404, f"Unknown model ID: {model_id}") from error
    except HfDownloadManifestError as error:
        raise HTTPException(422, _source_plan_validation_detail(str(error))) from error

    token = (
        _bearer_token(authorization)
        or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        or os.environ.get("HF_TOKEN")
        or None
    )

    owner_model_id = str(owner_dir.relative_to(MODELS_DIR)).replace(os.sep, "/")
    if target_owner_id is not None:
        if not _is_safe_canonical_model_id(target_owner_id):
            raise HTTPException(400, f"Invalid target owner ID: {target_owner_id}")
        if target_owner_id != owner_model_id:
            raise HTTPException(
                400,
                _target_owner_mismatch_detail("hf_downloads", target_owner_id, owner_model_id),
            )
    control = _new_download_control(owner_model_id)

    async def stream():
        try:
            async for event in stream_hf_asset_downloads(
                owner_dir,
                plan,
                token=token,
                check_download_control=lambda: _check_download_control(control),
                control_exceptions=(DownloadPaused, DownloadCancelled),
            ):
                yield f"data: {json.dumps(event)}\n\n"
        except DownloadPaused:
            yield f"data: {json.dumps({'paused': True, 'status': 'paused'})}\n\n"
        except DownloadCancelled:
            for part in owner_dir.rglob("*.part"):
                part.unlink(missing_ok=True)
            yield f"data: {json.dumps({'cancelled': True, 'status': 'cancelled'})}\n\n"
        finally:
            if _download_controls.get(owner_model_id) is control:
                _download_controls.pop(owner_model_id, None)

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.get("/https-download-assets")
async def https_download_assets(
    model_id: str,
    target_owner_id: Optional[str] = None,
):
    """Stream a model node's exact manifest-owned HTTPS asset plan via SSE."""
    if not _is_safe_canonical_model_id(model_id):
        raise HTTPException(400, f"Invalid model ID: {model_id}")

    try:
        plan = generator_registry.get_https_download_plan(model_id)
        if not plan:
            raise HTTPException(
                409,
                "Model does not declare https_downloads assets",
            )
        owner_dir = resolve_confined_owner_dir(
            MODELS_DIR,
            generator_registry.canonical_model_dir(model_id),
        )
    except KeyError as error:
        raise HTTPException(
            404,
            f"Unknown model ID: {model_id}",
        ) from error
    except (
        HttpsDownloadManifestError,
        HfDownloadManifestError,
    ) as error:
        raise HTTPException(422, _source_plan_validation_detail(str(error))) from error

    owner_model_id = str(owner_dir.relative_to(MODELS_DIR)).replace(os.sep, "/")
    if target_owner_id is not None:
        if not _is_safe_canonical_model_id(target_owner_id):
            raise HTTPException(400, f"Invalid target owner ID: {target_owner_id}")
        if target_owner_id != owner_model_id:
            raise HTTPException(
                400,
                _target_owner_mismatch_detail("https_downloads", target_owner_id, owner_model_id),
            )
    control = _new_download_control(owner_model_id)

    async def stream():
        try:
            async for event in stream_https_asset_downloads(
                owner_dir,
                model_id,
                plan,
                check_download_control=lambda: _check_download_control(control),
                control_exceptions=(DownloadPaused, DownloadCancelled),
            ):
                yield f"data: {json.dumps(event)}\n\n"
        except DownloadPaused:
            yield f"data: {json.dumps({'paused': True, 'status': 'paused'})}\n\n"
        except DownloadCancelled:
            for part in owner_dir.rglob("*.part"):
                part.unlink(missing_ok=True)
            yield f"data: {json.dumps({'cancelled': True, 'status': 'cancelled'})}\n\n"
        finally:
            if _download_controls.get(owner_model_id) is control:
                _download_controls.pop(owner_model_id, None)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
    )


@router.post("/hf-download/pause")
async def pause_hf_download(model_id: str):
    if not _is_safe_weight_target_id(model_id):
        raise HTTPException(400, f"Invalid model ID: {model_id}")
    control = _download_control(model_id)
    control["pause"].set()
    return {"paused": True, "active": True}


@router.post("/hf-download/cancel")
async def cancel_hf_download(model_id: str):
    if not _is_safe_weight_target_id(model_id):
        raise HTTPException(400, f"Invalid model ID: {model_id}")
    control = _download_control(model_id)
    control["cancel"].set()
    return {"cancelled": True, "active": True}




@router.post("/hf-download-sources")
async def hf_download_sources(
    request: FastAPIRequest,
    model_id: str,
    target_owner_id: Optional[str] = None,
):
    """Download all Hugging Face sources declared for one model node."""
    try:
        if not _is_safe_canonical_model_id(model_id):
            raise ValueError(f"Invalid model ID: {model_id}")
        body = await request.body()
        if body.strip() not in (b"", b"{}"):  # source plans are registry-owned only
            raise ValueError("Request body must not provide a model_sources download plan")
        try:
            if target_owner_id is not None and "/_shared/" in target_owner_id:
                if not _is_safe_weight_target_id(target_owner_id):
                    raise ValueError(f"Invalid target owner ID: {target_owner_id}")
                model_root, sources = generator_registry.get_weight_group_sources_plan(
                    model_id, target_owner_id
                )
                owner_model_id = target_owner_id
            else:
                sources = generator_registry.get_model_sources_plan(model_id)
                model_root = generator_registry.canonical_model_dir(model_id)
                owner_model_id = str(model_root.relative_to(MODELS_DIR)).replace(os.sep, "/")
        except (TypeError, ValueError) as exc:
            return _source_plan_error_response(str(exc))
        if not sources:
            raise HTTPException(409, "Model does not declare model_sources")
        if target_owner_id is not None:
            if not _is_safe_weight_target_id(target_owner_id):
                raise ValueError(f"Invalid target owner ID: {target_owner_id}")
            if target_owner_id != owner_model_id:
                raise HTTPException(
                    400,
                    _target_owner_mismatch_detail("model_sources", target_owner_id, owner_model_id),
                )
        try:
            destinations = {
                source["id"]: resolve_source_destination_at_root(
                    model_root, source["destination"]
                )
                for source in sources
            }
        except (TypeError, ValueError) as exc:
            return _source_plan_error_response(str(exc))
    except KeyError as exc:
        raise HTTPException(404, f"Unknown model ID: {model_id}") from exc
    except HTTPException:
        raise
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc

    authorization = request.headers.get("authorization", "")
    hf_token = (
        authorization[7:].strip()
        if authorization.lower().startswith("bearer ")
        else os.environ.get("HUGGING_FACE_HUB_TOKEN")
        or os.environ.get("HF_TOKEN")
        or None
    )
    control = _new_download_control(owner_model_id)

    async def stream():
        loop = asyncio.get_running_loop()

        def _fmt(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        try:
            yield _fmt({"percent": 0, "status": "Listing repository files..."})
            files_by_source: dict[str, list[str]] = {}

            for source in sources:
                _check_download_control(control)

                def _list_files(current=source):
                    from huggingface_hub import list_repo_files
                    listed = list_repo_files(
                        current["repo_id"],
                        revision=current.get("revision"),
                        token=hf_token,
                    )
                    include = current.get("include_prefixes", [])
                    skip = current.get("skip_prefixes", [])
                    return [
                        filename for filename in listed
                        if (not include or any(filename.startswith(prefix) for prefix in include))
                        if not any(filename.startswith(prefix) for prefix in skip)
                    ]

                try:
                    files = await loop.run_in_executor(None, _list_files)
                except Exception as exc:
                    yield _fmt({
                        "error": {
                            "code": "source_list_failed",
                            "stage": "list",
                            "message": str(exc),
                            "source_id": source["id"],
                            "repo_id": source["repo_id"],
                            "retryable": _is_retryable_download_error(exc),
                        }
                    })
                    return
                if not files:
                    yield _fmt({
                        "error": {
                            "code": "source_plan_invalid",
                            "stage": "validate",
                            "message": f'No files remain in the download plan for source "{source["id"]}" ({source["repo_id"]})',
                            "source_id": source["id"],
                            "repo_id": source["repo_id"],
                            "retryable": False,
                        }
                    })
                    return
                destination = destinations[source["id"]]
                try:
                    for filename in files:
                        resolve_download_path(destination, filename)
                except (TypeError, ValueError) as exc:
                    yield _fmt({
                        "error": {
                            "code": "source_plan_invalid",
                            "stage": "validate",
                            "message": str(exc),
                            "retryable": False,
                        }
                    })
                    return
                files_by_source[source["id"]] = files

            try:
                validate_source_file_plan(sources, files_by_source)
            except ValueError as exc:
                yield _fmt({
                    "error": {
                        "code": "source_plan_invalid",
                        "stage": "validate",
                        "message": str(exc),
                        "retryable": False,
                    }
                })
                return
            planned_files = [
                (source, filename)
                for source in sources
                for filename in files_by_source[source["id"]]
            ]
            total = len(planned_files)
            yield _fmt({"percent": 1, "status": f"Downloading {total} files..."})

            from huggingface_hub import hf_hub_url

            for index, (source, filename) in enumerate(planned_files):
                _check_download_control(control)
                display_file = f'{source["id"]}/{filename}'
                base_percent = 1 + round(index / total * 94)
                yield _fmt({
                    "percent": base_percent,
                    "file": display_file,
                    "fileIndex": index + 1,
                    "totalFiles": total,
                    "status": f"Starting {display_file}",
                    "bytesDownloaded": 0,
                    "stalledSeconds": 0,
                })

                queue: asyncio.Queue[dict] = asyncio.Queue()

                def _progress(message: dict) -> None:
                    message["file"] = display_file
                    loop.call_soon_threadsafe(queue.put_nowait, message)

                url = hf_hub_url(
                    repo_id=source["repo_id"],
                    filename=filename,
                    revision=source.get("revision"),
                )
                future = loop.run_in_executor(
                    None,
                    lambda: _download_file_streamed(
                        url=url,
                        filename=filename,
                        dest_dir=str(destinations[source["id"]]),
                        file_index=index + 1,
                        total_files=total,
                        base_percent=base_percent,
                        progress_cb=_progress,
                        control=control,
                        token=hf_token,
                    ),
                )
                while not future.done():
                    try:
                        message = await asyncio.wait_for(queue.get(), timeout=2.0)
                    except asyncio.TimeoutError:
                        continue
                    yield _fmt(message)

                try:
                    final_size = await future
                except DownloadPaused:
                    raise
                except DownloadCancelled:
                    raise
                except Exception as exc:
                    yield _fmt({
                        "error": {
                            "code": "source_file_failed",
                            "stage": "download",
                            "message": str(exc),
                            "source_id": source["id"],
                            "repo_id": source["repo_id"],
                            "file": filename,
                            "retryable": _is_retryable_download_error(exc),
                        }
                    })
                    return
                _check_download_control(control)
                yield _fmt({
                    "percent": 1 + round((index + 1) / total * 94),
                    "file": display_file,
                    "fileIndex": index + 1,
                    "totalFiles": total,
                    "status": "Downloaded",
                    "bytesDownloaded": final_size,
                    "stalledSeconds": 0,
                })

            yield _fmt({"percent": 100, "status": "done"})
        except DownloadPaused:
            yield _fmt({"paused": True, "status": "paused"})
        except DownloadCancelled:
            for part in model_root.rglob("*.part"):
                part.unlink(missing_ok=True)
            yield _fmt({"cancelled": True, "status": "cancelled"})
        except Exception as exc:
            yield _fmt({"error": {
                "code": "download_failed",
                "stage": "download",
                "message": str(exc),
                "retryable": _is_retryable_download_error(exc),
            }})
        finally:
            if _download_controls.get(owner_model_id) is control:
                _download_controls.pop(owner_model_id, None)

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.get("/hf-download")
async def hf_download(
    model_id: str,
    repo_id: Optional[str] = None,
    skip_prefixes: Optional[str] = None,
    include_prefixes: Optional[str] = None,
    token: Optional[str] = None,
):
    """Stream the legacy manifest-owned Hugging Face plan via SSE."""
    import json as _json
    import os
    try:
        if not _is_safe_canonical_model_id(model_id):
            raise ValueError(f"Invalid model ID: {model_id}")
        plan = generator_registry.get_legacy_hf_download_plan(model_id)
        if not plan:
            raise HTTPException(409, "Model does not declare a legacy hf_repo download")
        if repo_id is not None and repo_id != plan["repo_id"]:
            raise ValueError("Request repo_id does not match the installed manifest-owned legacy plan")
        skip_list = plan.get("hf_skip_prefixes", [])
        include_list = plan.get("hf_include_prefixes", [])
        if skip_prefixes is not None and _json.loads(skip_prefixes) != skip_list:
            raise ValueError("Request skip_prefixes do not match the installed manifest-owned legacy plan")
        if include_prefixes is not None and _json.loads(include_prefixes) != include_list:
            raise ValueError("Request include_prefixes do not match the installed manifest-owned legacy plan")
        canonical_dir = generator_registry.canonical_model_dir(model_id)
        configured_models_dir = getattr(generator_registry, "models_dir", None)
        if configured_models_dir is None:
            # canonical_model_dir is the authority for the configured root;
            # derive that root only for confinement validation so a separately
            # monkeypatched router constant cannot reintroduce relative_to drift.
            configured_models_dir = canonical_dir.resolve().parents[1]
        dest_dir = str(resolve_confined_owner_dir(configured_models_dir, canonical_dir))
        repo_id = plan["repo_id"]
    except HTTPException:
        raise
    except KeyError as exc:
        raise HTTPException(404, f"Unknown model ID: {model_id}") from exc
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(422, _source_plan_validation_detail(str(exc))) from exc

    hf_token = token or os.environ.get("HUGGING_FACE_HUB_TOKEN") or os.environ.get("HF_TOKEN") or None
    owner_model_id = f"{Path(dest_dir).parent.name}/{Path(dest_dir).name}"
    control = _new_download_control(owner_model_id)

    async def stream():
        loop = asyncio.get_running_loop()

        def _fmt(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        try:
            yield _fmt({"percent": 0, "status": "Listing repository files..."})
            _check_download_control(control)

            def _list_files():
                from huggingface_hub import list_repo_files
                return [
                    f for f in list_repo_files(repo_id, token=hf_token)
                    if (not include_list or any(f.startswith(p) for p in include_list))
                    if not any(f.startswith(p) for p in skip_list)
                ]

            files = await loop.run_in_executor(None, _list_files)
            total = len(files)

            download_check = plan.get("download_check")
            if download_check and download_check not in files:
                yield _fmt({"error": {
                    "code": "source_plan_invalid",
                    "stage": "validate",
                    "message": (
                        f"download_check {download_check!r} was excluded by the installed "
                        "legacy include/skip filters"
                    ),
                    "retryable": False,
                }})
                return

            if total == 0:
                yield _fmt({"error": {
                    "code": "legacy_source_empty",
                    "stage": "list",
                    "message": f"No files found in HuggingFace repo: {repo_id}",
                    "repo_id": repo_id,
                    "retryable": False,
                }})
                return

            yield _fmt({"percent": 1, "status": f"Downloading {total} files..."})

            from huggingface_hub import hf_hub_url

            for i, filename in enumerate(files):
                _check_download_control(control)
                yield _fmt({
                    "percent": 1 + round(i / total * 94),
                    "file": filename,
                    "fileIndex": i + 1,
                    "totalFiles": total,
                    "status": f"Starting {filename}",
                    "bytesDownloaded": 0,
                    "stalledSeconds": 0,
                })

                base_pct = 1 + round(i / total * 94)
                queue: asyncio.Queue[dict] = asyncio.Queue()

                def _progress(msg: dict) -> None:
                    loop.call_soon_threadsafe(queue.put_nowait, msg)

                url = hf_hub_url(repo_id=repo_id, filename=filename)
                dl_future = loop.run_in_executor(
                    None,
                    lambda: _download_file_streamed(
                        url=url,
                        filename=filename,
                        dest_dir=dest_dir,
                        file_index=i + 1,
                        total_files=total,
                        base_percent=base_pct,
                        progress_cb=_progress,
                        control=control,
                        token=hf_token,
                    ),
                )

                while not dl_future.done():
                    try:
                        msg = await asyncio.wait_for(queue.get(), timeout=2.0)
                    except asyncio.TimeoutError:
                        continue
                    else:
                        yield _fmt(msg)

                try:
                    final_size = await dl_future
                except DownloadPaused:
                    raise
                except DownloadCancelled:
                    raise
                except Exception as exc:
                    yield _fmt({"error": {
                        "code": "legacy_file_failed",
                        "stage": "download",
                        "message": str(exc),
                        "repo_id": repo_id,
                        "file": filename,
                        "retryable": _is_retryable_download_error(exc),
                    }})
                    return
                _check_download_control(control)

                pct = 1 + round((i + 1) / total * 94)
                yield _fmt({
                    "percent": pct,
                    "file": filename,
                    "fileIndex": i + 1,
                    "totalFiles": total,
                    "status": "Downloaded",
                    "bytesDownloaded": final_size,
                    "stalledSeconds": 0,
                })

            yield _fmt({"percent": 100, "status": "done"})

        except DownloadPaused:
            yield _fmt({"paused": True, "status": "paused"})
        except DownloadCancelled:
            for part in Path(dest_dir).rglob("*.part"):
                part.unlink(missing_ok=True)
            yield _fmt({"cancelled": True, "status": "cancelled"})
        except Exception as exc:
            yield _fmt({"error": {
                "code": "legacy_download_failed",
                "stage": "download",
                "message": str(exc),
                "repo_id": repo_id,
                "retryable": _is_retryable_download_error(exc),
            }})
        finally:
            if _download_controls.get(owner_model_id) is control:
                _download_controls.pop(owner_model_id, None)

    return StreamingResponse(stream(), media_type="text/event-stream")

def _download_file_streamed(
    *,
    url: str,
    filename: str,
    dest_dir: str,
    file_index: int,
    total_files: int,
    base_percent: int,
    progress_cb,
    control: dict[str, threading.Event],
    token: Optional[str] = None,
) -> int:
    destination = Path(dest_dir)
    # Validate both the final target and its .part sibling before mkdir/open/
    # replace. This prevents a pre-existing temporary symlink from redirecting
    # bytes outside the manifest-owned model directory.
    final_path = resolve_download_path(destination, filename)
    temp_path = final_path.with_suffix(final_path.suffix + ".part")
    final_path.parent.mkdir(parents=True, exist_ok=True)

    if final_path.exists():
        if not final_path.is_file():
            raise RuntimeError(f"Download target is not a regular file: {filename}")
        existing_size = final_path.stat().st_size
        if existing_size > 0:
            return existing_size
        final_path.unlink()

    hf_token = (
        token
        or os.environ.get("HF_TOKEN")
        or os.environ.get("HUGGINGFACE_HUB_TOKEN")
        or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    )
    headers = {"User-Agent": "modly/0.3.1"}
    if hf_token:
        headers["Authorization"] = f"Bearer {hf_token}"

    retries = 3
    backoff = 2.0
    last_error: Exception | None = None

    for attempt in range(1, retries + 1):
        try:
            _check_download_control(control)
            existing_bytes = temp_path.stat().st_size if temp_path.exists() else 0
            request_headers = dict(headers)
            request_url = url
            if existing_bytes > 0:
                request_url = _resolve_direct_download_url(url, headers)
                request_headers["Range"] = f"bytes={existing_bytes}-"

            request = Request(request_url, headers=request_headers)
            with urlopen(request, timeout=30) as response:
                resumed = existing_bytes > 0 and getattr(response, "status", None) == 206
                if existing_bytes > 0 and not resumed:
                    temp_path.unlink(missing_ok=True)
                    existing_bytes = 0

                total_bytes = _response_total_bytes(
                    response.headers,
                    existing_bytes if resumed else 0,
                )
                bytes_downloaded = existing_bytes
                last_emit = 0.0
                chunk_size = 1024 * 1024
                mode = "ab" if resumed else "wb"

                progress_cb({
                    "percent": base_percent,
                    "file": filename,
                    "fileIndex": file_index,
                    "totalFiles": total_files,
                    "status": _download_status(
                        bytes_downloaded,
                        total_bytes,
                        attempt,
                        retries,
                        resumed=resumed,
                    ),
                    "bytesDownloaded": bytes_downloaded,
                    "totalBytes": total_bytes,
                    "stalledSeconds": 0,
                })

                with open(temp_path, mode) as out:
                    while True:
                        _check_download_control(control)
                        try:
                            chunk = response.read(chunk_size)
                        except socket.timeout as exc:
                            raise TimeoutError(
                                f"Timed out while downloading {filename}"
                            ) from exc

                        if not chunk:
                            break

                        out.write(chunk)
                        bytes_downloaded += len(chunk)

                        now = time.monotonic()
                        if now - last_emit >= 0.5:
                            progress_cb({
                                "percent": base_percent,
                                "file": filename,
                                "fileIndex": file_index,
                                "totalFiles": total_files,
                                "status": _download_status(
                                    bytes_downloaded,
                                    total_bytes,
                                    attempt,
                                    retries,
                                    resumed=resumed,
                                ),
                                "bytesDownloaded": bytes_downloaded,
                                "totalBytes": total_bytes,
                                "stalledSeconds": 0,
                            })
                            last_emit = now

            temp_path.replace(final_path)
            return bytes_downloaded

        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            if isinstance(exc, HTTPError) and not _is_retryable_download_error(exc):
                raise
            last_error = exc
            preserved_bytes = temp_path.stat().st_size if temp_path.exists() else 0
            progress_cb({
                "percent": base_percent,
                "file": filename,
                "fileIndex": file_index,
                "totalFiles": total_files,
                "status": f"Retrying after error ({attempt}/{retries})...",
                "bytesDownloaded": preserved_bytes,
                "stalledSeconds": 0,
            })
            if attempt >= retries:
                break
            time.sleep(backoff)
            backoff *= 2

    raise RuntimeError(f"Failed to download {filename}: {last_error}")


def _resolve_direct_download_url(url: str, headers: dict[str, str]) -> str:
    request = Request(url, headers=headers, method="HEAD")
    with urlopen(request, timeout=30) as response:
        return response.geturl()


def _parse_content_length(raw: Optional[str]) -> Optional[int]:
    if not raw:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _download_status(
    downloaded: int,
    total: Optional[int],
    attempt: int,
    retries: int,
    resumed: bool = False,
) -> str:
    prefix = "Resuming..." if resumed and downloaded > 0 else "Downloading..."
    if total and total > 0:
        pct = min(100, round(downloaded / total * 100))
        return f"{prefix} {pct}%"
    if retries > 1 and attempt > 1:
        return f"{prefix} retry {attempt}/{retries}"
    return prefix


def _response_total_bytes(headers, already_downloaded: int) -> Optional[int]:
    content_range = headers.get("Content-Range")
    if content_range and "/" in content_range:
        total_raw = content_range.split("/")[-1].strip()
        try:
            return int(total_raw)
        except (TypeError, ValueError):
            pass

    content_length = _parse_content_length(headers.get("Content-Length"))
    if content_length is None:
        return None
    return already_downloaded + content_length
