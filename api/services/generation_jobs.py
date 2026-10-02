import asyncio
import base64
from io import BytesIO
import inspect
import json
import logging
import os
import re
import re as _re
import shutil
import stat
import threading
import time
import traceback
import uuid
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Dict, Optional, Tuple, Union

from fastapi import BackgroundTasks, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

import services.generator_registry as registry
from schemas.generation import JobStatus, SceneCandidate
from services.artifact_input import TypedArtifactInput
from services.generator_registry import generator_registry
from services.generators.base import GenerationCancelled, smooth_progress
from services.capture_input import TypedModelInput, revalidate_typed_model_input


# Shared by both image routes so the two endpoints can't drift apart on
# what counts as a valid remesh mode the way they had drifted on `collection` before #238.
VALID_REMESH_MODES = ("quad", "triangle", "none")

_jobs: Dict[str, JobStatus] = {}
_cancelled: set = set()
_cancel_events: Dict[str, threading.Event] = {}
_last_logged_snapshots: Dict[str, Tuple[str, int, Optional[str]]] = {}
# Job state and its log snapshot share one short publication/retirement boundary.
# Reentrant because transition owners call _log_job_progress while holding it.
_log_lock = threading.RLock()
_generation_logger = logging.getLogger("modly.generation.jobs")
_completed_at: Dict[str, float] = {}
_job_generators: Dict[str, object] = {}
# A pinned generation owns the complete switch/load/generate lifecycle.  Keeping
# that lifecycle on one dedicated worker provides process-wide serialization
# without parking default-executor workers on a blocking lock acquisition.
_pinned_generation_executor = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="modly-pinned-generation",
)

_JOB_TTL = 1800  # purge terminal jobs after 30 minutes
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
PRIVATE_INPUT_OWNERSHIP_MARKER = ".modly-generation-custody"
PRIVATE_INPUT_OWNERSHIP_PREFIX = b"modly-generation-custody-v1\n"
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


def validate_primary_image_metadata(
    model_id: str,
    slot: Optional[int],
    handle: Optional[str],
) -> Optional[tuple[int, str]]:
    """Bind uploaded primary bytes to the actual declared physical image port."""

    image_ports = _declared_image_ports(model_id)
    if slot is None and handle is None:
        return image_ports[0] if image_ports else None
    if slot is None or handle is None or (slot, handle) not in image_ports:
        raise HTTPException(400, "primary image slot and handle must match a declared image input")
    return slot, handle


def _image_inputs_are_positional(model_id: str) -> bool:
    declared = generator_registry.get_manifest(model_id).get("inputs")
    return isinstance(declared, list) and all(isinstance(item, str) for item in declared)


def _secondary_image_ports(
    model_id: str,
    primary_image_slot: Optional[int] = None,
    primary_image_handle: Optional[str] = None,
) -> list[tuple[int, str]]:
    primary = validate_primary_image_metadata(model_id, primary_image_slot, primary_image_handle)
    if primary is None:
        return []
    positional = _image_inputs_are_positional(model_id)
    return [
        (slot, handle) for slot, handle in _declared_image_ports(model_id)
        if slot > primary[0]
    ] if positional else [
        (slot, handle) for slot, handle in _declared_image_ports(model_id)
        if slot != primary[0]
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
    *,
    primary_image_slot: Optional[int] = None,
    primary_image_handle: Optional[str] = None,
    include_primary: bool = False,
) -> tuple[dict[str, int], set[str]]:
    """Map exact declared ABI aliases to secondary slots or ordered path lists."""

    image_ports = _declared_image_ports(model_id)
    secondary_ports = image_ports if include_primary else _secondary_image_ports(
        model_id, primary_image_slot, primary_image_handle
    )
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
            if 1 <= image_ordinal <= len(image_ports):
                port = image_ports[image_ordinal - 1]
                if port in secondary_ports:
                    per_handle[param_id] = port[0]
            continue
        for slot, handle in secondary_ports:
            handle_compact = _compact_transport_id(handle)
            candidates = {f"{handle_compact}path", f"{handle_compact}imagepath"}
            if compact in candidates:
                per_handle[param_id] = slot
                break
    return per_handle, list_aliases


