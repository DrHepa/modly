"""Workspace-contained capture manifests and typed model-input validation."""

from __future__ import annotations

import json
import re
import struct
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath

SCHEMA = "modly.capture-manifest.v1"
MANIFEST = "capture-manifest.json"
TYPED_KINDS = ("capture", "scene", "video")


@dataclass(frozen=True)
class TypedModelInput:
    kind: str
    path: Path
    snapshot: object | None = None


def validate_typed_model_node_inputs(node: dict) -> None:
    """Typed model IPC carries one artifact and, optionally, one text prompt."""
    declared = node.get("inputs")
    inputs = list(_iter_declared_input_types(node))
    typed = [kind for kind in inputs if kind in TYPED_KINDS]
    primary = _declared_input_type(node.get("input")) or "image"
    if primary not in TYPED_KINDS and not typed:
        return
    if primary == "video":
        if declared is not None or inputs != ["video"]:
            raise ValueError(
                f'model node "{node.get("id", "unknown")}" video input supports exactly '
                "one video as its single input field"
            )
        return
    if (
        primary not in ("capture", "scene")
        or not isinstance(inputs, list)
        or inputs.count(primary) != 1
        or len(typed) != 1
        or inputs.count("text") > 1
        or any(kind not in (primary, "text") for kind in inputs)
    ):
        raise ValueError(
            f'model node "{node.get("id", "unknown")}" typed input supports exactly '
            "one scene or capture and an optional text prompt; mixed artifacts are not supported"
        )


