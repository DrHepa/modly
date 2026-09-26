"""Defensive model readiness checks for manifest-owned download_check paths."""
from pathlib import Path
import re

_SAFE_PART = re.compile(r"^[A-Za-z0-9._-]+$")


def validate_download_check(value: object) -> str:
    if not isinstance(value, str) or not value or value != value.strip() or "\\" in value:
        raise ValueError("download_check must be a safe relative path")
    parts = value.split("/")
    if any(not part or part in {".", ".."} or _SAFE_PART.fullmatch(part) is None for part in parts):
        raise ValueError("download_check must be a safe relative path")
    return value


def safe_download_check_exists(model_dir: Path, download_check: str) -> bool:
    """Return True only when an existing relative check target is inside model_dir.

    Unsafe, absolute, traversal, empty/dot, backslash, missing, and symlinked
    paths fail closed as not downloaded.
    """
    if not isinstance(download_check, str):
        return False
    try:
        check = validate_download_check(download_check)
    except ValueError:
        return False

    relative = Path(check)
    if relative.is_absolute():
        return False

    parts = relative.parts
    if not parts or any(part in ("", ".", "..") for part in parts):
        return False

    if model_dir.is_symlink():
        return False

    try:
        root = model_dir.resolve(strict=True)
    except (OSError, RuntimeError):
        return False

    current = model_dir
    for part in parts:
        current = current / part
        if current.is_symlink():
            return False

    target = model_dir / relative
    try:
        resolved = target.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError):
        return False
    stat = target.stat()
    if stat.st_size > 0 and target.is_file():
        return True
    if target.is_dir():
        try:
            return any(target.iterdir())
        except OSError:
            return False
    return False