def reject_host_image_transport_params(model_id: str, params: dict) -> None:
    """Reject only declared image-port aliases owned by verified multipart custody."""

    aliases, lists = _declared_secondary_image_transport_aliases(model_id, include_primary=True)
    supplied = set(params) & (set(aliases) | lists)
    if HOST_MESH_PATH_PARAM in params and _manifest_declares_input_type(model_id, "mesh"):
        supplied.add(HOST_MESH_PATH_PARAM)
    if supplied:
        rendered = ", ".join(repr(key) for key in sorted(supplied))
        raise HTTPException(400, f"Image transport parameter(s) are server-managed: {rendered}")


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


def _validate_declared_client_param_value(param_id: str, schema: dict, value: object) -> None:
    """Reject obvious schema/type bypasses before values reach an extension runtime."""

    param_type = schema.get("type")
    if param_type == "select":
        options = schema.get("options")
        if isinstance(options, list) and options:
            allowed: list[object] = []
            for item in options:
                option_value = item.get("value") if isinstance(item, dict) else item
                if isinstance(option_value, (str, int, float, bool)):
                    allowed.append(option_value)
            if allowed and not any(
                type(value) is type(option_value) and value == option_value
                for option_value in allowed
            ):
                raise HTTPException(400, f"Parameter '{param_id}' must be a valid select value")
        if not isinstance(value, (str, int, float, bool)):
            raise HTTPException(400, f"Parameter '{param_id}' must be a valid select value")
    elif param_type == "int":
        if not isinstance(value, int) or isinstance(value, bool):
            raise HTTPException(400, f"Parameter '{param_id}' must be an integer")
    elif param_type == "float":
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise HTTPException(400, f"Parameter '{param_id}' must be a number")
    elif param_type == "string":
        if not isinstance(value, str):
            raise HTTPException(400, f"Parameter '{param_id}' must be a string")
    elif param_type == "boolean":
        if not isinstance(value, bool):
            raise HTTPException(400, f"Parameter '{param_id}' must be a boolean")


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
    """Allow only exact manifest-declared UI parameters from an API client."""

    if not isinstance(params, dict):
        raise HTTPException(400, "params must be a JSON object")
    declared = _declared_client_param_schema(model_id)
    per_handle_aliases, list_aliases = _declared_secondary_image_transport_aliases(model_id)
    image_transport_ids = (
        set(per_handle_aliases)
        | list_aliases
        | set(_declared_legacy_image_transport_schema(model_id))
    )
    undeclared: list[str] = []
    server_managed: list[str] = []
    for key in params:
        if not isinstance(key, str):
            raise HTTPException(400, "generation parameter names must be strings")
        if key not in declared:
            undeclared.append(key)
        elif (
            key in _TYPED_SERVER_TRANSPORT_IDS
            or key in extra_server_managed
            or key in image_transport_ids
        ):
            server_managed.append(key)
        else:
            _validate_declared_client_param_value(key, declared[key], params[key])
    if server_managed:
        rendered = ", ".join(repr(key) for key in sorted(server_managed))
        raise HTTPException(400, f"Image transport parameter(s) are server-managed: {rendered}")
    if undeclared:
        rendered = ", ".join(repr(key) for key in sorted(undeclared))
        raise HTTPException(400, f"Generation parameter(s) not declared by requested model: {rendered}")
    return dict(params)


def inject_trusted_host_transport_params(
    client_params: dict,
    trusted_params: dict[str, object],
) -> dict:
    """Inject route-derived transport aliases only after client UI allowlisting."""

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
    *,
    primary_image_slot: Optional[int] = None,
    primary_image_handle: Optional[str] = None,
) -> list[SecondaryImageRecord]:
    """Convert a declared legacy path list into verified custody records."""

    if not isinstance(legacy_paths, list):
        raise HTTPException(400, "legacy extra_image_paths must be a bounded list with null gaps")
    secondary_ports = _secondary_image_ports(model_id, primary_image_slot, primary_image_handle)
    capacity = len(secondary_ports)
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
        slot, handle = secondary_ports[offset]
        records.append((slot, handle, data, suffix, original_basename))
    return records