def _declared_input_type(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        kind = value.get("type")
        if isinstance(kind, str):
            return kind
    return None


def _iter_declared_input_types(node: dict):
    declared = node.get("inputs")
    if declared is None:
        kind = _declared_input_type(node.get("input", "image"))
        if kind is not None:
            yield kind
        return

    if isinstance(declared, list):
        for item in declared:
            kind = _declared_input_type(item)
            if kind is not None:
                yield kind


def _relative(value: object, *, allow_dot: bool = False) -> Path:
    if not isinstance(value, str) or not value or value != value.strip() or "\x00" in value:
        raise ValueError("Capture path must be a nonempty workspace-relative path")
    value = value.replace("\\", "/")
    if value == "." and allow_dot:
        return Path(".")
    if (
        PurePosixPath(value).is_absolute()
        or PureWindowsPath(value).is_absolute()
        or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", value)
        or re.search(r"%(?:25|2e|2f|5c|00)", value, re.I)
        or re.search(r"%(?![0-9a-f]{2})", value, re.I)
        or any(part in ("", ".", "..") for part in value.split("/"))
    ):
        raise ValueError("Capture path must be a safe workspace-relative path")
    return Path(*value.split("/"))


def _inside(path: Path, root: Path) -> Path:
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise ValueError("Capture path escapes its allowed root") from exc
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Capture referenced path must not use symlinks")
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise ValueError("Capture referenced path is missing or unreadable") from exc
    if not resolved.is_relative_to(root):
        raise ValueError("Capture path escapes its allowed root")
    return resolved


def _positive_int(value: object, label: str) -> int:
    if type(value) is not int or value <= 0:
        raise ValueError(f"Capture {label} must be a positive integer")
    return value


def _validate_media_file(root: Path, relative: object, byte_size: object, label: str) -> Path:
    path = _inside(root / _relative(relative), root)
    if not path.is_file():
        raise ValueError(f"Capture {label} must be a regular file")
    expected = _positive_int(byte_size, f"{label} byteSize")
    if path.stat().st_size != expected:
        raise ValueError(f"Capture {label} byteSize does not match the file")
    return path


def _image_dimensions(path: Path) -> tuple[int, int]:
    """Read PNG/JPEG dimensions without adding an API-runtime imaging dependency."""
    with path.open("rb") as stream:
        header = stream.read(32)
        if header.startswith(b"\x89PNG\r\n\x1a\n") and len(header) >= 24:
            width, height = struct.unpack(">II", header[16:24])
            return width, height
        if header[:2] != b"\xff\xd8":
            raise ValueError("Capture frame must be PNG or JPEG")
        stream.seek(2)
        while True:
            marker_start = stream.read(1)
            if not marker_start:
                break
            if marker_start != b"\xff":
                continue
            marker = stream.read(1)
            while marker == b"\xff":
                marker = stream.read(1)
            if marker in (b"\xd8", b"\xd9"):
                continue
            raw_length = stream.read(2)
            if len(raw_length) != 2:
                break
            length = struct.unpack(">H", raw_length)[0]
            if marker and marker[0] in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                body = stream.read(5)
                if len(body) != 5:
                    break
                height, width = struct.unpack(">HH", body[1:5])
                return width, height
            stream.seek(max(0, length - 2), 1)
    raise ValueError("Capture frame image dimensions are unreadable")


def validate_capture_input(workspace: Path, capture_path: str) -> Path:
    root = Path(workspace).resolve(strict=True)
    relative = _relative(capture_path)
    requested = root / relative
    if requested.name != MANIFEST:
        if requested.suffix.lower() == ".json":
            raise ValueError(f"Capture input accepts a directory or {MANIFEST}")
        requested = requested / MANIFEST
    try:
        manifest_path = _inside(requested, root)
        if not manifest_path.is_file():
            raise ValueError("Capture manifest is not a file")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("Capture manifest is missing or invalid JSON") from exc
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
        raise ValueError(f"Capture manifest schema must be {SCHEMA}")
    capture_root = _relative(manifest.get("captureRoot"), allow_dot=True)
    capture_root_path = manifest_path.parent if capture_root == Path(".") else root / capture_root
    capture_root_path = _inside(capture_root_path, root)
    if not capture_root_path.is_dir():
        raise ValueError("Capture root is not a directory")
    provenance = manifest.get("provenance")
    if (
        not isinstance(provenance, dict)
        or not isinstance(provenance.get("source"), str)
        or not provenance["source"].strip()
        or provenance.get("ordering") not in ("manifest-index", "decode-index")
    ):
        raise ValueError("Capture provenance requires a source and deterministic ordering")
    kind = manifest.get("kind")
    if kind == "frames":
        if provenance["ordering"] != "manifest-index":
            raise ValueError("Frame capture ordering must be manifest-index")
        frames = manifest.get("frames")
        if not isinstance(frames, list) or not frames:
            raise ValueError("Frame capture requires a nonempty frames array")
        seen_paths: set[str] = set()
        for expected_index, frame in enumerate(frames):
            if not isinstance(frame, dict) or frame.get("index") != expected_index:
                raise ValueError("Capture frame indices must be contiguous and manifest-ordered")
            relative_path = frame.get("path")
            if not isinstance(relative_path, str) or relative_path in seen_paths:
                raise ValueError("Capture frame paths must be unique")
            seen_paths.add(relative_path)
            media = _validate_media_file(capture_root_path, relative_path, frame.get("byteSize"), f"frame {expected_index}")
            width = _positive_int(frame.get("width"), f"frame {expected_index} width")
            height = _positive_int(frame.get("height"), f"frame {expected_index} height")
            if _image_dimensions(media) != (width, height):
                raise ValueError(f"Capture frame {expected_index} dimensions do not match the file")
        if "video" in manifest and manifest["video"] is not None:
            raise ValueError("Frame capture must not also declare video")
    elif kind == "video":
        if provenance["ordering"] != "decode-index":
            raise ValueError("Video capture ordering must be decode-index")
        video = manifest.get("video")
        if not isinstance(video, dict):
            raise ValueError("Video capture requires a video object")
        _validate_media_file(capture_root_path, video.get("path"), video.get("byteSize"), "video")
        _positive_int(video.get("width"), "video width")
        _positive_int(video.get("height"), "video height")
        _positive_int(video.get("frameCount"), "video frameCount")
        if manifest.get("frames") not in (None, []):
            raise ValueError("Video capture must not also declare frames")
    else:
        raise ValueError("Capture kind must be frames or video")
    return manifest_path


def revalidate_capture_manifest(workspace: Path, manifest_path: Path) -> Path:
    root = Path(workspace).resolve(strict=True)
    candidate = _inside(Path(manifest_path), root)
    return validate_capture_input(root, candidate.relative_to(root).as_posix())


def revalidate_typed_model_input(workspace: Path, model_input: TypedModelInput) -> TypedModelInput:
    if not isinstance(model_input, TypedModelInput):
        raise TypeError("Typed model input is required")
    if model_input.kind == "capture":
        return TypedModelInput("capture", revalidate_capture_manifest(workspace, model_input.path))
    if model_input.kind == "scene":
        from services.scene_input import revalidate_scene_manifest

        return TypedModelInput("scene", revalidate_scene_manifest(workspace, model_input.path))
    if model_input.kind == "video":
        from services.video_input import VideoSnapshot, validate_video_input

        root = Path(workspace).resolve(strict=True)
        try:
            relative = Path(model_input.path).resolve(strict=True).relative_to(root)
        except (OSError, ValueError) as exc:
            raise ValueError("Video input is outside the workspace") from exc
        path, snapshot = validate_video_input(root, relative.as_posix())
        if isinstance(model_input.snapshot, VideoSnapshot) and snapshot != model_input.snapshot:
            raise ValueError("Video input changed after it was queued")
        return TypedModelInput("video", path, snapshot)
    raise ValueError("Typed model input kind must be capture, scene, or video")
