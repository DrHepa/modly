"""Typed model artifact inputs shared by the API, worker bridge, and runner."""
from dataclasses import dataclass
from pathlib import Path

from services.scene_input import validate_scene_input

SUPPORTED_ARTIFACT_INPUTS = frozenset({"scene", "capture", "video"})

# Transport parameters set by the host; callers must not be able to forge them.
RESERVED_ARTIFACT_PARAMS = frozenset({
    "artifact_path", "input_kind", "input_path", "scene_path", "scene_manifest_path",
    "capture_path", "capture_manifest_path", "video_path", "input_video_path",
    "typed_input_path",
})


@dataclass(frozen=True)
class TypedArtifactInput:
    kind: str
    path: Path
    snapshot: object | None = None


def validate_artifact_input(workspace: Path, kind: str, input_path: str) -> TypedArtifactInput:
    if kind not in SUPPORTED_ARTIFACT_INPUTS:
        raise ValueError(f"Unsupported artifact input kind: {kind}")
    if kind == "scene":
        return TypedArtifactInput(kind="scene", path=validate_scene_input(workspace, input_path))
    if kind == "capture":
        from services.capture_input import validate_capture_input
        return TypedArtifactInput(kind, validate_capture_input(workspace, input_path))
    if kind == "video":
        from services.video_input import validate_video_input
        path, snapshot = validate_video_input(workspace, input_path)
        return TypedArtifactInput(kind, path, snapshot)
    raise ValueError(f"Unsupported artifact input kind: {kind}")


def revalidate_artifact_input(workspace: Path, value: TypedArtifactInput) -> TypedArtifactInput:
    try:
        relative = value.path.resolve(strict=True).relative_to(workspace.resolve(strict=True))
    except (OSError, ValueError) as exc:
        raise ValueError("Artifact input is outside the workspace") from exc
    if value.kind in ("capture", "video"):
        from services.capture_input import TypedModelInput, revalidate_typed_model_input
        checked = revalidate_typed_model_input(workspace, TypedModelInput(value.kind, value.path, value.snapshot))
        return TypedArtifactInput(checked.kind, checked.path, checked.snapshot)
    return validate_artifact_input(workspace, value.kind, relative.as_posix())