def validate_secondary_image_metadata(
    model_id: str,
    slots: list[int],
    handles: list[str],
    *,
    primary_image_slot: Optional[int] = None,
    primary_image_handle: Optional[str] = None,
) -> None:
    declared = dict(_secondary_image_ports(model_id, primary_image_slot, primary_image_handle))
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
    failures: list[Path] = []
    for child in list(root.iterdir()):
        # This root may predate custody. Never delete unrelated user children.
        if _is_link_or_reparse(child) or not child.is_dir():
            continue
        marker = child / PRIVATE_INPUT_OWNERSHIP_MARKER
        try:
            expected = PRIVATE_INPUT_OWNERSHIP_PREFIX + child.name.encode("utf-8")
            if _is_link_or_reparse(marker):
                continue
            marker_fd = os.open(marker, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(marker_fd, "rb") as marker_stream:
                info = os.fstat(marker_stream.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_size != len(expected)
                        or marker_stream.read(len(expected) + 1) != expected):
                    continue
        except (FileNotFoundError, OSError, UnicodeError):
            continue
        if not _cleanup_private_input_dir(child):
            failures.append(child)
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
    with _log_lock:
        if _jobs.get(job.job_id) is not job:
            return False
        snapshot = (job.status, job.progress, job.step)
        previous = _last_logged_snapshots.get(job.job_id)
        if previous == snapshot:
            return False
        _last_logged_snapshots[job.job_id] = snapshot
        # Extension step text can echo prompts, paths or exception details. Keep
        # it intact in the API/snapshot, but log only whether it changed.
        step_changed = snapshot[2] != (previous[2] if previous else None)
        _generation_logger.info(
            "generation job progress job_id=%s status=%s progress=%s step_changed=%s",
            job.job_id,
            snapshot[0],
            snapshot[1],
            step_changed,
        )
    return True


def _purge_old_jobs() -> None:
    cutoff = time.monotonic() - _JOB_TTL
    with _log_lock:
        stale = [jid for jid, t in _completed_at.items() if t < cutoff]
        for jid in stale:
            _jobs.pop(jid, None)
            _cancelled.discard(jid)
            _cancel_events.pop(jid, None)
            _job_generators.pop(jid, None)
            _completed_at.pop(jid, None)
            _last_logged_snapshots.pop(jid, None)


def sanitize_collection(collection: str) -> str:
    """Normalize a caller-supplied collection name into a safe workspace subfolder.

    The value becomes a directory under the workspace (``WORKSPACE_DIR / collection``), so a
    name carrying a path separator or a drive/wildcard character could escape that root or fail
    to create on Windows. Such a name, or an empty one, falls back to ``"Default"`` rather than
    raising, because a generation the caller already paid for should still land somewhere
    sensible. Shared so every entry point that routes output into a collection sanitizes it the
    same way; a second copy of this rule is a second chance to forget a character.

    Legality and containment are different questions, so they are asked separately: the
    reserved characters above are refused outright, and containment is put to the path
    library rather than to the spelling -- the same ``relative_to`` check
    ``generator_registry._path_belongs_to`` uses, so the two containment checks in this
    backend agree rather than drifting on their own semantics. A character blocklist alone
    lets ``".."`` through -- it contains none of the listed characters -- and
    ``WORKSPACE_DIR / ".."`` resolves to the workspace's *parent*, so the generated mesh
    would land outside the root.

    A name ending in a dot or space is refused too, even once it clears both checks above:
    Windows silently drops trailing dots/spaces from the final path component it actually
    creates, so ``mkdir()`` on ``"Exports..."`` lands in the very same folder as
    ``"Exports"`` -- two collections that look distinct to this function would otherwise
    merge their output on disk without either caller being told.
    """
    collection = (collection or "").strip()
    if (
        not collection
        or collection.casefold() == PRIVATE_INPUTS_DIRNAME.casefold()
        or _re.search(r'[/:*?"<>|\\]', collection)
        or collection != collection.rstrip(". ")
    ):
        return "Default"

    try:
        (registry.WORKSPACE_DIR / collection).resolve().relative_to(
            registry.WORKSPACE_DIR.resolve()
        )
    except (OSError, ValueError):
        return "Default"

    return collection


sanitize_collection_name = sanitize_collection


def create_job() -> JobStatus:
    _purge_old_jobs()
    with _log_lock:
        while True:
            job_id = str(uuid.uuid4())
            if job_id not in _jobs and job_id not in _cancel_events:
                break
        job = JobStatus(job_id=job_id, status="pending", progress=0)
        _jobs[job_id] = job
        _cancel_events[job_id] = threading.Event()
        _last_logged_snapshots.pop(job_id, None)
    return job


def create_generation_job(
    background_tasks: BackgroundTasks,
    model_input: Union[bytes, Path, TypedArtifactInput, TypedModelInput],
    params: dict,
    collection: str = "Default",
    output_kind: str = "mesh",
    model_id: Optional[str] = None,
    secondary_images: Optional[list[SecondaryImageRecord]] = None,
    legacy_image_transports: Optional[
        dict[str, tuple[str, list[Optional[tuple[bytes, str, str]]]]]
    ] = None,
    mesh_input_path: Optional[Path] = None,
    primary_image_slot: Optional[int] = None,
    primary_image_handle: Optional[str] = None,
) -> JobStatus:
    job = create_job()
    private_input_dir: Optional[Path] = None
    try:
        generation_params = dict(params)
        if secondary_images or legacy_image_transports or mesh_input_path is not None:
            model_id = model_id or generator_registry._active_id
            generation_params, private_input_dir = _stage_secondary_images(
                job.job_id, generation_params, secondary_images or [],
                model_id=model_id,
                legacy_image_transports=legacy_image_transports or {},
                mesh_input_path=mesh_input_path,
                primary_image_slot=primary_image_slot,
                primary_image_handle=primary_image_handle,
            )
        background_tasks.add_task(
            _run_generation, job.job_id, model_input, generation_params,
            sanitize_collection(collection), output_kind, model_id,
            private_input_dir=private_input_dir,
        )
    except Exception:
        try:
            if private_input_dir is not None:
                _cleanup_private_input_dir(private_input_dir, raise_on_failure=True)
        finally:
            with _log_lock:
                _jobs.pop(job.job_id, None)
                _cancel_events.pop(job.job_id, None)
                _last_logged_snapshots.pop(job.job_id, None)
        raise
    return job


def create_from_image_job(
    background_tasks: BackgroundTasks,
    image_bytes: bytes,
    params: dict,
    collection: str = "Default",
    output_kind: str = "mesh",
    model_id: Optional[str] = None,
    secondary_images: Optional[list[SecondaryImageRecord]] = None,
    legacy_image_transports: Optional[
        dict[str, tuple[str, list[Optional[tuple[bytes, str, str]]]]]
    ] = None,
    mesh_input_path: Optional[Path] = None,
    primary_image_slot: Optional[int] = None,
    primary_image_handle: Optional[str] = None,
) -> JobStatus:
    return create_generation_job(
        background_tasks, image_bytes, params, collection, output_kind, model_id,
        secondary_images=secondary_images,
        legacy_image_transports=legacy_image_transports,
        mesh_input_path=mesh_input_path,
        primary_image_slot=primary_image_slot,
        primary_image_handle=primary_image_handle,
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
    primary_image_slot: Optional[int] = None,
    primary_image_handle: Optional[str] = None,
) -> tuple[dict, Path]:
    """Snapshot secondary images and an optional mesh into private job custody."""

    if not model_id:
        raise HTTPException(400, "model_id is required for secondary image custody")
    image_ports = _declared_image_ports(model_id)
    image_port_map = dict(image_ports)
    legacy_image_transports = legacy_image_transports or {}
    secondary_ports = _secondary_image_ports(model_id, primary_image_slot, primary_image_handle)
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
    job_dir_created = False
    try:
        _assert_not_link_or_reparse(private_root)
        private_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        _assert_not_link_or_reparse(private_root)
        os.chmod(private_root, 0o700)
        job_dir.mkdir(mode=0o700, exist_ok=False)
        job_dir_created = True
        os.chmod(job_dir, 0o700)
        marker_fd = os.open(job_dir / PRIVATE_INPUT_OWNERSHIP_MARKER,
                            os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(marker_fd, "wb") as marker_stream:
            marker_stream.write(PRIVATE_INPUT_OWNERSHIP_PREFIX + job_id.encode("utf-8"))

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
            if _image_inputs_are_positional(model_id):
                # CURRENT positional extras are resolved-only, not declaration gaps.
                paths = [path for _slot, _handle, path in sorted(staged)]
            staged_params["extra_image_paths"] = paths
            per_handle_aliases, list_aliases = _declared_secondary_image_transport_aliases(
                model_id, primary_image_slot=primary_image_slot,
                primary_image_handle=primary_image_handle,
            )
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
        if job_dir_created:
            _cleanup_private_input_dir(job_dir, raise_on_failure=True)
        raise


def create_from_video_job(
    background_tasks: BackgroundTasks,
    video_path: Path,
    params: dict,
    collection: str = "Default",
    output_kind: str = "mesh",
    model_id: Optional[str] = None,
) -> JobStatus:
    return create_generation_job(
        background_tasks, video_path, params, collection, output_kind, model_id,
    )


def create_from_text_job(
    background_tasks: BackgroundTasks,
    prompt: str,
    params: dict,
    collection: str = "Default",
    output_kind: str = "mesh",
    model_id: Optional[str] = None,
) -> JobStatus:
    # Legacy generators still consume image bytes. Match the existing text-only
    # workflow ABI with a valid placeholder PNG and both prompt aliases, while
    # leaving scheduling, variants, cancellation and artifacts to the shared owner.
    placeholder = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    )
    generation_params = dict(params)
    generation_params.setdefault("prompt", prompt)
    generation_params.setdefault("text", prompt)
    return create_generation_job(
        background_tasks, placeholder, generation_params, collection, output_kind, model_id,
    )


def create_from_none_job(
    background_tasks: BackgroundTasks,
    params: dict,
    collection: str = "Default",
    output_kind: str = "mesh",
    model_id: Optional[str] = None,
) -> JobStatus:
    if model_id is not None:
        model_id = require_model_input(model_id, "none")
    return create_generation_job(
        background_tasks, b"", params, collection, output_kind, model_id,
    )


def create_from_artifact_job(
    background_tasks: BackgroundTasks, input_kind: str, artifact_path: Path,
    params: dict, collection: str = "Default", *, artifact_snapshot: object | None = None,
    model_id: Optional[str] = None,
) -> JobStatus:
    artifact = (TypedArtifactInput(input_kind, artifact_path) if input_kind == "scene"
                else TypedModelInput(input_kind, artifact_path, artifact_snapshot))
    output_kind = generator_registry.get_manifest(model_id).get("output", "mesh") if model_id is not None else "mesh"
    return create_generation_job(background_tasks, artifact, params, collection, output_kind, model_id)


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
    with _log_lock:
        job = require_job(job_id)

        if job.status not in ("pending", "running"):
            return job

        _cancelled.add(job_id)

        cancel_event = _cancel_events.get(job_id)
        if cancel_event is not None:
            cancel_event.set()

        job.status = "cancelled"
        _completed_at[job_id] = time.monotonic()
        _log_job_progress(job)
        gen = _job_generators.get(job_id)

    try:
        # Queued cancellation must never kill the generator owned by another job.
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

def validate_model_id(model_id: str) -> dict:
    try:
        generator_registry.get_generator(model_id)
        return generator_registry.get_manifest(model_id)
    except (KeyError, ValueError) as exc:
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


def get_workspace_path(output_path: Path) -> Optional[str]:
    try:
        return output_path.resolve().relative_to(registry.WORKSPACE_DIR.resolve()).as_posix()
    except ValueError:
        return None


def build_output_url(output_path: Path, collection: str = "Default") -> str:
    workspace_path = get_workspace_path(output_path)
    if workspace_path is not None:
        return f"/workspace/{workspace_path}"

    return f"/workspace/{collection}/{output_path.name}"


def build_scene_candidate(output_path: Optional[Path], collection: str = "Default") -> Optional[SceneCandidate]:
    if output_path is None:
        return None

    workspace_path = get_workspace_path(output_path)
    if workspace_path is None:
        return None

    output_url = build_output_url(output_path, collection)
    return SceneCandidate(
        kind=detect_output_kind(output_path) or "mesh",
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

    return isinstance(manifest, dict) and manifest.get("schema") == "modly.scene-manifest.v1"


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
    model_input: Union[bytes, Path, TypedArtifactInput, TypedModelInput],
    params: dict,
    collection: str = "Default",
    output_kind: str = "mesh",
    model_id: Optional[str] = None,
    private_input_dir: Optional[Path] = None,
) -> None:
    collection = sanitize_collection_name(collection)
    # Pinned jobs share one model lifecycle. Switching is deliberately deferred
    # until this job runs on the dedicated worker: request-time switches can
    # otherwise unload a running job or leave A loading beside B.  Crucially,
    # queued jobs are executor work items rather than default-executor threads
    # blocked on a lock, so cancelling a waiter cannot orphan queue ownership or
    # starve the worker that performs generation.
    loop = asyncio.get_running_loop()
    executor = _pinned_generation_executor if model_id is not None else None
    # Shown while this job waits behind another one on the single worker;
    # _run_generation_impl clears it as soon as the job actually starts.
    with _log_lock:
        queued_job = _jobs.get(job_id)
        if queued_job is not None and executor is not None and queued_job.status == "pending":
            queued_job.step = "Waiting for the previous generation…"
            _log_job_progress(queued_job)
    started = threading.Event()

    def cleanup_private_inputs() -> None:
        if private_input_dir is None or _cleanup_private_input_dir(private_input_dir):
            return
        with _log_lock:
            owned_job = _jobs.get(job_id)
            if owned_job is not None and owned_job is queued_job:
                message = f"Private input custody cleanup failed: {private_input_dir}"
                owned_job.error = f"{owned_job.error}\n{message}" if owned_job.error else message
                if owned_job.status == "done":
                    owned_job.status = "error"
                _log_job_progress(owned_job)

    def run_owned_generation() -> None:
        started.set()
        try:
            _run_generation_impl(job_id, model_input, params, collection, output_kind, model_id)
        finally:
            cleanup_private_inputs()

    future = (
        loop.run_in_executor(executor, run_owned_generation)
        if private_input_dir is not None else
        loop.run_in_executor(executor, _run_generation_impl,
            job_id, model_input, params, collection, output_kind, model_id)
    )
    try:
        await future
    except asyncio.CancelledError:
        # asyncio cancellation attempts to cancel a queued concurrent future.
        # If it has already begun, the event lets the generator stop safely.
        with _log_lock:
            job = _jobs.get(job_id)
            if job is queued_job and job is not None and job.status in ("pending", "running"):
                _cancelled.add(job_id)
                cancel_event = _cancel_events.get(job_id)
                if cancel_event is not None:
                    cancel_event.set()
                job.status = "cancelled"
                _completed_at[job_id] = time.monotonic()
                _log_job_progress(job)
        if private_input_dir is not None and not started.is_set():
            # A cancelled waiter never crosses inference; a worker that races
            # this cleanup sees its cancelled job before using custody.
            cleanup_private_inputs()
        raise


def _run_generation_impl(
    job_id: str,
    model_input: Union[bytes, Path, TypedArtifactInput, TypedModelInput],
    params: dict,
    collection: str,
    output_kind: str,
    model_id: Optional[str],
) -> None:
    with _log_lock:
        job = _jobs.get(job_id)
        if job is None or job.status != "pending" or job_id in _cancelled:
            return
        job.status = "running"
        job.step = None
        _log_job_progress(job)

    def progress_cb(pct: int, step: str = "") -> None:
        if job.status != "running":
            return
        # Monotonic: the loading phase walks the bar up on a background thread and
        # extensions then report their own 0->100 scale, so an unguarded assignment
        # yanks the bar backwards on the first generation progress message.
        if pct > job.progress:
            next_progress = pct
        else:
            next_progress = job.progress
        with _log_lock:
            # Cancellation/retirement may have won after the optimistic read.
            if _jobs.get(job_id) is not job or job.status != "running":
                return
            job.progress = max(job.progress, next_progress)
            if step:
                job.step = step
            _log_job_progress(job)

    try:
        # Refuse a selected weight variant that is not installed before loading
        # anything. Uses the job's model: the switch to it happens below.
        generator_registry.assert_weight_variant_installed(params, model_id)

        # Check if the model needs to be loaded BEFORE calling the generator
        # getter, because that call can load the model in a blocking manner.
        get_generator = (lambda: generator_registry.activate_ready_generator(model_id)) \
            if model_id is not None else generator_registry.get_active
        if model_id is not None:
            pinned_generator = generator_registry.get_generator(model_id)
            with _log_lock:
                if _jobs.get(job_id) is not job or job.status != "running":
                    return
                _job_generators[job_id] = pinned_generator
        status_reader = (lambda: generator_registry.model_status(model_id)) \
            if model_id is not None else generator_registry.active_status
        status = status_reader()
        if not status["loaded"]:
            active = status
            model_name = active['name']
            init_label = f"Downloading {model_name}…" if not active['downloaded'] else f"Loading {model_name}…"
            progress_cb(0, init_label)
            stop_load_evt = threading.Event()
            load_thread = threading.Thread(
                target=smooth_progress,
                args=(progress_cb, 0, 9, init_label, stop_load_evt, 4.0),
                daemon=True,
            )
            load_thread.start()
            try:
                gen = get_generator()
            finally:
                stop_load_evt.set()
        else:
            gen = get_generator()

        with _log_lock:
            if _jobs.get(job_id) is not job or job.status != "running":
                return
            _job_generators[job_id] = gen

        # Direct output to the collection subfolder
        coll_dir = registry.WORKSPACE_DIR / collection
        coll_dir.mkdir(parents=True, exist_ok=True)
        gen.outputs_dir = coll_dir

        cancel_event = _cancel_events.get(job_id)
        if isinstance(model_input, TypedArtifactInput) and model_input.kind == "scene":
            # Revalidate just before crossing the inference boundary. The
            # subprocess runner repeats this check inside the worker.
            from services.artifact_input import revalidate_artifact_input
            model_input = revalidate_artifact_input(registry.WORKSPACE_DIR, model_input)
            supports_cancel = "cancel_event" in inspect.signature(gen.generate_artifact).parameters
            output_path = (
                gen.generate_artifact(model_input.kind, model_input.path, params, progress_cb, cancel_event)
                if supports_cancel
                else gen.generate_artifact(model_input.kind, model_input.path, params, progress_cb)
            )
        else:
            if isinstance(model_input, TypedArtifactInput):
                model_input = TypedModelInput(model_input.kind, model_input.path, model_input.snapshot)
            if isinstance(model_input, TypedModelInput):
                model_input = revalidate_typed_model_input(registry.WORKSPACE_DIR, model_input)
                from services.extension_process import ExtensionProcess
                if model_input.kind == "video" and not isinstance(gen, ExtensionProcess):
                    model_input = model_input.path
            if isinstance(model_input, Path):
                from services.generation_inputs import validate_video_input_path
                model_input = validate_video_input_path(
                    model_input, workspace_dir=registry.WORKSPACE_DIR,
                )
            supports_cancel = "cancel_event" in inspect.signature(gen.generate).parameters
            output_path = (
                gen.generate(model_input, params, progress_cb, cancel_event)
                if supports_cancel
                else gen.generate(model_input, params, progress_cb)
            )

        if job_id in _cancelled:
            return

        output_path = Path(output_path).resolve(strict=True)
        if output_kind == "scene":
            from services.scene_input import validate_scene_input
            try:
                output_relative = output_path.relative_to(registry.WORKSPACE_DIR.resolve())
                output_path = validate_scene_input(registry.WORKSPACE_DIR, output_relative.as_posix())
            except (OSError, ValueError) as exc:
                raise ValueError("Generated scene output is not a valid workspace scene") from exc

        output_url = build_output_url(output_path, collection)
        # The private candidate is a mesh insertion descriptor, not a generic
        # artifact wrapper: scene/image/audio outputs retain only their URL.
        scene_candidate = build_scene_candidate(output_path, collection) if output_kind == "mesh" else None
        with _log_lock:
            if _jobs.get(job_id) is not job or job.status != "running":
                return
            job.status = "done"
            job.progress = 100
            _completed_at[job_id] = time.monotonic()
            job.output_url = output_url
            job.output_kind = detect_output_kind(output_path)
            job.scene_candidate = scene_candidate
            _log_job_progress(job)

    except GenerationCancelled:
        with _log_lock:
            if _jobs.get(job_id) is job and job.status == "running":
                job.status = "cancelled"
                _completed_at[job_id] = time.monotonic()
                _log_job_progress(job)
    except Exception:
        tb = traceback.format_exc()
        with _log_lock:
            if _jobs.get(job_id) is job and job.status == "running":
                job.status = "error"
                job.error = tb.strip()
                _completed_at[job_id] = time.monotonic()
                _log_job_progress(job)
    finally:
        with _log_lock:
            if _jobs.get(job_id) is job:
                _job_generators.pop(job_id, None)
