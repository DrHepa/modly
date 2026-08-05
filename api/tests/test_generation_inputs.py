from pathlib import Path

import pytest

from services.generation_inputs import (
    GenerationInputPathError,
    resolve_workspace_video_input_path,
    validate_video_input_path,
)


def test_resolves_workspace_relative_video_path(tmp_path):
    workspace_dir = tmp_path / "workspace"
    video_path = workspace_dir / "Workflows" / "clips" / "turntable.capture"
    video_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"video")

    assert resolve_workspace_video_input_path(
        "Workflows/clips/turntable.capture",
        workspace_dir=workspace_dir,
    ) == video_path.resolve()


@pytest.mark.parametrize(
    "candidate",
    [
        "/tmp/external.mp4",
        "../external.mp4",
        "Workflows/../../external.mp4",
        r"C:\external.mp4",
        r"Workflows\..\..\external.mp4",
    ],
)
def test_rejects_absolute_and_traversal_workspace_paths(candidate, tmp_path):
    with pytest.raises(GenerationInputPathError):
        resolve_workspace_video_input_path(
            candidate,
            workspace_dir=tmp_path / "workspace",
        )


def test_rejects_workspace_symlink_escape(tmp_path):
    workspace_dir = tmp_path / "workspace"
    workspace_dir.mkdir()
    external_video = tmp_path / "external.mp4"
    external_video.write_bytes(b"video")
    symlink_path = workspace_dir / "escape.mp4"
    try:
        symlink_path.symlink_to(external_video)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is unavailable on this platform")

    with pytest.raises(GenerationInputPathError):
        resolve_workspace_video_input_path(
            "escape.mp4",
            workspace_dir=workspace_dir,
        )


@pytest.mark.parametrize("relative_path", ["missing.mp4", "folder"])
def test_rejects_missing_and_non_file_paths(relative_path, tmp_path):
    workspace_dir = tmp_path / "workspace"
    workspace_dir.mkdir()
    if relative_path == "folder":
        (workspace_dir / relative_path).mkdir()

    with pytest.raises(GenerationInputPathError):
        resolve_workspace_video_input_path(
            relative_path,
            workspace_dir=workspace_dir,
        )


def test_rejects_external_absolute_video_path(tmp_path):
    workspace_dir = tmp_path / "workspace"
    workspace_dir.mkdir()
    external_video = tmp_path / "external.capture"
    external_video.write_bytes(b"video")

    with pytest.raises(GenerationInputPathError):
        validate_video_input_path(
            external_video,
            workspace_dir=workspace_dir,
        )
