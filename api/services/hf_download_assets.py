"""Pinned, allowlisted Hugging Face asset plans for Modly model nodes."""

from __future__ import annotations

import asyncio
import hashlib
import re
import threading
from collections.abc import AsyncIterator, Callable, Mapping
from functools import partial
from pathlib import Path, PurePosixPath
from typing import Any


_COMMIT_RE = re.compile(r"^[0-9a-fA-F]{40}$")
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_CHUNK_BYTES = 1024 * 1024
_VERIFIED_FILE_CACHE: dict[tuple[str, int, int, str], bool] = {}
_VERIFIED_FILE_CACHE_LOCK = threading.Lock()


class HfDownloadManifestError(ValueError):
    """Raised when an hf_downloads manifest plan is not safe and immutable."""


def _safe_relative_path(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise HfDownloadManifestError(f"{context} must be a safe relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(
        part in ("", ".", "..") or not _SAFE_SEGMENT_RE.fullmatch(part)
        for part in path.parts
    ):
        raise HfDownloadManifestError(f"{context} must be a safe relative path")
    return path.as_posix()


def validate_hf_downloads(value: Any, context: str = "hf_downloads") -> list[dict]:
    """Validate and normalize a manifest-owned multi-repository asset plan."""
    if not isinstance(value, list) or not value:
        raise HfDownloadManifestError(f"{context} must be a non-empty array")

    normalized: list[dict] = []
    destinations: set[str] = set()

    for repo_index, raw_repo in enumerate(value):
        repo_context = f"{context}[{repo_index}]"
        if not isinstance(raw_repo, Mapping):
            raise HfDownloadManifestError(f"{repo_context} must be an object")

        unknown_repo_fields = set(raw_repo) - {
            "repo_id", "revision", "target_subdir", "files",
        }
        if unknown_repo_fields:
            names = ", ".join(sorted(str(name) for name in unknown_repo_fields))
            raise HfDownloadManifestError(f"{repo_context} has unknown fields: {names}")

        repo_id = raw_repo.get("repo_id")
        if not isinstance(repo_id, str) or not _REPO_RE.fullmatch(repo_id):
            raise HfDownloadManifestError(
                f"{repo_context}.repo_id must be a Hugging Face owner/repository ID"
            )

        revision = raw_repo.get("revision")
        if not isinstance(revision, str) or not _COMMIT_RE.fullmatch(revision):
            raise HfDownloadManifestError(
                f"{repo_context}.revision must be a pinned 40-character commit SHA"
            )

        target_subdir = _safe_relative_path(
            raw_repo.get("target_subdir"),
            f"{repo_context}.target_subdir",
        )
        raw_files = raw_repo.get("files")
        if not isinstance(raw_files, list) or not raw_files:
            raise HfDownloadManifestError(f"{repo_context}.files must be a non-empty array")

        files: list[dict] = []
        repo_paths: set[str] = set()
        for file_index, raw_file in enumerate(raw_files):
            file_context = f"{repo_context}.files[{file_index}]"
            if not isinstance(raw_file, Mapping):
                raise HfDownloadManifestError(f"{file_context} must be an object")
            unknown_file_fields = set(raw_file) - {"path", "sha256"}
            if unknown_file_fields:
                names = ", ".join(sorted(str(name) for name in unknown_file_fields))
                raise HfDownloadManifestError(f"{file_context} has unknown fields: {names}")

            file_path = _safe_relative_path(raw_file.get("path"), f"{file_context}.path")
            if file_path in repo_paths:
                raise HfDownloadManifestError(
                    f"{repo_context} contains duplicate file path: {file_path}"
                )
            repo_paths.add(file_path)

            destination = f"{target_subdir}/{file_path}"
            if destination in destinations:
                raise HfDownloadManifestError(
                    f"{context} contains duplicate destination: {destination}"
                )
            destinations.add(destination)

            file_record = {"path": file_path}
            sha256 = raw_file.get("sha256")
            if sha256 is not None:
                if not isinstance(sha256, str) or not _SHA256_RE.fullmatch(sha256):
                    raise HfDownloadManifestError(
                        f"{file_context}.sha256 must be a 64-character SHA-256 digest"
                    )
                file_record["sha256"] = sha256.lower()
            files.append(file_record)

        normalized.append({
            "repo_id": repo_id,
            "revision": revision.lower(),
            "target_subdir": target_subdir,
            "files": files,
        })

    return normalized


def resolve_confined_owner_dir(models_dir: Path, owner_dir: Path) -> Path:
    """Resolve a canonical owner directory and prove it stays below MODELS_DIR."""
    models_root = models_dir.resolve()
    resolved_owner = owner_dir.resolve()
    try:
        resolved_owner.relative_to(models_root)
    except ValueError as error:
        raise HfDownloadManifestError(
            "Canonical model owner resolves outside the configured models directory"
        ) from error
    if resolved_owner == models_root:
        raise HfDownloadManifestError(
            "Canonical model owner must be below the configured models directory"
        )
    return resolved_owner


def _asset_path(owner_dir: Path, descriptor: Mapping, file_record: Mapping) -> Path:
    owner_root = owner_dir.resolve()
    candidate = (
        owner_root
        / str(descriptor["target_subdir"])
        / str(file_record["path"])
    ).resolve()
    try:
        candidate.relative_to(owner_root)
    except ValueError as error:
        raise HfDownloadManifestError(
            "Declared Hugging Face asset resolves outside its canonical owner directory"
        ) from error
    return candidate


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_is_present(path: Path) -> bool:
    return not path.is_symlink() and path.is_file() and path.stat().st_size > 0


def _file_matches_optional_sha256(path: Path, file_record: Mapping) -> bool:
    if not _file_is_present(path):
        return False

    expected_hash = file_record.get("sha256")
    if not expected_hash:
        return True

    stat_result = path.stat()
    cache_key = (
        str(path.resolve()),
        stat_result.st_size,
        stat_result.st_mtime_ns,
        expected_hash,
    )
    with _VERIFIED_FILE_CACHE_LOCK:
        if _VERIFIED_FILE_CACHE.get(cache_key):
            return True

    if _sha256(path) != expected_hash:
        return False

    with _VERIFIED_FILE_CACHE_LOCK:
        _VERIFIED_FILE_CACHE[cache_key] = True
    return True


def _file_is_verified(path: Path, file_record: Mapping) -> bool:
    return _file_matches_optional_sha256(path, file_record)


def hf_download_assets_ready(owner_dir: Path, plan: Any) -> bool:
    """Return true when every declared file exists and declared hashes verify.

    Hash verification is cached by canonical path, size, mtime_ns and expected
    SHA-256 so repeated readiness checks do not re-hash unchanged files.
    """
    try:
        normalized = validate_hf_downloads(plan)
        return all(
            _file_matches_optional_sha256(
                _asset_path(owner_dir, descriptor, file_record),
                file_record,
            )
            for descriptor in normalized
            for file_record in descriptor["files"]
        )
    except (HfDownloadManifestError, OSError):
        return False


def _default_download_file(**kwargs):
    from huggingface_hub import hf_hub_download

    try:
        return hf_hub_download(**kwargs)
    except RuntimeError as error:
        if str(error) != "Cannot send a request, as the client has been closed.":
            raise

        from huggingface_hub import close_session, get_session

        session = get_session()
        if session.is_closed:
            close_session()
        return hf_hub_download(**kwargs)


def _safe_exception_message(error: Exception) -> str:
    message = str(error).replace("\n", " ").strip()
    message = re.sub(r"(?i)(bearer\s+)[^\s]+", r"\1[redacted]", message)
    message = re.sub(
        r"(?i)([?&](?:access_)?token=)[^&\s]+",
        r"\1[redacted]",
        message,
    )
    message = re.sub(r"hf_[A-Za-z0-9]{8,}", "[redacted-token]", message)
    return message[:500] or error.__class__.__name__


async def stream_hf_asset_downloads(
    owner_dir: Path,
    plan: Any,
    token: str | None = None,
    download_file: Callable[..., Any] | None = None,
) -> AsyncIterator[dict]:
    """Download an exact manifest plan and yield aggregate SSE-ready events."""
    try:
        normalized = validate_hf_downloads(plan)
    except HfDownloadManifestError as error:
        yield {
            "error": {
                "code": "invalid_manifest",
                "stage": "validate",
                "message": str(error),
                "retryable": False,
            }
        }
        return

    owner_root = owner_dir.resolve()
    owner_root.mkdir(parents=True, exist_ok=True)
    downloader = download_file or _default_download_file
    total_files = sum(len(descriptor["files"]) for descriptor in normalized)
    total_repos = len(normalized)
    completed = 0
    yield {
        "percent": 0,
        "status": "preparing",
        "fileIndex": 0,
        "totalFiles": total_files,
        "repoIndex": 0,
        "totalRepos": total_repos,
    }

    for repo_index, descriptor in enumerate(normalized, start=1):
        target_dir = (owner_root / descriptor["target_subdir"]).resolve()
        try:
            target_dir.relative_to(owner_root)
        except ValueError:
            yield {
                "error": {
                    "code": "unsafe_target",
                    "stage": "validate",
                    "message": "Download target escapes the canonical model owner directory",
                    "repo_id": descriptor["repo_id"],
                    "retryable": False,
                }
            }
            return
        target_dir.mkdir(parents=True, exist_ok=True)

        for file_record in descriptor["files"]:
            completed += 1
            relative_file = "{}/{}".format(
                descriptor["target_subdir"], file_record["path"]
            )
            target_file = _asset_path(owner_root, descriptor, file_record)
            progress = {
                "file": relative_file,
                "fileIndex": completed,
                "totalFiles": total_files,
                "repoIndex": repo_index,
                "totalRepos": total_repos,
            }

            if _file_is_verified(target_file, file_record):
                yield {
                    **progress,
                    "percent": min(99, round(completed / total_files * 99)),
                    "status": "verified",
                }
                continue

            target_file.parent.mkdir(parents=True, exist_ok=True)
            force_download = target_file.exists()
            try:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(
                    None,
                    partial(
                        downloader,
                        repo_id=descriptor["repo_id"],
                        revision=descriptor["revision"],
                        filename=file_record["path"],
                        local_dir=str(target_dir),
                        local_dir_use_symlinks=False,
                        token=token,
                        force_download=force_download,
                    ),
                )
            except Exception as error:
                yield {
                    "error": {
                        "code": "download_failed",
                        "stage": "download",
                        "message": _safe_exception_message(error),
                        "repo_id": descriptor["repo_id"],
                        "file": relative_file,
                        "retryable": True,
                    }
                }
                return

            if not _file_is_verified(target_file, file_record):
                try:
                    target_file.unlink(missing_ok=True)
                except OSError:
                    pass
                yield {
                    "error": {
                        "code": "hash_mismatch",
                        "stage": "verify",
                        "message": "Downloaded file failed its declared SHA-256 verification",
                        "repo_id": descriptor["repo_id"],
                        "file": relative_file,
                        "retryable": True,
                    }
                }
                return

            yield {
                **progress,
                "percent": min(99, round(completed / total_files * 99)),
                "status": "downloaded",
            }

    yield {
        "percent": 100,
        "status": "done",
        "fileIndex": total_files,
        "totalFiles": total_files,
        "repoIndex": total_repos,
        "totalRepos": total_repos,
    }
