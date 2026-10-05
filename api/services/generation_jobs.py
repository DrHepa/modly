import asyncio
from io import BytesIO
import inspect
import json
import logging
import os
import re
import shutil
import stat
import threading
import time
import traceback
import uuid
import warnings
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Dict, Optional, Tuple

from fastapi import BackgroundTasks, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

from schemas.generation import JobStatus, SceneCandidate
from services.generator_registry import WORKSPACE_DIR, generator_registry
from services.extension_process import ExtensionProcess
from services.generators.base import GenerationCancelled, smooth_progress
from services.capture_input import TypedModelInput, revalidate_typed_model_input


_jobs: Dict[str, JobStatus] = {}
_cancelled: set[str] = set()
_cancel_events: Dict[str, threading.Event] = {}
_last_logged_snapshots: Dict[str, Tuple[str, int, Optional[str]]] = {}
_log_lock = threading.Lock()
_jobs_lock = threading.Lock()
_generation_logger = logging.getLogger("modly.generation.jobs")
SCENE_MANIFEST_SCHEMA = "modly.scene-manifest.v1"
IMAGE_OUTPUT_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"})
MESH_OUTPUT_SUFFIXES = frozenset({".glb", ".gltf", ".obj", ".stl", ".ply", ".fbx", ".usd", ".usda", ".usdc", ".usdz"})
VIDEO_OUTPUT_SUFFIXES = frozenset({".mp4", ".mov", ".webm", ".mkv", ".avi"})
AUDIO_OUTPUT_SUFFIXES = frozenset({".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac"})
_INVALID_COLLECTION_CHARS = re.compile(r'[/:*?"<>|\\]')
MAX_IMAGE_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_IMAGE_DIMENSION = 32_768
MAX_IMAGE_PIXELS = 64_000_000
MAX_IMAGE_PORTS = 16
MAX_GENERATION_MULTIPART_BYTES = 512 * 1024 * 1024
MAX_MESH_INPUT_BYTES = 512 * 1024 * 1024
SUPPORTED_IMAGE_CONTENT_TYPES = frozenset({"image/png", "image/jpeg", "image/webp", "image/tiff", "image/bmp"})
PRIVATE_INPUTS_DIRNAME = ".modly-private-inputs"
LEGACY_EXTRA_IMAGE_PATHS_PARAM = "extra_image_paths"
HOST_MESH_PATH_PARAM = "mesh_path"
_LIST_IMAGE_TRANSPORT_IDS = frozenset({
    "extraimagepaths",
    "imagepaths",
    "inputimages",
    "inputimagepaths",
    "referenceimages",
    "referenceimagepaths",
})
_DIRECTORY_IMAGE_TRANSPORT_IDS = frozenset({
    "imagesdir", "imagedir", "imagefolder", "imagesfolder", "imagedirectory", "imagesdirectory",
})
_TYPED_SERVER_TRANSPORT_IDS = frozenset({
    "scene_manifest_path",
    "scene_path",
    "input_scene_path",
    "capture_manifest_path",
    "capture_path",
    "input_capture_path",
    "video_path",
    "input_video_path",
    "typed_input_kind",
    "typed_input_path",
})

SecondaryImageRecord = (
    tuple[int, str, bytes, str]
    | tuple[int, str, bytes, str, str]
)


class ImageRequestBudget:
    def __init__(self) -> None:
        self.count = 0
        self.total_bytes = 0

    def reserve(self, size: int) -> None:
        if self.count >= MAX_IMAGE_PORTS:
            raise HTTPException(413, f"Image request exceeds the maximum of {MAX_IMAGE_PORTS} images")
        if size < 0 or self.total_bytes + size > MAX_GENERATION_MULTIPART_BYTES:
            raise HTTPException(413, "Image request exceeds the 512 MiB aggregate limit")
        self.count += 1
        self.total_bytes += size

    def add_bytes(self, size: int) -> None:
        if size < 0 or self.total_bytes + size > MAX_GENERATION_MULTIPART_BYTES:
            raise HTTPException(413, "Image request exceeds the 512 MiB aggregate limit")
        self.total_bytes += size

    def reserve_count_with_size_hint(self, size: int) -> None:
        if self.count >= MAX_IMAGE_PORTS:
            raise HTTPException(413, f"Image request exceeds the maximum of {MAX_IMAGE_PORTS} images")
        if size < 0 or self.total_bytes + size > MAX_GENERATION_MULTIPART_BYTES:
            raise HTTPException(413, "Image request exceeds the 512 MiB aggregate limit")
        self.count += 1


def sanitize_collection_name(collection: str) -> str:
    """Return a safe single workspace directory name for generated assets."""
    collection = collection.strip()
    if (
        not collection
        or collection in {".", ".."}
        or _INVALID_COLLECTION_CHARS.search(collection)
    ):
        return "Default"
    return collection


def get_workspace_dir() -> Path:
    """Return the runtime workspace root shared with extension subprocesses."""
    import services.generator_registry as registry_module

    return registry_module.WORKSPACE_DIR


def _private_inputs_root() -> Path:
    return get_workspace_dir() / PRIVATE_INPUTS_DIRNAME


def _private_job_dir(job_id: str) -> Path:
    return _private_inputs_root() / job_id


