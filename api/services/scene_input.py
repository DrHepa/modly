"""Validation shared by the API and isolated model runner for scene inputs."""
import json
import math
import re
from pathlib import Path, PurePosixPath, PureWindowsPath

SCHEMA = "modly.scene-manifest.v1"
MANIFEST = "scene-manifest.json"


def validate_scene_model_inputs(node: dict) -> None:
    """Backward-compatible scene-only entry point for manifest discovery tests."""
    from services.capture_input import validate_typed_model_node_inputs

    try:
        validate_typed_model_node_inputs(node)
    except ValueError as exc:
        raise ValueError(
            f'model node "{node.get("id", "unknown")}" scene input supports only '
            "one scene and an optional text prompt; image and mesh inputs are not supported"
        ) from exc


def _relative(value: str, *, allow_dot: bool = False) -> Path:
    if not isinstance(value, str) or not value or value != value.strip() or "\x00" in value:
        raise ValueError("Scene path must be a nonempty workspace-relative path")
    value = value.replace("\\", "/")
    if value == "." and allow_dot:
        return Path(".")
    if (PurePosixPath(value).is_absolute() or PureWindowsPath(value).is_absolute()
            or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", value)
            or re.search(r"%(?:25|2e|2f|5c|00)", value, re.I)
            or re.search(r"%(?![0-9a-f]{2})", value, re.I)
            or any(part in ("", ".", "..") for part in value.split("/"))):
        raise ValueError("Scene path must be a safe workspace-relative path")
    return Path(*value.split("/"))


def _inside(path: Path, root: Path) -> Path:
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise ValueError("Scene path escapes its allowed root") from exc
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Scene referenced path must not use symlinks")
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise ValueError("Scene referenced path is missing or unreadable") from exc
    if not resolved.is_relative_to(root):
        raise ValueError("Scene path escapes its allowed root")
    return resolved


def validate_scene_input(workspace: Path, scene_path: str) -> Path:
    """Return a canonical manifest Path, rejecting traversal and symlink escapes.

    V1 sceneRoot is workspace-relative, except '.' denotes the manifest directory.
    An asset's path and preview references are sceneRoot-relative; workspacePath
    is always workspace-relative. Existence never determines which base applies.
    """
    root = workspace.resolve(strict=True)
    relative = _relative(scene_path)
    requested = root / relative
    if requested.name != MANIFEST:
        if requested.suffix.lower() == ".json":
            raise ValueError(f"Scene input accepts a directory or {MANIFEST}")
        requested = requested / MANIFEST
    try:
        manifest_path = _inside(requested, root)
        if not manifest_path.is_file():
            raise ValueError("Scene manifest is not a file")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("Scene manifest is missing or invalid JSON") from exc
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
        raise ValueError(f"Scene manifest schema must be {SCHEMA}")
    scene_root = _relative(manifest.get("sceneRoot"), allow_dot=True)
    # v1 sceneRoot is workspace-relative; only '.' means the manifest's directory.
    # Never select a base according to which unrelated path happens to exist.
    scene_root_candidate = manifest_path.parent if scene_root == Path(".") else root / scene_root
    root_path = _inside(scene_root_candidate, root)
    if not root_path.is_dir():
        raise ValueError("Scene root is not a directory")
    if not isinstance(manifest.get("assets"), list):
        raise ValueError("Scene manifest assets must be an array")
    for asset in manifest["assets"]:
        # Assets may be opaque extension metadata. Validate only references the
        # host understands; never silently resolve a supplied path outside workspace.
        if isinstance(asset, dict):
            for field, base in (("workspacePath", root), ("path", root_path)):
                if field not in asset:
                    continue
                target = _inside(base / _relative(asset[field]), root)
                if not target.is_file():
                    raise ValueError(f"Scene asset {field} is not a file")
    preview = manifest.get("preview", {})
    if not isinstance(preview, dict):
        raise ValueError("Scene preview must be an object")
    for name in ("image", "video"):
        if name in preview:
            relative_preview = _relative(preview[name])
            target = _inside(root_path / relative_preview, root)
            if not target.is_file():
                raise ValueError(f"Scene preview {name} is not a file")
    view = manifest.get("initialView")
    if view is not None:
        if not isinstance(view, dict):
            raise ValueError("Scene initialView must be an object")
        for field in ("position", "target", "up"):
            triple = view.get(field)
            if triple is None and field == "up":
                continue
            if (not isinstance(triple, list) or len(triple) != 3
                    or any(not isinstance(n, (int, float)) or isinstance(n, bool)
                           or not math.isfinite(n) for n in triple)):
                raise ValueError(f"Scene initialView {field} must be a finite numeric triple")
        if view["position"] == view["target"] or view.get("up") == [0, 0, 0]:
            raise ValueError("Scene initialView has degenerate camera vectors")
    return manifest_path


def revalidate_scene_manifest(workspace: Path, manifest_path: Path) -> Path:
    """Recheck the file immediately before model invocation in the worker."""
    root = workspace.resolve(strict=True)
    candidate = _inside(manifest_path, root)
    return validate_scene_input(root, candidate.relative_to(root).as_posix())
