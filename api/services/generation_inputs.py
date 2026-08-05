"""Validated file-backed inputs for model generation."""

from pathlib import Path, PurePosixPath, PureWindowsPath


MODLY_WORKSPACE_DIR_ENV = "MODLY_WORKSPACE_DIR"


class GenerationInputPathError(ValueError):
    """Raised when a file-backed generation input is outside the Modly workspace."""


def resolve_workspace_video_input_path(
    relative_path: str,
    *,
    workspace_dir: Path,
) -> Path:
    """Resolve a user-supplied workspace-relative video path safely."""
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise GenerationInputPathError("Video path must be a non-empty workspace-relative string.")

    normalized = relative_path.replace("\\", "/")
    posix_path = PurePosixPath(normalized)
    windows_path = PureWindowsPath(relative_path)
    if (
        posix_path.is_absolute()
        or windows_path.is_absolute()
        or bool(windows_path.drive)
        or bool(windows_path.root)
    ):
        raise GenerationInputPathError("Video path must be workspace-relative.")
    if ".." in posix_path.parts or ".." in windows_path.parts:
        raise GenerationInputPathError("Video path must not traverse outside the workspace.")

    candidate = Path(workspace_dir).expanduser().resolve() / Path(*posix_path.parts)
    return validate_video_input_path(
        candidate,
        workspace_dir=workspace_dir,
    )


def validate_video_input_path(
    video_path: Path,
    *,
    workspace_dir: Path,
) -> Path:
    """Canonicalize a video path and constrain it to the Modly workspace."""
    candidate = Path(video_path).expanduser()
    if not candidate.is_absolute():
        raise GenerationInputPathError("Validated video path must be absolute.")

    try:
        resolved = candidate.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise GenerationInputPathError("Video path does not reference an existing file.") from exc

    workspace_root = Path(workspace_dir).expanduser().resolve()
    if not _is_within(resolved, workspace_root):
        raise GenerationInputPathError("Video path must stay within the workspace.")
    if not resolved.is_file():
        raise GenerationInputPathError("Video path must reference a regular file.")

    return resolved


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True