def _is_link_or_reparse(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    attributes = getattr(info, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return stat.S_ISLNK(info.st_mode) or bool(attributes & reparse_flag)


def _assert_not_link_or_reparse(path: Path) -> None:
    if _is_link_or_reparse(path):
        raise HTTPException(400, f"{path.name or 'path'} must not be a link or reparse point")


def _declared_input_ports(model_id: str) -> list[tuple[int, str, str]]:
    """Mirror Electron's manifest port normalization without losing physical slots."""

    try:
        manifest = generator_registry.get_manifest(model_id)
    except KeyError as exc:
        raise HTTPException(400, str(exc)) from exc
    declared = manifest.get("inputs")
    if declared is None:
        input_type = manifest.get("input", "image")
        return [(1, input_type, input_type)] if isinstance(input_type, str) else []
    if not isinstance(declared, list):
        raise HTTPException(400, "requested model manifest inputs must be an array")

    input_contract = manifest.get("input_contract")
    if input_contract is not None and not isinstance(input_contract, list):
        raise HTTPException(400, "requested model manifest input_contract must be an array")

    def contract_at(index: int) -> dict:
        if not isinstance(input_contract, list) or index >= len(input_contract):
            return {}
        contract = input_contract[index]
        if not isinstance(contract, dict):
            raise HTTPException(400, f"requested model input_contract entry {index + 1} is invalid")
        for name_key in ("name", "id"):
            value = contract.get(name_key)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise HTTPException(400, f"requested model input_contract entry {index + 1} has an invalid {name_key}")
        contract_type = contract.get("type")
        if contract_type is not None and (not isinstance(contract_type, str) or not contract_type.strip()):
            raise HTTPException(400, f"requested model input_contract entry {index + 1} has an invalid type")
        contract_label = contract.get("label")
        if contract_label is not None and not isinstance(contract_label, str):
            raise HTTPException(400, f"requested model input_contract entry {index + 1} has an invalid label")
        contract_required = contract.get("required")
        if contract_required is not None and not isinstance(contract_required, bool):
            raise HTTPException(400, f"requested model input_contract entry {index + 1} has an invalid required flag")
        return contract

    if isinstance(input_contract, list):
        for contract_index in range(len(input_contract)):
            contract_at(contract_index)

    explicit_names: set[str] = set()
    for index, item in enumerate(declared):
        if isinstance(item, str):
            contract = contract_at(index)
            name = contract.get("name", contract.get("id"))
            if name is None:
                continue
            name = name.strip()
        elif isinstance(item, dict):
            name = item.get("name", item.get("id"))
            if not isinstance(name, str) or not name.strip():
                raise HTTPException(400, f"requested model input {index + 1} has no valid handle")
            input_type = item.get("type")
            if not isinstance(input_type, str) or not input_type.strip():
                raise HTTPException(400, f"requested model input {index + 1} has no valid type")
            name = name.strip()
        else:
            continue
        if name in explicit_names:
            raise HTTPException(400, f"requested model manifest repeats input handle '{name}'")
        explicit_names.add(name)

    used = set(explicit_names)
    ports: list[tuple[int, str, str]] = []
    for index, item in enumerate(declared):
        if isinstance(item, str):
            contract = contract_at(index)
            input_type = contract.get("type", item)
            if not input_type:
                raise HTTPException(400, f"requested model input {index + 1} has no type")
            contract_name = contract.get("name", contract.get("id"))
            if contract_name is not None:
                handle = contract_name.strip()
            else:
                handle = item
                suffix = 2
                while handle in used:
                    handle = f"{item}_{suffix}"
                    suffix += 1
                used.add(handle)
        elif isinstance(item, dict):
            input_type = item.get("type")
            handle = item.get("name", item.get("id")).strip()
        else:
            raise HTTPException(400, f"requested model input {index + 1} is invalid")
        ports.append((index + 1, handle, input_type))
    if sum(input_type == "image" for _slot, _handle, input_type in ports) > MAX_IMAGE_PORTS:
        raise HTTPException(400, f"requested model exceeds the maximum of {MAX_IMAGE_PORTS} image ports")
    return ports


def _declared_image_ports(model_id: str) -> list[tuple[int, str]]:
    return [
        (slot, handle)
        for slot, handle, input_type in _declared_input_ports(model_id)
        if input_type == "image"
    ]


def _declared_image_handles(model_id: str) -> list[str]:
    """Return image handles in image-relative ABI order for legacy carriers."""

    return [handle for _slot, handle in _declared_image_ports(model_id)]


def generation_multipart_body_limit() -> int:
    """Absolute parser-facing route bound; manifests cannot increase it."""

    return MAX_GENERATION_MULTIPART_BYTES


def _declared_client_param_schema(model_id: str) -> dict[str, dict]:
    """Return the exact client parameter descriptors declared by one model node."""

    try:
        manifest = generator_registry.get_manifest(model_id)
    except KeyError as exc:
        raise HTTPException(400, str(exc)) from exc
    schema = manifest.get("params_schema", [])
    if not isinstance(schema, list):
        raise HTTPException(400, "requested model manifest params_schema must be an array")

    declared: dict[str, dict] = {}
    for index, item in enumerate(schema):
        if not isinstance(item, dict):
            raise HTTPException(400, f"requested model parameter {index + 1} is invalid")
        param_id = item.get("id")
        if not isinstance(param_id, str) or not param_id.strip() or param_id != param_id.strip():
            raise HTTPException(400, f"requested model parameter {index + 1} has no valid id")
        if param_id in declared:
            raise HTTPException(400, f"requested model manifest repeats parameter '{param_id}'")
        declared[param_id] = item
    return declared


def _compact_transport_id(value: str) -> str:
    return re.sub(r"[._\-\s]+", "", value).casefold()


def _schema_declares_image_path_carrier(param_id: str, schema: dict) -> bool:
    """Require string/path evidence before treating a declared UI param as transport."""

    if schema.get("type") != "string":
        return False
    compact = _compact_transport_id(param_id)
    if compact.endswith("imagepath") or compact.endswith("imagepaths"):
        return True
    if schema.get("pickerIntent") == "image":
        return True
    filters = schema.get("filters")
    if isinstance(filters, list):
        for item in filters:
            if not isinstance(item, dict):
                continue
            extensions = item.get("extensions")
            if isinstance(extensions, list) and any(
                isinstance(extension, str)
                and extension.casefold().lstrip(".") in {"png", "jpg", "jpeg", "webp"}
                for extension in extensions
            ):
                return True
    return False


def _schema_declares_image_directory(param_id: str, schema: dict) -> bool:
    if schema.get("type") != "string":
        return False
    compact = _compact_transport_id(param_id)
    return compact in _DIRECTORY_IMAGE_TRANSPORT_IDS or (
        schema.get("pickerIntent") == "directory" and "image" in compact
    )


def _declared_secondary_image_transport_aliases(
    model_id: str,
) -> tuple[dict[str, int], set[str]]:
    """Map exact declared ABI aliases to secondary slots or ordered path lists."""

    image_ports = _declared_image_ports(model_id)
    declared = _declared_client_param_schema(model_id)
    per_handle: dict[str, int] = {}
    list_aliases: set[str] = set()
    for param_id, schema in declared.items():
        compact = _compact_transport_id(param_id)
        is_path_carrier = _schema_declares_image_path_carrier(param_id, schema)
        if compact in _LIST_IMAGE_TRANSPORT_IDS and is_path_carrier and len(image_ports) > 1:
            list_aliases.add(param_id)
            continue
        if not is_path_carrier:
            continue
        numbered_view = re.fullmatch(r"view(\d+)imagepath", compact)
        if numbered_view is not None:
            image_ordinal = int(numbered_view.group(1))
            if 2 <= image_ordinal <= len(image_ports):
                per_handle[param_id] = image_ports[image_ordinal - 1][0]
            continue
        for slot, handle in image_ports[1:]:
            handle_compact = _compact_transport_id(handle)
            candidates = {f"{handle_compact}path", f"{handle_compact}imagepath"}
            if compact in candidates:
                per_handle[param_id] = slot
                break
    return per_handle, list_aliases


def _declared_legacy_image_transport_schema(model_id: str) -> dict[str, dict]:
    """Return declared image-path params that are not backed by multipart ports."""

    declared = _declared_client_param_schema(model_id)
    per_handle, list_aliases = _declared_secondary_image_transport_aliases(model_id)
    multipart_managed = set(per_handle) | list_aliases
    return {
        param_id: schema
        for param_id, schema in declared.items()
        if param_id not in multipart_managed
        and (_schema_declares_image_path_carrier(param_id, schema)
             or _schema_declares_image_directory(param_id, schema))
    }


def _is_known_image_transport_alias(model_id: str, param_id: str) -> bool:
    """Recognize image transport names without treating every path-like id as reserved."""

    compact = _compact_transport_id(param_id)
    if compact in _LIST_IMAGE_TRANSPORT_IDS or compact in _DIRECTORY_IMAGE_TRANSPORT_IDS:
        return True
    if compact.endswith("imagepath") or compact.endswith("imagepaths"):
        return True
    if re.fullmatch(r"image\d+paths?", compact) is not None:
        return True
    for handle in _declared_image_handles(model_id):
        handle_compact = _compact_transport_id(handle)
        if compact in {
            f"{handle_compact}path",
            f"{handle_compact}paths",
            f"{handle_compact}imagepath",
            f"{handle_compact}imagepaths",
        }:
            return True
    return False


def _is_blank_image_transport_value(value: object) -> bool:
    """Allow only bounded transports containing no client path material."""

    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple)):
        return len(value) <= MAX_IMAGE_PORTS and all(
            item is None or (isinstance(item, str) and not item.strip())
            for item in value
        )
    return False


