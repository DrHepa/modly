"""Pinned, allowlisted Hugging Face asset plans for Modly model nodes."""

from __future__ import annotations

import asyncio
import hashlib
import re
import socket
import stat
import threading
import time
from collections.abc import AsyncIterator, Callable, Mapping
from functools import partial
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


_COMMIT_RE = re.compile(r"^[0-9a-fA-F]{40}$")
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_CHUNK_BYTES = 1024 * 1024
_VERIFIED_FILE_CACHE: dict[tuple[str, int, int, str], bool] = {}
_VERIFIED_FILE_CACHE_LOCK = threading.Lock()


class HfDownloadManifestError(ValueError):
    """Raised when an hf_downloads manifest plan is not safe and immutable."""


class HfDownloadControlSignal(Exception):
    """Raised by router-owned download controls for neutral settlement."""


def _http_origin(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or parsed.hostname is None:
        raise ValueError("redirect URL must use HTTP or HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("redirect URL must not contain credentials")
    port = parsed.port
    if port is None:
        port = 443 if scheme == "https" else 80
    return scheme, parsed.hostname.rstrip(".").lower(), port


class _HfOriginBoundRedirectHandler(HTTPRedirectHandler):
    """Keep bearer credentials on-origin while allowing signed HTTPS redirects."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            source_origin = _http_origin(req.full_url)
            target_origin = _http_origin(newurl)
        except ValueError as error:
            raise HTTPError(
                newurl,
                code,
                "Unsafe Hugging Face redirect destination",
                headers,
                fp,
            ) from error

        if source_origin[0] == "https" and target_origin[0] != "https":
            raise HTTPError(
                newurl,
                code,
                "Refusing Hugging Face HTTPS downgrade redirect",
                headers,
                fp,
            )

        redirected = super().redirect_request(
            req,
            fp,
            code,
            msg,
            headers,
            newurl,
        )
        if redirected is not None and source_origin != target_origin:
            redirected.remove_header("Authorization")
        return redirected


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
    """Validate and return the logical owner directory below MODELS_DIR.

    The configured MODELS_DIR may itself be a symlink, but existing child
    components below it must not be symlinks/aliases. Returning the logical
    path keeps owner control keyed by manifest/capability identity rather than
    by a resolved victim alias.
    """
    configured_root = Path(models_dir)
    models_root = configured_root.resolve()
    candidate = Path(owner_dir)

    try:
        relative_owner = candidate.relative_to(configured_root)
    except ValueError:
        try:
            relative_owner = candidate.resolve().relative_to(models_root)
        except ValueError as error:
            raise HfDownloadManifestError(
                "Canonical model owner resolves outside the configured models directory"
            ) from error

    if (
        not relative_owner.parts
        or any(part in ("", ".", "..") for part in relative_owner.parts)
    ):
        raise HfDownloadManifestError(
            "Canonical model owner must be below the configured models directory"
        )

    logical_owner = configured_root.joinpath(*relative_owner.parts)
    current = configured_root
    for index, segment in enumerate(relative_owner.parts):
        current = current / segment
        try:
            entry = current.lstat()
        except FileNotFoundError:
            break
        if stat.S_ISLNK(entry.st_mode):
            raise HfDownloadManifestError(
                "Canonical model owner contains a symbolic link or filesystem alias below the configured models directory"
            )
        if not stat.S_ISDIR(entry.st_mode):
            raise HfDownloadManifestError(
                "Canonical model owner contains a non-directory path component"
            )

    resolved_owner = logical_owner.resolve()
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
    return logical_owner


def _assert_no_child_aliases(root: Path, relative_path: str, context: str) -> Path:
    current = root
    for segment in PurePosixPath(relative_path).parts:
        current = current / segment
        try:
            entry = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(entry.st_mode):
            raise HfDownloadManifestError(
                f"{context} contains a symbolic link or filesystem alias below the canonical owner directory"
            )
        if current != root / relative_path and not stat.S_ISDIR(entry.st_mode):
            raise HfDownloadManifestError(
                f"{context} contains a non-directory path component"
            )
    return current


def _asset_path(owner_dir: Path, descriptor: Mapping, file_record: Mapping) -> Path:
    relative_file = "{}/{}".format(descriptor["target_subdir"], file_record["path"])
    return _assert_no_child_aliases(
        Path(owner_dir),
        relative_file,
        "Declared Hugging Face asset",
    )


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
        if owner_dir.is_symlink():
            return False
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


def _download_status(
    downloaded: int,
    total: int | None,
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


def _parse_content_length(raw: str | None) -> int | None:
    if not raw:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _response_total_bytes(headers, already_downloaded: int) -> int | None:
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


def _download_hf_file_streamed(
    *,
    repo_id: str,
    revision: str,
    filename: str,
    target_file: Path,
    owner_root: Path,
    token: str | None,
    force_download: bool,
    progress_cb: Callable[[dict], None],
    progress_base: Mapping[str, Any],
    check_download_control: Callable[[], None] | None,
) -> int:
    from huggingface_hub import hf_hub_url

    if check_download_control is not None:
        check_download_control()

    target_file.parent.mkdir(parents=True, exist_ok=True)
    temp_path = target_file.with_suffix(target_file.suffix + ".part")
    _assert_no_child_aliases(
        owner_root,
        str(temp_path.relative_to(owner_root)),
        "Hugging Face temporary asset",
    )
    if force_download:
        temp_path.unlink(missing_ok=True)
    existing_bytes = temp_path.stat().st_size if temp_path.exists() else 0
    headers = {"User-Agent": "modly/0.3.1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if existing_bytes > 0:
        headers["Range"] = f"bytes={existing_bytes}-"

    request = Request(
        hf_hub_url(repo_id=repo_id, filename=filename, revision=revision),
        headers=headers,
    )
    opener = build_opener(_HfOriginBoundRedirectHandler())
    with opener.open(request, timeout=30) as response:
        resumed = existing_bytes > 0 and getattr(response, "status", None) == 206
        if existing_bytes > 0 and not resumed:
            temp_path.unlink(missing_ok=True)
            existing_bytes = 0

        total_bytes = _response_total_bytes(
            response.headers,
            existing_bytes if resumed else 0,
        )
        bytes_downloaded = existing_bytes
        progress_cb({
            **progress_base,
            "status": _download_status(bytes_downloaded, total_bytes, 1, 1, resumed),
            "bytesDownloaded": bytes_downloaded,
            "totalBytes": total_bytes,
            "stalledSeconds": 0,
        })

        mode = "ab" if resumed else "wb"
        last_emit = 0.0
        with temp_path.open(mode) as output:
            while True:
                if check_download_control is not None:
                    check_download_control()
                try:
                    chunk = response.read(_CHUNK_BYTES)
                except socket.timeout as error:
                    raise TimeoutError(f"Timed out while downloading {filename}") from error
                if not chunk:
                    break
                output.write(chunk)
                bytes_downloaded += len(chunk)

                now = time.monotonic()
                if now - last_emit >= 0.5:
                    progress_cb({
                        **progress_base,
                        "status": _download_status(bytes_downloaded, total_bytes, 1, 1, resumed),
                        "bytesDownloaded": bytes_downloaded,
                        "totalBytes": total_bytes,
                        "stalledSeconds": 0,
                    })
                    last_emit = now

    temp_path.replace(target_file)
    return bytes_downloaded

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


def _is_retryable_download_error(error: Exception) -> bool:
    status = getattr(error, "status_code", None)
    if status is None:
        status = getattr(getattr(error, "response", None), "status_code", None)
    if status is None and isinstance(error, HTTPError):
        status = error.code
    if isinstance(status, int):
        return status in {408, 425, 429} or status >= 500
    return True


async def stream_hf_asset_downloads(
    owner_dir: Path,
    plan: Any,
    token: str | None = None,
    download_file: Callable[..., Any] | None = None,
    check_download_control: Callable[[], None] | None = None,
    control_exceptions: tuple[type[BaseException], ...] = (),
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

    if Path(owner_dir).is_symlink():
        yield {"error": {"code": "unsafe_target", "stage": "validate", "message": "Canonical model owner must not be a symbolic link", "retryable": False}}
        return
    owner_root = Path(owner_dir)
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
    if check_download_control is not None:
        check_download_control()

    for repo_index, descriptor in enumerate(normalized, start=1):
        if check_download_control is not None:
            check_download_control()
        try:
            target_dir = _assert_no_child_aliases(
                owner_root,
                descriptor["target_subdir"],
                "Declared Hugging Face target",
            )
        except HfDownloadManifestError as error:
            yield {
                "error": {
                    "code": "unsafe_target",
                    "stage": "validate",
                    "message": str(error),
                    "repo_id": descriptor["repo_id"],
                    "retryable": False,
                }
            }
            return
        target_dir.mkdir(parents=True, exist_ok=True)

        for file_record in descriptor["files"]:
            if check_download_control is not None:
                check_download_control()
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
            if check_download_control is not None:
                check_download_control()
            try:
                if download_file is None:
                    loop = asyncio.get_running_loop()
                    queue: asyncio.Queue[dict] = asyncio.Queue()

                    def _progress(message: dict) -> None:
                        loop.call_soon_threadsafe(queue.put_nowait, message)

                    future = loop.run_in_executor(
                        None,
                        partial(
                            _download_hf_file_streamed,
                            repo_id=descriptor["repo_id"],
                            revision=descriptor["revision"],
                            filename=file_record["path"],
                            target_file=target_file,
                            owner_root=owner_root,
                            token=token,
                            force_download=force_download,
                            progress_cb=_progress,
                            progress_base={
                                **progress,
                                "percent": min(99, round((completed - 1) / total_files * 99)),
                            },
                            check_download_control=check_download_control,
                        ),
                    )
                    while not future.done():
                        try:
                            message = await asyncio.wait_for(queue.get(), timeout=0.5)
                        except asyncio.TimeoutError:
                            if check_download_control is not None:
                                check_download_control()
                            continue
                        yield message
                    await future
                else:
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
            except control_exceptions:
                raise
            except Exception as error:
                yield {
                    "error": {
                        "code": "download_failed",
                        "stage": "download",
                        "message": _safe_exception_message(error),
                        "repo_id": descriptor["repo_id"],
                        "file": relative_file,
                        "retryable": _is_retryable_download_error(error),
                    }
                }
                return

            if check_download_control is not None:
                check_download_control()

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
