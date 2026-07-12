"""Strict, UI-managed HTTPS asset plans for Modly model nodes."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import ipaddress
import json
import os
import re
import socket
import threading
import uuid
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx


MARKER_SCHEMA_VERSION = 1
MARKER_KIND = "modly.https-assets.ready"
MARKER_RELATIVE_PATH = Path(".modly") / "https-assets-ready.json"

_ASSET_FIELDS = frozenset({"url", "filename", "size_bytes", "sha256"})
_MARKER_FIELDS = frozenset({
    "schema_version",
    "kind",
    "model_id",
    "plan_sha256",
    "assets",
    "verified_at",
})
_SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")
_SAFE_MODEL_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_LOCAL_HOST_SUFFIXES = (".localhost", ".local")
_CHUNK_BYTES = 1024 * 1024
_MAX_REDIRECTS = 3
_VERIFIED_FILE_CACHE: dict[tuple[str, int, int, str], bool] = {}
_VERIFIED_FILE_CACHE_LOCK = threading.Lock()


class HttpsDownloadManifestError(ValueError):
    """Raised when a node-level HTTPS asset plan is unsafe or ambiguous."""


def _assert_exact_fields(
    value: Mapping[str, Any],
    expected: frozenset[str],
    context: str,
) -> None:
    fields = set(value)
    missing = expected - fields
    unknown = fields - expected
    if missing:
        raise HttpsDownloadManifestError(
            f"{context} is missing required fields: {', '.join(sorted(missing))}"
        )
    if unknown:
        raise HttpsDownloadManifestError(
            f"{context} has unknown fields: "
            f"{', '.join(sorted(str(name) for name in unknown))}"
        )


def _validate_model_id(model_id: Any) -> str:
    if not isinstance(model_id, str) or not model_id:
        raise HttpsDownloadManifestError("model_id must be a canonical model ID")

    parts = model_id.split("/")
    if len(parts) != 2 or any(
        not _SAFE_MODEL_SEGMENT_RE.fullmatch(part) for part in parts
    ):
        raise HttpsDownloadManifestError(
            "model_id must be a canonical model ID with exactly two safe segments"
        )

    return model_id


def _validate_https_url(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise HttpsDownloadManifestError(
            f"{context} must be an absolute HTTPS URL"
        )
    if any(character.isspace() for character in value):
        raise HttpsDownloadManifestError(
            f"{context} must not contain whitespace"
        )

    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise HttpsDownloadManifestError(
            f"{context} is not a valid HTTPS URL"
        ) from error

    if parsed.scheme != "https" or not parsed.hostname:
        raise HttpsDownloadManifestError(
            f"{context} must be an absolute HTTPS URL"
        )
    if parsed.username is not None or parsed.password is not None:
        raise HttpsDownloadManifestError(
            f"{context} must not contain credentials"
        )
    if parsed.fragment:
        raise HttpsDownloadManifestError(
            f"{context} must not contain a URL fragment"
        )
    if port is not None and not 1 <= port <= 65535:
        raise HttpsDownloadManifestError(
            f"{context} contains an invalid port"
        )

    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith(_LOCAL_HOST_SUFFIXES):
        raise HttpsDownloadManifestError(
            f"{context} must not target a local host"
        )

    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None

    if address is not None and not address.is_global:
        raise HttpsDownloadManifestError(
            f"{context} must target a globally routable host"
        )

    return value


def _address_is_public(address: ipaddress._BaseAddress) -> bool:
    return (
        address.is_global
        and not address.is_private
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_multicast
        and not address.is_reserved
        and not address.is_unspecified
        and not getattr(address, "is_site_local", False)
    )


def validate_https_downloads(
    value: Any,
    context: str = "https_downloads",
) -> list[dict[str, Any]]:
    """Validate and copy an exact, ordered node-level HTTPS asset plan."""
    if not isinstance(value, list) or not value:
        raise HttpsDownloadManifestError(
            f"{context} must be a non-empty array"
        )

    normalized: list[dict[str, Any]] = []
    filenames: set[str] = set()

    for index, candidate in enumerate(value):
        asset_context = f"{context}[{index}]"

        if not isinstance(candidate, Mapping):
            raise HttpsDownloadManifestError(
                f"{asset_context} must be an object"
            )

        _assert_exact_fields(candidate, _ASSET_FIELDS, asset_context)

        url = _validate_https_url(
            candidate.get("url"),
            f"{asset_context}.url",
        )

        filename = candidate.get("filename")
        if (
            not isinstance(filename, str)
            or not _SAFE_FILENAME_RE.fullmatch(filename)
        ):
            raise HttpsDownloadManifestError(
                f"{asset_context}.filename must be a safe basename"
            )
        if filename in filenames:
            raise HttpsDownloadManifestError(
                f"{context} contains duplicate filename: {filename}"
            )
        filenames.add(filename)

        size_bytes = candidate.get("size_bytes")
        if type(size_bytes) is not int or size_bytes <= 0:
            raise HttpsDownloadManifestError(
                f"{asset_context}.size_bytes must be a positive integer"
            )

        sha256 = candidate.get("sha256")
        if (
            not isinstance(sha256, str)
            or not _SHA256_RE.fullmatch(sha256)
        ):
            raise HttpsDownloadManifestError(
                f"{asset_context}.sha256 must be a lowercase "
                "64-character SHA-256 digest"
            )

        normalized.append({
            "url": url,
            "filename": filename,
            "size_bytes": size_bytes,
            "sha256": sha256,
        })

    return normalized


def canonical_https_plan_json(plan: Any) -> str:
    normalized = validate_https_downloads(plan)
    return json.dumps(
        normalized,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def https_plan_sha256(plan: Any) -> str:
    canonical = canonical_https_plan_json(plan)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def expected_marker_assets(plan: Any) -> list[dict[str, Any]]:
    normalized = validate_https_downloads(plan)
    return [
        {
            "filename": asset["filename"],
            "size_bytes": asset["size_bytes"],
            "sha256": asset["sha256"],
        }
        for asset in normalized
    ]


def _is_rfc3339_utc(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False

    try:
        parsed = datetime.fromisoformat(
            value[:-1] + "+00:00" if value.endswith("Z") else value
        )
    except ValueError:
        return False

    return (
        parsed.tzinfo is not None
        and parsed.utcoffset() == timezone.utc.utcoffset(parsed)
    )


def _regular_file_without_symlink(path: Path) -> bool:
    try:
        return not path.is_symlink() and path.is_file()
    except OSError:
        return False


def _load_ready_marker(
    marker_path: Path,
) -> dict[str, Any] | None:
    if not _regular_file_without_symlink(marker_path):
        return None

    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None

    if not isinstance(marker, dict):
        return None
    if set(marker) != _MARKER_FIELDS:
        return None

    return marker


def _file_matches_size_and_sha256(
    path: Path,
    *,
    expected_size: int,
    expected_sha256: str,
) -> bool:
    if not _regular_file_without_symlink(path):
        return False

    stat_result = path.stat()
    if stat_result.st_size != expected_size:
        return False

    cache_key = (
        str(path.resolve()),
        stat_result.st_size,
        stat_result.st_mtime_ns,
        expected_sha256,
    )
    with _VERIFIED_FILE_CACHE_LOCK:
        if _VERIFIED_FILE_CACHE.get(cache_key):
            return True

    if _sha256_file(path) != expected_sha256:
        return False

    with _VERIFIED_FILE_CACHE_LOCK:
        _VERIFIED_FILE_CACHE[cache_key] = True
    return True


def https_download_assets_ready(
    owner_dir: Path,
    model_id: str,
    plan: Any,
) -> bool:
    """Check the exact marker and re-verify hashes with a metadata-keyed cache."""
    try:
        canonical_model_id = _validate_model_id(model_id)
        normalized = validate_https_downloads(plan)
        owner_root = owner_dir.resolve()
        marker = _load_ready_marker(
            owner_root / MARKER_RELATIVE_PATH
        )

        if marker is None:
            return False
        if type(marker.get("schema_version")) is not int:
            return False
        if marker["schema_version"] != MARKER_SCHEMA_VERSION:
            return False
        if marker.get("kind") != MARKER_KIND:
            return False
        if marker.get("model_id") != canonical_model_id:
            return False
        if marker.get("plan_sha256") != https_plan_sha256(normalized):
            return False
        if marker.get("assets") != expected_marker_assets(normalized):
            return False
        if not _is_rfc3339_utc(marker.get("verified_at")):
            return False

        for asset in normalized:
            asset_path = owner_root / asset["filename"]
            if not _file_matches_size_and_sha256(
                asset_path,
                expected_size=asset["size_bytes"],
                expected_sha256=asset["sha256"],
            ):
                return False

        return True
    except (HttpsDownloadManifestError, OSError, RuntimeError):
        return False


def _default_resolve_host(
    hostname: str,
    port: int,
) -> Sequence[str]:
    return tuple({
        result[4][0]
        for result in socket.getaddrinfo(
            hostname,
            port,
            type=socket.SOCK_STREAM,
        )
    })


async def _resolve_host(
    hostname: str,
    port: int,
    resolver: Callable[[str, int], Any],
) -> Sequence[str]:
    if resolver is _default_resolve_host:
        result = await asyncio.to_thread(
            resolver,
            hostname,
            port,
        )
    else:
        result = resolver(hostname, port)
        if inspect.isawaitable(result):
            result = await result

    if isinstance(result, str):
        return (result,)

    return tuple(result)


async def _assert_public_resolved_hosts(
    plan: Sequence[Mapping[str, Any]],
    resolver: Callable[[str, int], Any],
    resolution_cache: dict[tuple[str, int], ipaddress._BaseAddress] | None = None,
) -> None:
    resolved: set[tuple[str, int]] = set()

    for asset in plan:
        parsed = urlsplit(str(asset["url"]))
        hostname = parsed.hostname
        if hostname is None:
            raise HttpsDownloadManifestError(
                "HTTPS asset URL has no hostname"
            )

        port = parsed.port or 443
        key = (hostname, port)
        if key in resolved:
            continue
        resolved.add(key)

        validated_address = await _resolve_validated_address(
            hostname,
            port,
            resolver,
        )
        if resolution_cache is not None:
            resolution_cache[key] = validated_address


async def _resolve_validated_address(
    hostname: str,
    port: int,
    resolver: Callable[[str, int], Any],
) -> ipaddress._BaseAddress:
    addresses = await _resolve_host(hostname, port, resolver)
    if not addresses:
        raise HttpsDownloadManifestError(
            f"HTTPS asset host '{hostname}' did not resolve to an address"
        )

    validated: list[ipaddress._BaseAddress] = []
    for raw_address in addresses:
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError as error:
            raise HttpsDownloadManifestError(
                f"HTTPS asset host '{hostname}' resolved to an invalid address"
            ) from error
        if not _address_is_public(address):
            raise HttpsDownloadManifestError(
                f"HTTPS asset host '{hostname}' resolved to a non-global address"
            )
        validated.append(address)

    return sorted(
        validated,
        key=lambda address: (address.version, int(address)),
    )[0]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()

    with path.open("rb") as source:
        for chunk in iter(
            lambda: source.read(_CHUNK_BYTES),
            b"",
        ):
            digest.update(chunk)

    return digest.hexdigest()


def _file_is_verified(
    path: Path,
    asset: Mapping[str, Any],
) -> bool:
    return _file_matches_size_and_sha256(
        path,
        expected_size=asset["size_bytes"],
        expected_sha256=asset["sha256"],
    )


def _format_host_for_url(hostname: str) -> str:
    return f"[{hostname}]" if ":" in hostname else hostname


def _format_host_header(hostname: str, port: int) -> str:
    host = _format_host_for_url(hostname)
    return host if port == 443 else f"{host}:{port}"


async def _build_pinned_https_request(
    logical_url: str,
    resolver: Callable[[str, int], Any],
    resolution_cache: dict[tuple[str, int], ipaddress._BaseAddress] | None = None,
) -> tuple[httpx.Request, str, int]:
    validated_url = _validate_https_url(logical_url, "https_downloads.url")
    parsed = urlsplit(validated_url)
    hostname = parsed.hostname
    if hostname is None:
        raise HttpsDownloadManifestError("HTTPS asset URL has no hostname")

    original_hostname = hostname.rstrip(".")
    port = parsed.port or 443
    cache_key = (original_hostname, port)
    pinned_address = (
        resolution_cache.get(cache_key)
        if resolution_cache is not None
        else None
    )
    if pinned_address is None:
        pinned_address = await _resolve_validated_address(
            original_hostname,
            port,
            resolver,
        )
        if resolution_cache is not None:
            resolution_cache[cache_key] = pinned_address
    pinned_host = _format_host_for_url(str(pinned_address))
    pinned_netloc = pinned_host if port == 443 else f"{pinned_host}:{port}"
    pinned_url = urlunsplit(
        (
            parsed.scheme,
            pinned_netloc,
            parsed.path or "/",
            parsed.query,
            "",
        )
    )
    request = httpx.Request(
        "GET",
        pinned_url,
        headers={
            "Accept-Encoding": "identity",
            "Host": _format_host_header(original_hostname, port),
        },
        extensions={"sni_hostname": original_hostname},
    )
    return request, original_hostname, port


def _safe_exception_message(error: Exception) -> str:
    message = str(error).replace("\n", " ").strip()
    message = re.sub(
        r"(?i)(bearer\s+)[^\s]+",
        r"\1[redacted]",
        message,
    )
    message = re.sub(
        r"(?i)([?&](?:access_)?token=)[^&\s]+",
        r"\1[redacted]",
        message,
    )
    return message[:500] or error.__class__.__name__


def _download_error(
    *,
    code: str,
    stage: str,
    message: str,
    retryable: bool,
    filename: str | None = None,
) -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "stage": stage,
            "message": message[:500],
            **({"file": filename} if filename else {}),
            "retryable": retryable,
        }
    }


def _default_client_factory() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(
            connect=30.0,
            read=None,
            write=30.0,
            pool=30.0,
        ),
        follow_redirects=False,
    )


def _remove_existing_marker(owner_root: Path) -> None:
    marker_path = owner_root / MARKER_RELATIVE_PATH
    marker_parent = marker_path.parent

    if marker_parent.exists() and marker_parent.is_symlink():
        raise HttpsDownloadManifestError(
            "HTTPS marker directory must not be a symbolic link"
        )
    if marker_path.is_symlink():
        raise HttpsDownloadManifestError(
            "HTTPS readiness marker must not be a symbolic link"
        )

    marker_path.unlink(missing_ok=True)


def _write_ready_marker(
    owner_root: Path,
    model_id: str,
    plan: Sequence[Mapping[str, Any]],
) -> None:
    marker_path = owner_root / MARKER_RELATIVE_PATH
    marker_dir = marker_path.parent

    if marker_dir.exists() and marker_dir.is_symlink():
        raise HttpsDownloadManifestError(
            "HTTPS marker directory must not be a symbolic link"
        )

    marker_dir.mkdir(parents=True, exist_ok=True)

    marker = {
        "schema_version": MARKER_SCHEMA_VERSION,
        "kind": MARKER_KIND,
        "model_id": model_id,
        "plan_sha256": https_plan_sha256(list(plan)),
        "assets": expected_marker_assets(list(plan)),
        "verified_at": (
            datetime.now(timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        ),
    }

    temp_path = (
        marker_dir
        / f".{marker_path.name}.{uuid.uuid4().hex}.tmp"
    )

    try:
        with temp_path.open("x", encoding="utf-8") as output:
            json.dump(
                marker,
                output,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            )
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())

        os.replace(temp_path, marker_path)
    finally:
        temp_path.unlink(missing_ok=True)


async def stream_https_asset_downloads(
    owner_dir: Path,
    model_id: str,
    plan: Any,
    *,
    client_factory: Callable[[], httpx.AsyncClient] | None = None,
    resolve_host: Callable[[str, int], Any] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Download one exact HTTPS plan and yield aggregate SSE-ready events."""
    try:
        canonical_model_id = _validate_model_id(model_id)
        normalized = validate_https_downloads(plan)
    except HttpsDownloadManifestError as error:
        yield _download_error(
            code="invalid_manifest",
            stage="validate",
            message=str(error),
            retryable=False,
        )
        return

    try:
        resolution_cache: dict[tuple[str, int], ipaddress._BaseAddress] = {}
        await _assert_public_resolved_hosts(
            normalized,
            resolve_host or _default_resolve_host,
            resolution_cache,
        )
    except HttpsDownloadManifestError as error:
        yield _download_error(
            code="unsafe_host",
            stage="validate",
            message=str(error),
            retryable=False,
        )
        return
    except OSError as error:
        yield _download_error(
            code="host_resolution_failed",
            stage="validate",
            message=_safe_exception_message(error),
            retryable=True,
        )
        return

    owner_root = owner_dir.resolve()
    owner_root.mkdir(parents=True, exist_ok=True)

    try:
        _remove_existing_marker(owner_root)
    except (HttpsDownloadManifestError, OSError) as error:
        yield _download_error(
            code="unsafe_target",
            stage="validate",
            message=_safe_exception_message(error),
            retryable=False,
        )
        return

    total_files = len(normalized)
    total_bytes = sum(
        asset["size_bytes"] for asset in normalized
    )
    completed_bytes = 0
    last_percent = -1

    yield {
        "percent": 0,
        "status": "preparing",
        "fileIndex": 0,
        "totalFiles": total_files,
    }

    factory = client_factory or _default_client_factory

    try:
        async with factory() as client:
            for file_index, asset in enumerate(
                normalized,
                start=1,
            ):
                filename = asset["filename"]
                target_path = owner_root / filename

                if target_path.is_symlink():
                    yield _download_error(
                        code="unsafe_target",
                        stage="validate",
                        message=(
                            "HTTPS asset target must not be "
                            "a symbolic link"
                        ),
                        filename=filename,
                        retryable=False,
                    )
                    return

                if await asyncio.to_thread(_file_is_verified, target_path, asset):
                    completed_bytes += asset["size_bytes"]
                    percent = min(
                        99,
                        round(
                            completed_bytes
                            / total_bytes
                            * 99
                        ),
                    )
                    last_percent = max(
                        last_percent,
                        percent,
                    )

                    yield {
                        "percent": percent,
                        "status": "verified",
                        "file": filename,
                        "fileIndex": file_index,
                        "totalFiles": total_files,
                    }
                    continue

                temp_path = (
                    owner_root
                    / f".{filename}.{uuid.uuid4().hex}.part"
                )
                received = 0
                digest = hashlib.sha256()

                try:
                    logical_url = str(asset["url"])
                    visited_urls = {logical_url}
                    redirect_count = 0

                    while True:
                        request, _, _ = await _build_pinned_https_request(
                            logical_url,
                            resolve_host or _default_resolve_host,
                            resolution_cache,
                        )
                        response = await client.send(request, stream=True)
                        if 300 <= response.status_code < 400:
                            location = response.headers.get("location")
                            await response.aclose()
                            if not location:
                                yield _download_error(
                                    code="invalid_redirect",
                                    stage="request",
                                    message="HTTPS asset redirect missing Location header",
                                    filename=filename,
                                    retryable=False,
                                )
                                return

                            redirect_count += 1
                            if redirect_count > _MAX_REDIRECTS:
                                yield _download_error(
                                    code="too_many_redirects",
                                    stage="request",
                                    message="HTTPS asset redirect chain exceeded the allowed limit",
                                    filename=filename,
                                    retryable=False,
                                )
                                return

                            try:
                                next_logical_url = _validate_https_url(
                                    urljoin(logical_url, location),
                                    "https_downloads.redirect",
                                )
                            except HttpsDownloadManifestError as error:
                                yield _download_error(
                                    code="invalid_redirect",
                                    stage="request",
                                    message=str(error),
                                    filename=filename,
                                    retryable=False,
                                )
                                return

                            if next_logical_url in visited_urls:
                                yield _download_error(
                                    code="redirect_loop",
                                    stage="request",
                                    message="HTTPS asset redirect loop detected",
                                    filename=filename,
                                    retryable=False,
                                )
                                return

                            visited_urls.add(next_logical_url)
                            logical_url = next_logical_url
                            continue

                        break

                    try:
                        if response.status_code != 200:
                            yield _download_error(
                                code="http_error",
                                stage="request",
                                message=(
                                    "HTTPS asset request failed "
                                    f"with HTTP {response.status_code}"
                                ),
                                filename=filename,
                                retryable=(
                                    response.status_code >= 500
                                    or response.status_code == 429
                                ),
                            )
                            return

                        content_encoding = response.headers.get(
                            "content-encoding", "identity"
                        ).strip().lower()
                        if content_encoding not in {"", "identity"}:
                            yield _download_error(
                                code="encoded_response_disallowed",
                                stage="request",
                                message=(
                                    "HTTPS asset response used disallowed "
                                    f"Content-Encoding {content_encoding!r}"
                                ),
                                filename=filename,
                                retryable=False,
                            )
                            return

                        content_length = response.headers.get(
                            "content-length"
                        )
                        if content_length is not None:
                            try:
                                declared_length = int(
                                    content_length
                                )
                            except ValueError:
                                declared_length = -1

                            if (
                                declared_length
                                != asset["size_bytes"]
                            ):
                                yield _download_error(
                                    code="size_mismatch",
                                    stage="verify",
                                    message=(
                                        "HTTPS asset "
                                        "Content-Length is "
                                        f"{declared_length}, "
                                        "expected "
                                        f"{asset['size_bytes']}"
                                    ),
                                    filename=filename,
                                    retryable=True,
                                )
                                return

                        with temp_path.open("xb") as output:
                            async for chunk in response.aiter_bytes(
                                _CHUNK_BYTES
                            ):
                                if not chunk:
                                    continue

                                received += len(chunk)
                                if received > asset["size_bytes"]:
                                    yield _download_error(
                                        code="size_mismatch",
                                        stage="verify",
                                        message=(
                                            "HTTPS asset exceeded "
                                            "its declared byte size"
                                        ),
                                        filename=filename,
                                        retryable=True,
                                    )
                                    return

                                output.write(chunk)
                                digest.update(chunk)

                                percent = min(
                                    99,
                                    round(
                                        (
                                            completed_bytes
                                            + received
                                        )
                                        / total_bytes
                                        * 99
                                    ),
                                )
                                if percent != last_percent:
                                    last_percent = percent
                                    yield {
                                        "percent": percent,
                                        "status": "downloading",
                                        "file": filename,
                                        "fileIndex": file_index,
                                        "totalFiles": total_files,
                                    }

                            output.flush()
                            os.fsync(output.fileno())
                    finally:
                        await response.aclose()

                    if received != asset["size_bytes"]:
                        yield _download_error(
                            code="size_mismatch",
                            stage="verify",
                            message=(
                                "HTTPS asset downloaded "
                                f"{received} bytes, expected "
                                f"{asset['size_bytes']}"
                            ),
                            filename=filename,
                            retryable=True,
                        )
                        return

                    if digest.hexdigest() != asset["sha256"]:
                        yield _download_error(
                            code="hash_mismatch",
                            stage="verify",
                            message=(
                                "Downloaded HTTPS asset failed "
                                "SHA-256 verification"
                            ),
                            filename=filename,
                            retryable=True,
                        )
                        return

                    os.replace(temp_path, target_path)
                    completed_bytes += received

                    percent = min(
                        99,
                        round(
                            completed_bytes
                            / total_bytes
                            * 99
                        ),
                    )
                    last_percent = max(
                        last_percent,
                        percent,
                    )

                    yield {
                        "percent": percent,
                        "status": "downloaded",
                        "file": filename,
                        "fileIndex": file_index,
                        "totalFiles": total_files,
                    }
                finally:
                    temp_path.unlink(missing_ok=True)
    except HttpsDownloadManifestError as error:
        yield _download_error(
            code="unsafe_host",
            stage="request",
            message=str(error),
            retryable=False,
        )
        return
    except (httpx.HTTPError, OSError) as error:
        yield _download_error(
            code="download_failed",
            stage="download",
            message=_safe_exception_message(error),
            retryable=True,
        )
        return

    try:
        _write_ready_marker(
            owner_root,
            canonical_model_id,
            normalized,
        )
    except (HttpsDownloadManifestError, OSError) as error:
        yield _download_error(
            code="marker_write_failed",
            stage="publish",
            message=_safe_exception_message(error),
            retryable=True,
        )
        return

    yield {
        "percent": 100,
        "status": "done",
        "fileIndex": total_files,
        "totalFiles": total_files,
    }