def _contains_path_shaped_value(value: object) -> bool:
    """Detect path-shaped payloads only for otherwise ambiguous reserved aliases."""

    if isinstance(value, str):
        candidate = value.strip()
        if not candidate:
            return False
        normalized = candidate.replace("\\", "/")
        return (
            "\x00" in candidate
            or "/" in normalized
            or normalized in {".", ".."}
            or Path(normalized).suffix.casefold()
            in {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"}
        )
    if isinstance(value, (list, tuple)):
        return any(_contains_path_shaped_value(item) for item in value)
    return False


def _manifest_declares_input_type(model_id: str, expected_type: str) -> bool:
    try:
        manifest = generator_registry.get_manifest(model_id)
    except KeyError as exc:
        raise HTTPException(400, str(exc)) from exc
    declared = manifest.get("inputs")
    if declared is None:
        return manifest.get("input", "image") == expected_type
    if not isinstance(declared, list):
        raise HTTPException(400, "requested model manifest inputs must be an array")
    contract = manifest.get("input_contract")
    if contract is not None and not isinstance(contract, list):
        raise HTTPException(400, "requested model manifest input_contract must be an array")
    for index, item in enumerate(declared):
        if isinstance(item, dict):
            input_type = item.get("type")
        elif isinstance(item, str):
            input_type = item
            if isinstance(contract, list) and index < len(contract):
                contract_item = contract[index]
                if not isinstance(contract_item, dict):
                    raise HTTPException(400, f"requested model input_contract entry {index + 1} is invalid")
                input_type = contract_item.get("type", input_type)
        else:
            raise HTTPException(400, f"requested model input {index + 1} is invalid")
        if input_type == expected_type:
            return True
    return False


def validate_client_generation_params(
    model_id: str,
    params: dict,
    *,
    extra_server_managed: frozenset[str] = frozenset(),
) -> dict:
    """Pass runtime parameters through while reserving host-owned transport names."""

    if not isinstance(params, dict):
        raise HTTPException(400, "params must be a JSON object")
    declared = _declared_client_param_schema(model_id)
    per_handle_aliases, list_aliases = _declared_secondary_image_transport_aliases(model_id)
    image_transport_ids = (
        set(per_handle_aliases)
        | list_aliases
        | set(_declared_legacy_image_transport_schema(model_id))
    )
    server_managed: list[str] = []
    filtered_params = dict(params)
    for key, value in params.items():
        if not isinstance(key, str):
            raise HTTPException(400, "generation parameter names must be strings")
        schema = declared.get(key)
        compact = _compact_transport_id(key)
        known_image_alias = _is_known_image_transport_alias(model_id, key)
        ambiguous_declared_alias = (
            schema is not None
            and key not in image_transport_ids
            and compact in _LIST_IMAGE_TRANSPORT_IDS
        )
        reserved_image_alias = (
            key in image_transport_ids
            or (known_image_alias and not ambiguous_declared_alias)
        )
        if key in _TYPED_SERVER_TRANSPORT_IDS or key in extra_server_managed:
            server_managed.append(key)
        elif reserved_image_alias:
            if _is_blank_image_transport_value(value):
                filtered_params.pop(key, None)
            else:
                server_managed.append(key)
        elif ambiguous_declared_alias and _contains_path_shaped_value(value):
            server_managed.append(key)
    if server_managed:
        rendered = ", ".join(repr(key) for key in sorted(server_managed))
        raise HTTPException(400, f"Generation transport parameter(s) are server-managed: {rendered}")
    return filtered_params


def inject_trusted_host_transport_params(
    client_params: dict,
    trusted_params: dict[str, object],
) -> dict:
    """Inject route-derived transport aliases only after client transport validation."""

    invalid = set(trusted_params) - _TYPED_SERVER_TRANSPORT_IDS
    if invalid:
        rendered = ", ".join(repr(key) for key in sorted(invalid))
        raise RuntimeError(f"Unsupported trusted host transport parameter(s): {rendered}")
    overlap = set(client_params) & set(trusted_params)
    if overlap:  # pragma: no cover - validate_client_generation_params rejects these
        rendered = ", ".join(repr(key) for key in sorted(overlap))
        raise RuntimeError(f"Trusted host transport overlaps client parameters: {rendered}")
    return {**client_params, **trusted_params}


def extract_legacy_extra_image_paths(params: dict) -> tuple[dict, object, bool]:
    """Remove the sole legacy path transport key before client allowlisting."""

    copied = dict(params)
    present = LEGACY_EXTRA_IMAGE_PATHS_PARAM in copied
    value = copied.pop(LEGACY_EXTRA_IMAGE_PATHS_PARAM, None)
    return copied, value, present


def extract_declared_legacy_image_transports(
    model_id: str,
    params: dict,
) -> tuple[dict, dict[str, object]]:
    """Remove declared non-multipart image paths before UI-param allowlisting."""

    copied = dict(params)
    transports: dict[str, object] = {}
    for param_id in _declared_legacy_image_transport_schema(model_id):
        if param_id in copied:
            transports[param_id] = copied.pop(param_id)
    return copied, transports


def validate_host_mesh_path(model_id: str, path_value: object) -> Path:
    """Resolve one mixed-input mesh transport to a bounded safe workspace file."""

    if not _manifest_declares_input_type(model_id, "mesh"):
        raise HTTPException(400, "requested model does not declare a mesh input")
    if not isinstance(path_value, str) or not path_value.strip() or "\x00" in path_value:
        raise HTTPException(400, "mesh_path must be a non-empty workspace path")
    value = path_value.strip()
    workspace = get_workspace_dir().resolve()
    if value.startswith("/workspace/"):
        raw_path = Path(value[len("/workspace/"):].replace("\\", os.sep))
    else:
        normalized = value.replace("\\", os.sep)
        raw_path = Path(normalized)
        if (
            PurePosixPath(value.replace("\\", "/")).is_absolute()
            or PureWindowsPath(value).is_absolute()
        ) and not raw_path.is_absolute():
            raise HTTPException(400, "mesh_path must stay inside the workspace")
    candidate = raw_path if raw_path.is_absolute() else workspace / raw_path
    try:
        lexical_relative = candidate.relative_to(workspace)
    except ValueError as exc:
        raise HTTPException(400, "mesh_path must stay inside the workspace") from exc
    if any(part in {"", ".", ".."} for part in lexical_relative.parts):
        raise HTTPException(400, "mesh_path must stay inside the workspace")

    current = workspace
    try:
        for part in lexical_relative.parts:
            current = current / part
            _assert_not_link_or_reparse(current)
        resolved = candidate.resolve(strict=True)
        resolved_relative = resolved.relative_to(workspace)
        info = resolved.stat()
    except HTTPException:
        raise
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
        raise HTTPException(400, "mesh_path must reference an existing workspace file") from exc
    if (
        resolved_relative.parts
        and resolved_relative.parts[0].casefold() == PRIVATE_INPUTS_DIRNAME.casefold()
    ):
        raise HTTPException(400, "mesh_path must not read private input custody")
    if not stat.S_ISREG(info.st_mode):
        raise HTTPException(400, "mesh_path must reference a regular file")
    if resolved.suffix.casefold() not in MESH_OUTPUT_SUFFIXES:
        raise HTTPException(400, "mesh_path must reference a supported mesh file")
    if info.st_size > MAX_MESH_INPUT_BYTES:
        raise HTTPException(413, "Mesh input exceeds the 512 MiB limit")
    return resolved


def _read_legacy_workspace_image(
    path_value: str,
    *,
    transport_name: str = "legacy extra_image_paths",
    budget: Optional[ImageRequestBudget] = None,
) -> tuple[bytes, str, str]:
    """Read one legacy image without following links or leaving the workspace."""

    if not isinstance(path_value, str) or not path_value.strip() or "\x00" in path_value:
        raise HTTPException(400, f"{transport_name} entries must be paths or null gaps")
    value = path_value.strip()
    workspace = get_workspace_dir().resolve()
    normalized = value.replace("\\", os.sep)
    raw_path = Path(normalized)
    if (PurePosixPath(value.replace("\\", "/")).is_absolute() or PureWindowsPath(value).is_absolute()) and not raw_path.is_absolute():
        raise HTTPException(400, f"{transport_name} must stay inside the workspace")
    candidate = raw_path if raw_path.is_absolute() else workspace / raw_path

    try:
        lexical_relative = candidate.relative_to(workspace)
    except ValueError as exc:
        raise HTTPException(400, f"{transport_name} must stay inside the workspace") from exc
    if any(part in {"", ".", ".."} for part in lexical_relative.parts):
        raise HTTPException(400, f"{transport_name} must stay inside the workspace")

    current = workspace
    try:
        for part in lexical_relative.parts:
            current = current / part
            _assert_not_link_or_reparse(current)
        resolved = candidate.resolve(strict=True)
        resolved_relative = resolved.relative_to(workspace)
    except HTTPException:
        raise
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
        raise HTTPException(400, f"{transport_name} must reference an existing workspace file") from exc
    if (
        resolved_relative.parts
        and resolved_relative.parts[0].casefold() == PRIVATE_INPUTS_DIRNAME.casefold()
    ):
        raise HTTPException(400, f"{transport_name} must not read private input custody")

    pre_info = resolved.stat()
    if not stat.S_ISREG(pre_info.st_mode):
        raise HTTPException(400, f"{transport_name} entries must be regular files")
    if pre_info.st_size > MAX_IMAGE_UPLOAD_BYTES:
        raise HTTPException(413, "Image upload exceeds the 64 MiB limit")
    if budget is not None:
        budget.reserve_count_with_size_hint(pre_info.st_size)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(candidate, flags)
    except OSError as exc:
        raise HTTPException(400, f"{transport_name} must reference a readable workspace file") from exc
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise HTTPException(400, f"{transport_name} entries must be regular files")
        if info.st_size > MAX_IMAGE_UPLOAD_BYTES:
            raise HTTPException(413, "Image upload exceeds the 64 MiB limit")
        identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        if identity != (
            pre_info.st_dev, pre_info.st_ino, pre_info.st_size,
            pre_info.st_mtime_ns, pre_info.st_ctime_ns,
        ):
            raise HTTPException(400, f"{transport_name} changed while being read")
        chunks: list[bytes] = []
        remaining = MAX_IMAGE_UPLOAD_BYTES + 1
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                break
            if budget is not None:
                budget.add_bytes(len(chunk))
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        final_info = os.fstat(descriptor)
        final_identity = (
            final_info.st_dev, final_info.st_ino, final_info.st_size,
            final_info.st_mtime_ns, final_info.st_ctime_ns,
        )
        if final_identity != identity or len(data) != info.st_size:
            raise HTTPException(400, f"{transport_name} changed while being read")
    finally:
        os.close(descriptor)
    if len(data) > MAX_IMAGE_UPLOAD_BYTES:
        raise HTTPException(413, "Image upload exceeds the 64 MiB limit")
    data, suffix = _validate_decodable_image(data)
    accepted_suffixes = {
        ".png": {".png"},
        ".jpg": {".jpg", ".jpeg"},
        ".webp": {".webp"},
        ".tif": {".tif", ".tiff"},
        ".bmp": {".bmp"},
    }[suffix]
    if resolved.suffix.casefold() not in accepted_suffixes:
        raise HTTPException(400, f"{transport_name} extension does not match decoded image format")
    original_basename = resolved.name
    if (
        not original_basename
        or original_basename in {".", ".."}
        or "\x00" in original_basename
        or Path(original_basename).name != original_basename
    ):
        raise HTTPException(400, f"{transport_name} contains an unsafe image name")
    return data, suffix, original_basename


def snapshot_declared_legacy_image_transports(
    model_id: str,
    raw_transports: dict[str, object],
    budget: Optional[ImageRequestBudget] = None,
) -> dict[str, tuple[str, list[Optional[tuple[bytes, str, str]]]]]:
    """Validate legacy declared paths and retain only bytes until job custody exists."""

    schemas = _declared_legacy_image_transport_schema(model_id)
    snapshots: dict[str, tuple[str, list[Optional[tuple[bytes, str, str]]]]] = {}
    for param_id, raw_value in raw_transports.items():
        if param_id not in schemas:
            raise HTTPException(400, f"Image transport parameter '{param_id}' is not legacy-compatible")
        compact = _compact_transport_id(param_id)
        if _schema_declares_image_directory(param_id, schemas[param_id]):
            if raw_value == "":
                snapshots[param_id] = ("empty", [])
                continue
            if not isinstance(raw_value, str):
                raise HTTPException(400, f"{param_id} must be a workspace image directory")
            workspace = get_workspace_dir().resolve()
            candidate = Path(raw_value.replace("\\", os.sep))
            candidate = candidate if candidate.is_absolute() else workspace / candidate
            try:
                relative = candidate.relative_to(workspace)
                if any(part in {"", ".", ".."} for part in relative.parts):
                    raise ValueError
                current = workspace
                for part in relative.parts:
                    current /= part
                    _assert_not_link_or_reparse(current)
                resolved = candidate.resolve(strict=True)
                resolved_relative = resolved.relative_to(workspace)
            except HTTPException:
                raise
            except (OSError, RuntimeError, ValueError) as exc:
                raise HTTPException(400, f"{param_id} must stay inside the workspace") from exc
            if resolved_relative.parts and resolved_relative.parts[0].casefold() == PRIVATE_INPUTS_DIRNAME.casefold():
                raise HTTPException(400, f"{param_id} must not read private input custody")
            if not resolved.is_dir():
                raise HTTPException(400, f"{param_id} must reference a workspace directory")
            records = []
            seen_names: set[str] = set()
            for child in sorted(resolved.iterdir(), key=lambda item: item.name.casefold()):
                if child.suffix.casefold() not in {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"}:
                    continue
                _assert_not_link_or_reparse(child)
                safe_name = Path(child.name).name
                folded = safe_name.casefold()
                if safe_name != child.name or folded in seen_names:
                    raise HTTPException(400, f"{param_id} contains unsafe or colliding image names")
                seen_names.add(folded)
                data, suffix, original_basename = _read_legacy_workspace_image(
                    str(child), transport_name=param_id, budget=budget
                )
                records.append((data, suffix, original_basename))
            snapshots[param_id] = ("directory", records)
            continue
        is_list = compact in _LIST_IMAGE_TRANSPORT_IDS or compact.endswith("imagepaths")
        if not is_list:
            if raw_value == "":
                snapshots[param_id] = ("empty", [])
                continue
            if not isinstance(raw_value, str):
                raise HTTPException(400, f"{param_id} must be a workspace image path")
            snapshots[param_id] = (
                "scalar",
                [_read_legacy_workspace_image(raw_value, transport_name=param_id, budget=budget)],
            )
            continue

        encoding = "list"
        values = raw_value
        if isinstance(raw_value, str):
            if not raw_value.strip():
                snapshots[param_id] = ("empty", [])
                continue
            try:
                values = json.loads(raw_value)
            except json.JSONDecodeError as exc:
                raise HTTPException(400, f"{param_id} must be a JSON image-path list") from exc
            encoding = "json-list"
        if not isinstance(values, list) or len(values) > MAX_IMAGE_PORTS:
            raise HTTPException(400, f"{param_id} must be a bounded image-path list")
        records: list[Optional[tuple[bytes, str, str]]] = []
        seen_names: set[str] = set()
        for value in values:
            if value is None:
                records.append(None)
            elif isinstance(value, str):
                record = _read_legacy_workspace_image(
                    value, transport_name=param_id, budget=budget
                )
                folded = record[2].casefold()
                if folded in seen_names:
                    raise HTTPException(400, f"{param_id} contains unsafe or colliding image names")
                seen_names.add(folded)
                records.append(record)
            else:
                raise HTTPException(400, f"{param_id} entries must be paths or null gaps")
        snapshots[param_id] = (encoding, records)
    return snapshots


def validate_private_image_request_budget(
    secondary_images: list[SecondaryImageRecord],
    legacy_image_transports: dict[str, tuple[str, list[Optional[tuple[bytes, str, str]]]]],
) -> None:
    payloads = [record[2] for record in secondary_images]
    payloads.extend(
        item[0]
        for _alias, (_encoding, records) in legacy_image_transports.items()
        for item in records
        if item is not None
    )
    if len(payloads) > MAX_IMAGE_PORTS:
        raise HTTPException(413, f"Image request exceeds the maximum of {MAX_IMAGE_PORTS} secondary images")
    if sum(map(len, payloads)) > MAX_GENERATION_MULTIPART_BYTES:
        raise HTTPException(413, "Image request exceeds the 512 MiB aggregate limit")


def snapshot_legacy_secondary_images(
    model_id: str,
    legacy_paths: object,
    budget: Optional[ImageRequestBudget] = None,
) -> list[SecondaryImageRecord]:
    """Convert a gap-preserving legacy path list into verified custody records."""

    if not isinstance(legacy_paths, list):
        raise HTTPException(400, "legacy extra_image_paths must be a bounded list with null gaps")
    image_ports = _declared_image_ports(model_id)
    capacity = max(0, len(image_ports) - 1)
    if len(legacy_paths) > capacity:
        raise HTTPException(400, "legacy extra_image_paths exceeds the requested model input capacity")

    records: list[SecondaryImageRecord] = []
    seen_names: set[str] = set()
    for offset, path_value in enumerate(legacy_paths):
        if path_value is None:
            continue
        if not isinstance(path_value, str):
            raise HTTPException(400, "legacy extra_image_paths entries must be paths or null gaps")
        data, suffix, original_basename = _read_legacy_workspace_image(
            path_value, budget=budget
        )
        folded = original_basename.casefold()
        if folded in seen_names:
            raise HTTPException(
                400,
                "legacy extra_image_paths contains unsafe or colliding image names",
            )
        seen_names.add(folded)
        slot, handle = image_ports[offset + 1]
        records.append((slot, handle, data, suffix, original_basename))
    return records


def validate_secondary_image_metadata(
    model_id: str,
    slots: list[int],
    handles: list[str],
) -> None:
    image_ports = _declared_image_ports(model_id)
    declared = dict(image_ports[1:])
    capacity = len(declared)
    if len(slots) > capacity:
        raise HTTPException(400, "secondary image count exceeds the requested model input capacity")
    if len(set(slots)) != len(slots):
        raise HTTPException(400, "secondary image slots must be unique")
    for slot, handle in zip(slots, handles, strict=True):
        if slot not in declared:
            allowed = ", ".join(map(str, sorted(declared)))
            raise HTTPException(400, f"secondary image slot must be one of: {allowed or 'none'}")
        expected = declared[slot]
        if handle != expected:
            raise HTTPException(400, f"secondary image handle for slot {slot} must be '{expected}'")


def _cleanup_private_input_dir(path: Path, *, raise_on_failure: bool = False) -> bool:
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            if path.exists() or path.is_symlink():
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
                else:
                    path.unlink()
            return True
        except FileNotFoundError:
            return True
        except Exception as exc:  # pragma: no cover - platform filesystem failures
            last_error = exc
            _generation_logger.warning(
                "private input cleanup failed path=%s attempt=%s/3 error=%s",
                path,
                attempt,
                exc,
            )
            if attempt < 3:
                time.sleep(0.02 * attempt)
    message = f"Failed to clean private input custody directory '{path}': {last_error}"
    _generation_logger.error(message)
    if raise_on_failure:
        raise RuntimeError(message) from last_error
    return False


def sweep_stale_private_inputs() -> list[Path]:
    """Remove custody left by an abrupt prior shutdown; active jobs are not recovered."""

    root = _private_inputs_root()
    if not root.exists() and not root.is_symlink():
        return []
    _assert_not_link_or_reparse(root)
    failures = [child for child in list(root.iterdir()) if not _cleanup_private_input_dir(child)]
    if failures:
        _generation_logger.error("stale private input sweep left %s path(s)", len(failures))
    else:
        try:
            root.rmdir()
        except FileNotFoundError:
            pass
        except OSError as exc:
            _generation_logger.warning("private input root cleanup failed path=%s error=%s", root, exc)
    return failures


def _log_job_progress(job: JobStatus) -> bool:
    snapshot = (job.status, job.progress, job.step)

    with _log_lock:
        if _last_logged_snapshots.get(job.job_id) == snapshot:
            return False
        _last_logged_snapshots[job.job_id] = snapshot

    _generation_logger.info(
        "generation job progress job_id=%s status=%s progress=%s step=%s",
        job.job_id,
        job.status,
        job.progress,
        job.step,
    )
    return True


def create_job() -> JobStatus:
    with _jobs_lock:
        while True:
            job_id = str(uuid.uuid4())
            if job_id not in _jobs and job_id not in _cancel_events:
                break
        job = JobStatus(job_id=job_id, status="pending", progress=0)
        _jobs[job_id] = job
        _cancel_events[job_id] = threading.Event()
    with _log_lock:
        _last_logged_snapshots.pop(job_id, None)
    return job


def create_generation_job(
    background_tasks: BackgroundTasks,
    *,
    params: dict,
    collection: str = "Default",
    image_bytes: Optional[bytes] = None,
    generation_input: bytes | Path | TypedModelInput | None = None,
    prompt: Optional[str] = None,
    model_id: Optional[str] = None,
    secondary_images: Optional[list[SecondaryImageRecord]] = None,
    legacy_image_transports: Optional[
        dict[str, tuple[str, list[Optional[tuple[bytes, str, str]]]]]
    ] = None,
    mesh_input_path: Optional[Path] = None,
) -> JobStatus:
    if image_bytes is not None and generation_input is not None:
        raise ValueError("Provide image_bytes or generation_input, not both.")
    if not model_id and generator_registry._active_id is None:
        raise HTTPException(400, "No model selected; provide model_id before generation")
    job = create_job()
    private_input_dir: Optional[Path] = None
    try:
        generation_params = dict(params)
        if secondary_images or legacy_image_transports or mesh_input_path is not None:
            generation_params, private_input_dir = _stage_secondary_images(
                job.job_id,
                generation_params,
                secondary_images or [],
                model_id=model_id or generator_registry._active_id,
                legacy_image_transports=legacy_image_transports or {},
                mesh_input_path=mesh_input_path,
            )
        background_tasks.add_task(
            _run_generation,
            job.job_id,
            image_bytes=image_bytes,
            generation_input=generation_input,
            prompt=prompt,
            params=generation_params,
            collection=collection,
            model_id=model_id,
            private_input_dir=private_input_dir,
        )
    except Exception:
        if private_input_dir is not None or _private_job_dir(job.job_id).exists():
            _cleanup_private_input_dir(_private_job_dir(job.job_id), raise_on_failure=True)
        with _jobs_lock:
            _jobs.pop(job.job_id, None)
            _cancel_events.pop(job.job_id, None)
        raise
    return job


def create_from_image_job(
    background_tasks: BackgroundTasks,
    image_bytes: bytes,
    params: dict,
    collection: str = "Default",
    *,
    model_id: Optional[str] = None,
    secondary_images: Optional[list[SecondaryImageRecord]] = None,
    legacy_image_transports: Optional[
        dict[str, tuple[str, list[Optional[tuple[bytes, str, str]]]]]
    ] = None,
    mesh_input_path: Optional[Path] = None,
) -> JobStatus:
    return create_generation_job(
        background_tasks,
        image_bytes=image_bytes,
        params=params,
        collection=collection,
        model_id=model_id,
        secondary_images=secondary_images,
        legacy_image_transports=legacy_image_transports,
        mesh_input_path=mesh_input_path,
    )


def _stage_secondary_images(
    job_id: str,
    params: dict,
    secondary_images: list[SecondaryImageRecord],
    *,
    model_id: Optional[str],
    legacy_image_transports: Optional[
        dict[str, tuple[str, list[Optional[tuple[bytes, str, str]]]]]
    ] = None,
    mesh_input_path: Optional[Path] = None,
) -> tuple[dict, Path]:
    """Snapshot secondary images and an optional mesh into private job custody."""

    if not model_id:
        raise HTTPException(400, "model_id is required for secondary image custody")
    image_ports = _declared_image_ports(model_id)
    image_port_map = dict(image_ports)
    legacy_image_transports = legacy_image_transports or {}
    secondary_ports = image_ports[1:]
    secondary_slot_to_index = {
        slot: index for index, (slot, _handle) in enumerate(secondary_ports)
    }
    records = list(secondary_images)

    if not records and not legacy_image_transports and mesh_input_path is None:
        raise HTTPException(400, "At least one private input is required")
    if len(records) > len(secondary_ports):
        raise HTTPException(400, "secondary image count exceeds the requested model input capacity")
    slots = [record[0] for record in records]
    if len(set(slots)) != len(slots):
        raise HTTPException(400, "secondary image slots must be unique")
    if any(slot not in secondary_slot_to_index for slot in slots):
        allowed = ", ".join(map(str, sorted(secondary_slot_to_index)))
        raise HTTPException(400, f"secondary image slot must be one of: {allowed or 'none'}")

    private_root = _private_inputs_root()
    job_dir = _private_job_dir(job_id)
    try:
        _assert_not_link_or_reparse(private_root)
        private_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        _assert_not_link_or_reparse(private_root)
        os.chmod(private_root, 0o700)
        job_dir.mkdir(mode=0o700, exist_ok=False)
        os.chmod(job_dir, 0o700)

        staged: list[tuple[int, str, str]] = []
        for record in records:
            slot, handle, data, suffix = record[:4]
            original_basename = record[4] if len(record) == 5 else None
            expected_handle = image_port_map[slot]
            if handle != expected_handle:
                raise HTTPException(
                    400,
                    f"secondary image handle for slot {slot} must be '{expected_handle}'",
                )
            safe_handle = re.sub(r"[^A-Za-z0-9_.-]+", "-", handle).strip("-.") or "image"
            output_path = job_dir / (
                original_basename or f"slot-{slot}-{safe_handle}{suffix}"
            )
            fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
            os.chmod(output_path, 0o600)
            staged.append((slot, handle, str(output_path)))

        staged_params = dict(params)
        if staged:
            last_image_index = max(secondary_slot_to_index[slot] for slot in slots)
            paths: list[Optional[str]] = [None] * (last_image_index + 1)
            staged_by_slot: dict[int, str] = {}
            for slot, _handle, path in staged:
                paths[secondary_slot_to_index[slot]] = path
                staged_by_slot[slot] = path
            staged_params["extra_image_paths"] = paths
            per_handle_aliases, list_aliases = _declared_secondary_image_transport_aliases(model_id)
            for alias, slot in per_handle_aliases.items():
                path = staged_by_slot.get(slot)
                if path is not None:
                    staged_params[alias] = path
            for alias in list_aliases:
                staged_params[alias] = list(paths)

        for alias_index, (alias, (encoding, snapshots)) in enumerate(
            legacy_image_transports.items(), start=1
        ):
            staged_paths: list[Optional[str]] = []
            safe_alias = re.sub(r"[^A-Za-z0-9_.-]+", "-", alias).strip("-.") or "image"
            directory_output = job_dir / f"legacy-{alias_index}-{safe_alias}"
            if snapshots:
                directory_output.mkdir(mode=0o700)
            for item_index, snapshot in enumerate(snapshots, start=1):
                if snapshot is None:
                    staged_paths.append(None)
                    continue
                data, _suffix, original_basename = snapshot
                output_path = directory_output / original_basename
                fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                os.chmod(output_path, 0o600)
                staged_paths.append(str(output_path))
            if encoding == "scalar":
                staged_params[alias] = staged_paths[0]
            elif encoding == "json-list":
                staged_params[alias] = json.dumps(staged_paths)
            elif encoding == "list":
                staged_params[alias] = staged_paths
            elif encoding == "empty":
                staged_params[alias] = ""
            elif encoding == "directory":
                staged_params[alias] = str(directory_output)
            else:  # pragma: no cover - internal invariant
                raise RuntimeError(f"Unsupported legacy image transport encoding: {encoding}")

        if mesh_input_path is not None:
            mesh_output = job_dir / f"mesh-input{mesh_input_path.suffix.casefold()}"
            source_flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
            source_fd = os.open(mesh_input_path, source_flags)
            try:
                source_info = os.fstat(source_fd)
                if not stat.S_ISREG(source_info.st_mode):
                    raise HTTPException(400, "mesh_path must reference a regular file")
                if source_info.st_size > MAX_MESH_INPUT_BYTES:
                    raise HTTPException(413, "Mesh input exceeds the 512 MiB limit")
                output_fd = os.open(mesh_output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(output_fd, "wb") as output_stream:
                    copied = 0
                    while True:
                        chunk = os.read(source_fd, 1024 * 1024)
                        if not chunk:
                            break
                        copied += len(chunk)
                        if copied > MAX_MESH_INPUT_BYTES:
                            raise HTTPException(413, "Mesh input exceeds the 512 MiB limit")
                        output_stream.write(chunk)
                if copied != source_info.st_size or os.fstat(source_fd).st_size != source_info.st_size:
                    raise HTTPException(400, "mesh_path changed while it was being snapshotted")
            finally:
                os.close(source_fd)
            os.chmod(mesh_output, 0o600)
            staged_params[HOST_MESH_PATH_PARAM] = str(mesh_output)
        return staged_params, job_dir
    except Exception:
        if job_dir.exists() or job_dir.is_symlink():
            _cleanup_private_input_dir(job_dir, raise_on_failure=True)
        raise


def create_from_video_job(
    background_tasks: BackgroundTasks,
    video_path: Path,
    params: dict,
    collection: str = "Default",
    *,
    model_id: Optional[str] = None,
) -> JobStatus:
    return create_generation_job(
        background_tasks,
        generation_input=video_path,
        params=params,
        collection=collection,
        model_id=model_id,
    )


def create_from_text_job(background_tasks: BackgroundTasks, prompt: str, params: dict, collection: str = "Default", *, model_id: Optional[str] = None) -> JobStatus:
    return create_generation_job(
        background_tasks,
        prompt=prompt,
        params=params,
        collection=collection,
        model_id=model_id,
    )


def create_from_none_job(background_tasks: BackgroundTasks, params: dict, collection: str = "Default", *, model_id: Optional[str] = None) -> JobStatus:
    return create_generation_job(
        background_tasks,
        image_bytes=b"",
        params=params,
        collection=collection,
        model_id=model_id,
    )


def create_from_scene_job(background_tasks: BackgroundTasks, params: dict, collection: str = "Default", *, model_id: Optional[str] = None) -> JobStatus:
    return create_generation_job(
        background_tasks,
        params=params,
        collection=collection,
        model_id=model_id,
    )


def create_from_artifact_job(
    background_tasks: BackgroundTasks,
    input_kind: str,
    artifact_path: Path,
    params: dict,
    collection: str = "Default",
    *,
    artifact_snapshot: object | None = None,
    model_id: Optional[str] = None,
) -> JobStatus:
    return create_generation_job(
        background_tasks,
        generation_input=TypedModelInput(input_kind, artifact_path, artifact_snapshot),
        params=params,
        collection=collection,
        model_id=model_id,
    )


def get_job(job_id: str) -> Optional[JobStatus]:
    return _jobs.get(job_id)


def require_job(job_id: str) -> JobStatus:
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return job


def get_job_status(job_id: str) -> JobStatus:
    return require_job(job_id)


def cancel_job(job_id: str) -> JobStatus:
    job = require_job(job_id)

    if job.status not in ("pending", "running"):
        return job

    _cancelled.add(job_id)

    cancel_event = _cancel_events.get(job_id)
    if cancel_event is not None:
        cancel_event.set()

    job.status = "cancelled"
    _log_job_progress(job)

    try:
        gen = generator_registry._generators.get(generator_registry._active_id)
        if gen is not None and hasattr(gen, "_proc") and gen._proc and gen._proc.poll() is None:
            gen._proc.kill()
            gen._loaded = False
            gen._proc = None
    except Exception:
        pass

    return job


def validate_image_upload(image: UploadFile) -> None:
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")


def _validate_decodable_image(data: bytes) -> tuple[bytes, str]:
    if not data:
        raise HTTPException(400, "Uploaded image is empty")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                image_format = image.format
                width, height = image.size
                if image_format not in {"PNG", "JPEG", "WEBP", "TIFF", "BMP"}:
                    raise HTTPException(400, "Uploaded file must decode as PNG, JPEG, WebP, or TIFF")
                if (
                    width <= 0
                    or height <= 0
                    or width > MAX_IMAGE_DIMENSION
                    or height > MAX_IMAGE_DIMENSION
                    or width * height > MAX_IMAGE_PIXELS
                ):
                    raise HTTPException(400, "Uploaded image dimensions exceed the safe limit")
                image.load()
    except HTTPException:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise HTTPException(400, "Uploaded image dimensions exceed the safe limit") from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        raise HTTPException(400, "Uploaded file is not a decodable PNG, JPEG, WebP, or TIFF image") from exc
    suffix = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp", "TIFF": ".tif", "BMP": ".bmp"}[image_format]
    return data, suffix


async def read_validated_image_upload(
    image: UploadFile,
    budget: Optional[ImageRequestBudget] = None,
) -> tuple[bytes, str]:
    """Read one upload with a hard bound and validate its content signature."""

    validate_image_upload(image)
    content_type = (image.content_type or "").split(";", 1)[0].strip().lower()
    if content_type not in SUPPORTED_IMAGE_CONTENT_TYPES:
        raise HTTPException(400, "File must be a PNG, JPEG, or WebP image")
    if budget is not None:
        budget.reserve(0)
    chunks = []
    total = 0
    while True:
        chunk = await image.read(min(1024 * 1024, MAX_IMAGE_UPLOAD_BYTES + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_IMAGE_UPLOAD_BYTES:
            raise HTTPException(413, "Image upload exceeds the 64 MiB limit")
        if budget is not None:
            budget.add_bytes(len(chunk))
        chunks.append(chunk)
    data = b"".join(chunks)
    if len(data) > MAX_IMAGE_UPLOAD_BYTES:
        raise HTTPException(413, "Image upload exceeds the 64 MiB limit")
    data, suffix = _validate_decodable_image(data)
    expected_type = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".tif": "image/tiff", ".bmp": "image/bmp"}[suffix]
    if content_type != expected_type:
        raise HTTPException(400, "Uploaded image content does not match its content type")
    return data, suffix


def validate_model_id(model_id: str) -> None:
    try:
        generator_registry.get_generator(model_id)
    except ValueError as exc:
        if generator_registry._active_id is None:
            raise HTTPException(400, f"No model selected; provide a valid model_id. {exc}") from exc
        raise HTTPException(400, str(exc))


def require_model_id(model_id: str) -> str:
    canonical_model_id = model_id.strip()
    if not canonical_model_id:
        raise HTTPException(400, "model_id is required")

    validate_model_id(canonical_model_id)
    return canonical_model_id


def require_model_input(model_id: str, expected_input: str) -> str:
    """Require one canonical model to match an endpoint's input contract."""
    canonical_model_id = require_model_id(model_id)

    try:
        declared_input = generator_registry.get_model_input(canonical_model_id)
    except (KeyError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc

    if declared_input != expected_input:
        raise HTTPException(
            400,
            (
                f"Model '{canonical_model_id}' expects input '{declared_input}' but "
                f"this endpoint received '{expected_input}'."
            ),
        )

    return canonical_model_id


def validate_model_input(model_id: str, expected_input: str) -> None:
    require_model_input(model_id, expected_input)


def parse_params_object(params: Optional[str], *, strict: bool) -> dict:
    if params in (None, ""):
        return {}

    try:
        parsed = json.loads(params)
    except (json.JSONDecodeError, TypeError) as exc:
        if strict:
            raise HTTPException(400, "params must be a valid JSON object") from exc
        return {}

    if parsed is None:
        return {}

    if not isinstance(parsed, dict):
        if strict:
            raise HTTPException(400, "params must be a JSON object")
        return {}

    return parsed


def validate_scene_manifest_path(scene_path: str) -> str:
    candidate = scene_path.strip().replace("\\", "/")
    if not candidate:
        raise HTTPException(400, "scene_path is required")

    posix_path = PurePosixPath(candidate)
    windows_path = PureWindowsPath(candidate)
    if posix_path.is_absolute() or windows_path.is_absolute():
        raise HTTPException(400, "scene_path must be workspace-relative")

    if posix_path.suffix.lower() != ".json":
        raise HTTPException(400, "scene_path must reference a .json scene manifest")

    if any(part == ".." for part in posix_path.parts):
        raise HTTPException(400, "scene_path must not traverse outside the workspace")

    workspace_root = WORKSPACE_DIR.resolve()
    scene_file = (workspace_root / posix_path).resolve()
    if workspace_root != scene_file and workspace_root not in scene_file.parents:
        raise HTTPException(400, "scene_path must stay within the workspace")
    if not scene_file.exists() or not scene_file.is_file():
        raise HTTPException(404, "scene_path was not found in the workspace")

    try:
        manifest = json.loads(scene_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "scene_path must reference a valid JSON scene manifest") from exc

    if not isinstance(manifest, dict):
        raise HTTPException(400, "scene manifest must be a JSON object")
    if manifest.get("schema") != SCENE_MANIFEST_SCHEMA:
        raise HTTPException(400, f"scene manifest schema must be {SCENE_MANIFEST_SCHEMA}")

    scene_root = manifest.get("sceneRoot")
    if not isinstance(scene_root, str) or not scene_root.strip():
        raise HTTPException(400, "scene manifest sceneRoot is required")

    return scene_file.relative_to(workspace_root).as_posix()


def resolve_validated_scene_manifest_path(scene_path: str) -> Path:
    workspace_relative = validate_scene_manifest_path(scene_path)
    return (WORKSPACE_DIR.resolve() / workspace_relative).resolve()


def get_workspace_path(output_path: Path) -> Optional[str]:
    try:
        return output_path.relative_to(WORKSPACE_DIR).as_posix()
    except ValueError:
        return None


def build_output_url(output_path: Path, collection: str = "Default") -> str:
    workspace_path = get_workspace_path(output_path)
    if workspace_path is not None:
        return f"/workspace/{workspace_path}"

    try:
        rel = output_path.relative_to(WORKSPACE_DIR)
        return f"/workspace/{rel.as_posix()}"
    except ValueError:
        return f"/workspace/{collection}/{output_path.name}"


def build_scene_candidate(output_path: Optional[Path], collection: str = "Default") -> Optional[SceneCandidate]:
    if output_path is None:
        return None

    workspace_path = get_workspace_path(output_path)
    if workspace_path is None:
        return None

    output_url = build_output_url(output_path, collection)
    actual_output_kind = detect_output_kind(output_path) or "mesh"

    return SceneCandidate(
        kind=actual_output_kind,
        workspace_path=workspace_path,
        output_url=output_url,
        display_name=output_path.name,
    )


def is_scene_manifest_path(output_path: Path) -> bool:
    if output_path.suffix.lower() != ".json":
        return False

    try:
        manifest = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False

    return isinstance(manifest, dict) and manifest.get("schema") == SCENE_MANIFEST_SCHEMA


def detect_output_kind(output_path: Optional[Path]) -> Optional[str]:
    if output_path is None:
        return None

    suffix = output_path.suffix.lower()
    if suffix == ".json" and is_scene_manifest_path(output_path):
        return "scene"

    if suffix in MESH_OUTPUT_SUFFIXES:
        return "mesh"

    if suffix in IMAGE_OUTPUT_SUFFIXES:
        return "image"

    if suffix in VIDEO_OUTPUT_SUFFIXES:
        return "video"

    if suffix in AUDIO_OUTPUT_SUFFIXES:
        return "audio"

    return None


async def _run_generation(
    job_id: str,
    *,
    image_bytes: Optional[bytes] = None,
    generation_input: bytes | Path | TypedModelInput | None = None,
    prompt: Optional[str] = None,
    params: dict,
    collection: str = "Default",
    model_id: Optional[str] = None,
    private_input_dir: Optional[Path] = None,
) -> None:
    collection = sanitize_collection_name(collection)
    job = _jobs[job_id]
    job.status = "running"
    _log_job_progress(job)

    def progress_cb(pct: int, step: str = "") -> None:
        job.progress = pct
        if step:
            job.step = step
        _log_job_progress(job)

    try:
        if job_id in _cancelled:
            job.status = "cancelled"
            _log_job_progress(job)
            return
        loop = asyncio.get_running_loop()

        target_model_id = model_id
        active = generator_registry.model_status(target_model_id) if target_model_id else generator_registry.active_status()
        get_generator = (
            lambda: generator_registry.get_loaded(target_model_id)
        ) if target_model_id else generator_registry.get_active

        if not active["loaded"]:
            model_name = active["name"]
            init_label = f"Downloading {model_name}…" if not active["downloaded"] else f"Loading {model_name}…"
            progress_cb(0, init_label)
            stop_load_evt = threading.Event()
            load_thread = threading.Thread(
                target=smooth_progress,
                args=(progress_cb, 0, 9, init_label, stop_load_evt, 4.0),
                daemon=True,
            )
            load_thread.start()
            try:
                gen = await loop.run_in_executor(None, get_generator)
            finally:
                stop_load_evt.set()
        else:
            gen = await loop.run_in_executor(None, get_generator)

        if job_id in _cancelled:
            return

        coll_dir = get_workspace_dir() / collection
        coll_dir.mkdir(parents=True, exist_ok=True)
        gen.outputs_dir = coll_dir

        cancel_event = _cancel_events.get(job_id)
        supports_cancel = "cancel_event" in inspect.signature(gen.generate).parameters
        if generation_input is None:
            generation_input = image_bytes if image_bytes is not None else b""
        if isinstance(generation_input, TypedModelInput):
            generation_input = revalidate_typed_model_input(
                get_workspace_dir(), generation_input
            )
            if generation_input.kind == "video" and not isinstance(gen, ExtensionProcess):
                generation_input = generation_input.path
        generation_params = dict(params)
        if prompt is not None:
            generation_params.setdefault("prompt", prompt)

        output_path = await loop.run_in_executor(
            None,
            lambda: gen.generate(generation_input, generation_params, progress_cb, cancel_event)
            if supports_cancel
            else gen.generate(generation_input, generation_params, progress_cb),
        )

        if job_id in _cancelled:
            return

        job.status = "done"
        job.progress = 100
        job.output_url = build_output_url(output_path, collection)
        job.output_kind = detect_output_kind(output_path)
        job.scene_candidate = build_scene_candidate(output_path, collection)
        _log_job_progress(job)

    except GenerationCancelled:
        job.status = "cancelled"
        _log_job_progress(job)
    except Exception:
        if job_id in _cancelled:
            return
        tb = traceback.format_exc()
        job.status = "error"
        job.error = tb.strip()
        _log_job_progress(job)
    finally:
        if private_input_dir is not None:
            if not _cleanup_private_input_dir(private_input_dir):
                cleanup_error = f"Private input custody cleanup failed: {private_input_dir}"
                if job.error:
                    job.error = f"{job.error}\n{cleanup_error}"
                else:
                    job.error = cleanup_error
                if job.status == "done":
                    job.status = "error"
                _log_job_progress(job)
