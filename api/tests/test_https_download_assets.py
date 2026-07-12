import asyncio
import hashlib
import json
import os
from pathlib import Path

import httpx
import pytest

from services.https_download_assets import (
    MARKER_KIND,
    MARKER_RELATIVE_PATH,
    MARKER_SCHEMA_VERSION,
    HttpsDownloadManifestError,
    canonical_https_plan_json,
    expected_marker_assets,
    https_download_assets_ready,
    https_plan_sha256,
    stream_https_asset_downloads,
    validate_https_downloads,
)


PUBLIC_ADDRESS = "93.184.216.34"


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _asset(
    filename: str,
    payload: bytes,
    *,
    url: str | None = None,
) -> dict:
    return {
        "url": url or f"https://assets.example.com/{filename}",
        "filename": filename,
        "size_bytes": len(payload),
        "sha256": _sha256(payload),
    }


def _public_resolver(_hostname: str, _port: int) -> list[str]:
    return [PUBLIC_ADDRESS]


class _ChunkStream(httpx.AsyncByteStream):
    def __init__(self, *chunks: bytes):
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk

    async def aclose(self) -> None:
        return None


def _client_factory(handler):
    return lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        follow_redirects=False,
    )


def _collect(
    owner_dir: Path,
    model_id: str,
    plan: list[dict],
    *,
    handler,
    resolver=_public_resolver,
) -> list[dict]:
    async def collect() -> list[dict]:
        return [
            event
            async for event in stream_https_asset_downloads(
                owner_dir,
                model_id,
                plan,
                client_factory=_client_factory(handler),
                resolve_host=resolver,
            )
        ]

    return asyncio.run(collect())


def test_validate_https_downloads_accepts_exact_ordered_assets():
    first = _asset("first.ckpt", b"first")
    second = _asset("second.ckpt", b"second")
    assert validate_https_downloads([first, second]) == [first, second]


@pytest.mark.parametrize(
    "mutate,match",
    [
        (lambda asset: asset.update(extra=True), "unknown fields"),
        (lambda asset: asset.pop("url"), "missing required fields"),
        (
            lambda asset: asset.update(url="http://assets.example.com/model.bin"),
            "HTTPS URL",
        ),
        (
            lambda asset: asset.update(
                url="https://user:secret@assets.example.com/model.bin"
            ),
            "credentials",
        ),
        (lambda asset: asset.update(filename="../model.bin"), "safe basename"),
        (lambda asset: asset.update(filename="nested/model.bin"), "safe basename"),
        (lambda asset: asset.update(size_bytes=True), "positive integer"),
        (lambda asset: asset.update(size_bytes=0), "positive integer"),
        (lambda asset: asset.update(sha256="A" * 64), "lowercase"),
    ],
)
def test_validate_https_downloads_rejects_non_exact_or_unsafe_assets(
    mutate,
    match,
):
    asset = _asset("model.bin", b"model")
    mutate(asset)
    with pytest.raises(HttpsDownloadManifestError, match=match):
        validate_https_downloads([asset])


def test_validate_https_downloads_rejects_duplicate_filenames():
    first = _asset(
        "model.bin",
        b"first",
        url="https://one.example.com/model.bin",
    )
    second = _asset(
        "model.bin",
        b"second",
        url="https://two.example.com/model.bin",
    )
    with pytest.raises(HttpsDownloadManifestError, match="duplicate filename"):
        validate_https_downloads([first, second])


@pytest.mark.parametrize(
    "url",
    [
        "https://localhost/model.bin",
        "https://service.local/model.bin",
        "https://127.0.0.1/model.bin",
        "https://10.0.0.1/model.bin",
        "https://169.254.169.254/model.bin",
        "https://[::1]/model.bin",
    ],
)
def test_validate_https_downloads_rejects_literal_or_named_local_hosts(url):
    with pytest.raises(HttpsDownloadManifestError):
        validate_https_downloads([_asset("model.bin", b"model", url=url)])


def test_canonical_plan_hash_matches_gaussiangpt_contract():
    vfront = [
        {
            "url": "https://kaldir.vc.cit.tum.de/gaussiangpt/vqvae_vfront.ckpt",
            "filename": "vqvae_vfront.ckpt",
            "size_bytes": 2115020643,
            "sha256": "9f70d0939dc791292be52da6c503bf51b3ac73d9905b51784d0aac81e44faf7a",
        },
        {
            "url": "https://kaldir.vc.cit.tum.de/gaussiangpt/gpt_vfront.ckpt",
            "filename": "gpt_vfront.ckpt",
            "size_bytes": 3421157765,
            "sha256": "203dc730495bf4f21e60280c6152703867f1b81e9c035d110d792e6a87d9313b",
        },
    ]
    both = [
        {
            "url": "https://kaldir.vc.cit.tum.de/gaussiangpt/vqvae_both.ckpt",
            "filename": "vqvae_both.ckpt",
            "size_bytes": 2115018167,
            "sha256": "a780ed2920e877736699bb3da84a43362c1a565adff91217841d4b95cb784542",
        },
        {
            "url": "https://kaldir.vc.cit.tum.de/gaussiangpt/gpt_both.ckpt",
            "filename": "gpt_both.ckpt",
            "size_bytes": 3421156679,
            "sha256": "054978e811716292472dd501cc05b54c39789af6dd8730aab86061545c8f0a8b",
        },
    ]
    assert https_plan_sha256(vfront) == (
        "7e2c3c305c5eef0d6f75558486299a719"
        "34909e95af580fed0ebc3dc816df994"
    )
    assert https_plan_sha256(both) == (
        "5e7b81f5d8a30772a29f1bd48197a05c"
        "6842fce7d1469fcfe088a938897ba2b1"
    )
    assert canonical_https_plan_json(vfront).startswith(
        '[{"filename":"vqvae_vfront.ckpt","sha256":'
    )


def test_stream_rejects_private_dns_before_opening_http_client(tmp_path: Path):
    client_calls = 0

    def handler(_request: httpx.Request):
        nonlocal client_calls
        client_calls += 1
        return httpx.Response(200, content=b"model")

    events = _collect(
        tmp_path / "owner",
        "demo/generate",
        [_asset("model.bin", b"model")],
        handler=handler,
        resolver=lambda _host, _port: ["192.168.1.10"],
    )
    assert events[-1]["error"]["code"] == "unsafe_host"
    assert events[-1]["error"]["stage"] == "validate"
    assert client_calls == 0
    assert not (tmp_path / "owner" / MARKER_RELATIVE_PATH).exists()


def test_stream_pins_requests_to_a_validated_ipv4_and_preserves_host_and_sni(
    tmp_path: Path,
):
    requests: list[httpx.Request] = []
    resolver_calls: list[tuple[str, int]] = []

    def resolver(hostname: str, port: int) -> list[str]:
        resolver_calls.append((hostname, port))
        return [PUBLIC_ADDRESS]

    def handler(request: httpx.Request):
        requests.append(request)
        return httpx.Response(200, stream=_ChunkStream(b"model"))

    events = _collect(
        tmp_path / "owner",
        "demo/generate",
        [_asset("model.bin", b"model")],
        handler=handler,
        resolver=resolver,
    )

    assert events[-1]["status"] == "done"
    assert resolver_calls == [("assets.example.com", 443)]
    assert len(requests) == 1
    assert requests[0].url.host == PUBLIC_ADDRESS
    assert requests[0].headers["host"] == "assets.example.com"
    assert requests[0].headers["accept-encoding"] == "identity"
    assert requests[0].extensions["sni_hostname"] == "assets.example.com"


def test_stream_pins_requests_to_a_validated_ipv6_and_preserves_host_and_sni(
    tmp_path: Path,
):
    requests: list[httpx.Request] = []
    ipv6_address = "2606:4700:4700::1111"

    def handler(request: httpx.Request):
        requests.append(request)
        return httpx.Response(200, stream=_ChunkStream(b"model"))

    events = _collect(
        tmp_path / "owner",
        "demo/generate",
        [_asset("model.bin", b"model")],
        handler=handler,
        resolver=lambda _host, _port: [ipv6_address],
    )

    assert events[-1]["status"] == "done"
    assert len(requests) == 1
    assert requests[0].url.host == ipv6_address
    assert str(requests[0].url).startswith(f"https://[{ipv6_address}]/")
    assert requests[0].headers["host"] == "assets.example.com"
    assert requests[0].extensions["sni_hostname"] == "assets.example.com"


def test_stream_revalidates_public_redirect_targets(tmp_path: Path):
    requests: list[httpx.Request] = []
    resolver_calls: list[tuple[str, int]] = []

    def resolver(hostname: str, port: int) -> list[str]:
        resolver_calls.append((hostname, port))
        return [
            PUBLIC_ADDRESS if hostname == "assets.example.com" else "151.101.1.164"
        ]

    def handler(request: httpx.Request):
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(
                302,
                headers={"Location": "https://other.example.com/model.bin?ok=1"},
            )
        return httpx.Response(200, stream=_ChunkStream(b"model"))

    events = _collect(
        tmp_path / "owner",
        "demo/generate",
        [_asset("model.bin", b"model")],
        handler=handler,
        resolver=resolver,
    )

    assert events[-1]["status"] == "done"
    assert resolver_calls == [
        ("assets.example.com", 443),
        ("other.example.com", 443),
    ]
    assert [request.url.host for request in requests] == [
        PUBLIC_ADDRESS,
        "151.101.1.164",
    ]
    assert [request.headers["host"] for request in requests] == [
        "assets.example.com",
        "other.example.com",
    ]


def test_stream_rejects_redirect_to_private_target(tmp_path: Path):
    resolver_calls: list[tuple[str, int]] = []

    def resolver(hostname: str, port: int) -> list[str]:
        resolver_calls.append((hostname, port))
        return [PUBLIC_ADDRESS] if hostname == "assets.example.com" else ["10.0.0.8"]

    def handler(_request: httpx.Request):
        return httpx.Response(
            302,
            headers={"Location": "https://private.example.com/model.bin"},
        )

    events = _collect(
        tmp_path / "owner",
        "demo/generate",
        [_asset("model.bin", b"model")],
        handler=handler,
        resolver=resolver,
    )

    assert events[-1]["error"]["code"] == "unsafe_host"
    assert events[-1]["error"]["stage"] == "request"
    assert resolver_calls == [
        ("assets.example.com", 443),
        ("private.example.com", 443),
    ]
    assert not (tmp_path / "owner" / MARKER_RELATIVE_PATH).exists()


def test_stream_rejects_redirect_loop_and_max_redirects(tmp_path: Path):
    loop_calls = 0

    def loop_handler(_request: httpx.Request):
        nonlocal loop_calls
        loop_calls += 1
        return httpx.Response(302, headers={"Location": "https://assets.example.com/model.bin"})

    loop_events = _collect(
        tmp_path / "owner-loop",
        "demo/generate",
        [_asset("model.bin", b"model")],
        handler=loop_handler,
    )

    assert loop_events[-1]["error"]["code"] == "redirect_loop"
    assert loop_calls == 1

    max_calls = 0

    def max_handler(_request: httpx.Request):
        nonlocal max_calls
        max_calls += 1
        return httpx.Response(
            302,
            headers={"Location": f"https://hop{max_calls}.example.com/model.bin"},
        )

    max_events = _collect(
        tmp_path / "owner-max",
        "demo/generate",
        [_asset("model.bin", b"model")],
        handler=max_handler,
    )

    assert max_events[-1]["error"]["code"] == "too_many_redirects"
    assert max_calls == 4


def test_stream_rejects_encoded_responses(tmp_path: Path):
    def handler(_request: httpx.Request):
        return httpx.Response(
            200,
            headers={"Content-Encoding": "gzip"},
            stream=_ChunkStream(b"model"),
        )

    events = _collect(
        tmp_path / "owner",
        "demo/generate",
        [_asset("model.bin", b"model")],
        handler=handler,
    )
    assert events[-1]["error"]["code"] == "encoded_response_disallowed"
    assert not (tmp_path / "owner" / MARKER_RELATIVE_PATH).exists()


@pytest.mark.parametrize(
    "payload,expected_payload,expected_code",
    [
        (b"abc", b"abcd", "size_mismatch"),
        (b"abcde", b"abcd", "size_mismatch"),
        (b"abce", b"abcd", "hash_mismatch"),
    ],
)
def test_failed_downloads_remove_temp_files_and_never_publish_marker(
    tmp_path: Path,
    payload: bytes,
    expected_payload: bytes,
    expected_code: str,
):
    owner = tmp_path / "owner"
    plan = [_asset("model.bin", expected_payload)]

    def handler(_request: httpx.Request):
        return httpx.Response(200, stream=_ChunkStream(payload))

    events = _collect(
        owner,
        "demo/generate",
        plan,
        handler=handler,
    )
    assert events[-1]["error"]["code"] == expected_code
    assert not (owner / "model.bin").exists()
    assert not (owner / MARKER_RELATIVE_PATH).exists()
    assert [
        path
        for path in owner.iterdir()
        if path.name.endswith(".part")
    ] == []


def test_marker_is_not_published_when_a_later_asset_fails(tmp_path: Path):
    owner = tmp_path / "owner"
    first_payload = b"first"
    expected_second = b"second"
    wrong_second = b"xxxxxx"
    plan = [
        _asset("first.bin", first_payload),
        _asset("second.bin", expected_second),
    ]

    def handler(request: httpx.Request):
        payload = (
            first_payload
            if request.url.path.endswith("first.bin")
            else wrong_second
        )
        return httpx.Response(200, stream=_ChunkStream(payload))

    events = _collect(
        owner,
        "demo/generate",
        plan,
        handler=handler,
    )
    assert events[-1]["error"]["code"] == "hash_mismatch"
    assert (owner / "first.bin").read_bytes() == first_payload
    assert not (owner / "second.bin").exists()
    assert not (owner / MARKER_RELATIVE_PATH).exists()


def test_success_publishes_exact_ordered_full_model_marker(tmp_path: Path):
    owner = tmp_path / "owner"
    payloads = {
        "first.bin": b"first",
        "second.bin": b"second",
    }
    plan = [
        _asset("first.bin", payloads["first.bin"]),
        _asset("second.bin", payloads["second.bin"]),
    ]

    def handler(request: httpx.Request):
        filename = request.url.path.rsplit("/", 1)[-1]
        assert request.headers["accept-encoding"] == "identity"
        return httpx.Response(
            200,
            stream=_ChunkStream(payloads[filename]),
        )

    events = _collect(
        owner,
        "gaussiangpt/generate-vfront",
        plan,
        handler=handler,
    )
    assert events[0] == {
        "percent": 0,
        "status": "preparing",
        "fileIndex": 0,
        "totalFiles": 2,
    }
    assert events[-1] == {
        "percent": 100,
        "status": "done",
        "fileIndex": 2,
        "totalFiles": 2,
    }
    assert (owner / "first.bin").read_bytes() == payloads["first.bin"]
    assert (owner / "second.bin").read_bytes() == payloads["second.bin"]

    marker_path = owner / MARKER_RELATIVE_PATH
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    assert set(marker) == {
        "schema_version",
        "kind",
        "model_id",
        "plan_sha256",
        "assets",
        "verified_at",
    }
    assert marker["schema_version"] == MARKER_SCHEMA_VERSION
    assert marker["kind"] == MARKER_KIND
    assert marker["model_id"] == "gaussiangpt/generate-vfront"
    assert marker["plan_sha256"] == https_plan_sha256(plan)
    assert marker["assets"] == expected_marker_assets(plan)
    assert marker["verified_at"].endswith("Z")
    assert https_download_assets_ready(
        owner,
        "gaussiangpt/generate-vfront",
        plan,
    )


def test_readiness_detects_same_size_tamper_after_publish(tmp_path: Path):
    owner = tmp_path / "owner"
    payload = b"model"
    plan = [_asset("model.bin", payload)]

    def handler(_request: httpx.Request):
        return httpx.Response(200, stream=_ChunkStream(payload))

    _collect(owner, "demo/generate", plan, handler=handler)
    assert https_download_assets_ready(owner, "demo/generate", plan)

    (owner / "model.bin").write_bytes(b"tampr")
    assert not https_download_assets_ready(owner, "demo/generate", plan)


def test_readiness_hash_cache_skips_rehash_until_file_metadata_changes(
    monkeypatch,
    tmp_path: Path,
):
    import services.https_download_assets as assets_module

    owner = tmp_path / "owner"
    payload = b"model"
    plan = [_asset("model.bin", payload)]

    def handler(_request: httpx.Request):
        return httpx.Response(200, stream=_ChunkStream(payload))

    _collect(owner, "demo/generate", plan, handler=handler)

    calls = 0
    real_sha256 = assets_module._sha256_file

    def counting_sha256(path: Path) -> str:
        nonlocal calls
        calls += 1
        return real_sha256(path)

    monkeypatch.setattr(assets_module, "_sha256_file", counting_sha256)
    assert https_download_assets_ready(owner, "demo/generate", plan)
    assert https_download_assets_ready(owner, "demo/generate", plan)
    assert calls == 1

    asset_path = owner / "model.bin"
    os.utime(asset_path, ns=(asset_path.stat().st_atime_ns, asset_path.stat().st_mtime_ns + 1_000_000))
    assert https_download_assets_ready(owner, "demo/generate", plan)
    assert calls == 2


def test_readiness_rejects_wrong_size_extra_marker_fields_and_symlinks(
    tmp_path: Path,
):
    owner = tmp_path / "owner"
    payload = b"model"
    plan = [_asset("model.bin", payload)]

    def handler(_request: httpx.Request):
        return httpx.Response(200, stream=_ChunkStream(payload))

    _collect(
        owner,
        "demo/generate",
        plan,
        handler=handler,
    )
    marker_path = owner / MARKER_RELATIVE_PATH
    marker = json.loads(marker_path.read_text(encoding="utf-8"))

    marker["extra"] = True
    marker_path.write_text(json.dumps(marker), encoding="utf-8")
    assert not https_download_assets_ready(owner, "demo/generate", plan)

    marker.pop("extra")
    marker_path.write_text(json.dumps(marker), encoding="utf-8")
    (owner / "model.bin").write_bytes(b"wrong-size")
    assert not https_download_assets_ready(owner, "demo/generate", plan)

    outside = tmp_path / "outside.bin"
    outside.write_bytes(payload)
    (owner / "model.bin").unlink()
    (owner / "model.bin").symlink_to(outside)
    assert not https_download_assets_ready(owner, "demo/generate", plan)


def test_stream_rejects_existing_asset_symlink_without_http_request(
    tmp_path: Path,
):
    owner = tmp_path / "owner"
    owner.mkdir()
    outside = tmp_path / "outside.bin"
    outside.write_bytes(b"model")
    (owner / "model.bin").symlink_to(outside)
    calls = 0

    def handler(_request: httpx.Request):
        nonlocal calls
        calls += 1
        return httpx.Response(200, content=b"model")

    events = _collect(
        owner,
        "demo/generate",
        [_asset("model.bin", b"model")],
        handler=handler,
    )
    assert events[-1]["error"]["code"] == "unsafe_target"
    assert calls == 0
    assert outside.read_bytes() == b"model"
    assert not (owner / MARKER_RELATIVE_PATH).exists()


def test_https_route_resolves_plan_only_from_canonical_model_id(
    monkeypatch,
    tmp_path: Path,
):
    pytest.importorskip("fastapi")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import model as model_router

    plan = [_asset("model.bin", b"model")]
    calls = []

    monkeypatch.setattr(
        model_router.generator_registry,
        "get_https_download_plan",
        lambda model_id: plan if model_id == "demo/generate" else None,
    )
    monkeypatch.setattr(
        model_router.generator_registry,
        "canonical_model_dir",
        lambda model_id: tmp_path / model_id,
    )
    monkeypatch.setattr(model_router, "MODELS_DIR", tmp_path)

    async def fake_stream(owner_dir, model_id, resolved_plan):
        calls.append((owner_dir, model_id, resolved_plan))
        yield {"percent": 100, "status": "done"}

    monkeypatch.setattr(
        model_router,
        "stream_https_asset_downloads",
        fake_stream,
    )

    app = FastAPI()
    app.include_router(model_router.router, prefix="/model")
    client = TestClient(app)
    response = client.get(
        "/model/https-download-assets",
        params={
            "model_id": "demo/generate",
            "url": "https://attacker.example/private.bin",
        },
    )

    assert response.status_code == 200
    assert json.loads(response.text.removeprefix("data: ").strip()) == {
        "percent": 100,
        "status": "done",
    }
    assert calls == [
        (
            tmp_path / "demo/generate",
            "demo/generate",
            plan,
        )
    ]


@pytest.mark.parametrize(
    ("model_id", "expected"),
    [
        ("demo/generate", True),
        ("demo.with-dots/generate_2", True),
        ("demo", False),
        ("demo/generate/extra", False),
        ("/demo/generate", False),
        ("demo/.", False),
        ("demo/..", False),
        ("demo/../evil", False),
        ("demo\\evil/generate", False),
        ("demo/", False),
    ],
)
def test_python_canonical_model_id_validation_matches_safe_two_segment_rule(
    model_id: str,
    expected: bool,
):
    pytest.importorskip("fastapi")
    from routers.model import _is_safe_canonical_model_id

    assert _is_safe_canonical_model_id(model_id) is expected


def test_registry_propagates_https_plan_and_model_input(
    monkeypatch,
    tmp_path: Path,
):
    import services.generator_registry as registry_module
    from services.generators.base import BaseGenerator

    payload = b"model"
    plan = [_asset("model.bin", payload)]

    class DummyGenerator(BaseGenerator):
        DISPLAY_NAME = "Dummy"
        VRAM_GB = 1

        def load(self):
            self._model = object()

        def generate(
            self,
            image_bytes,
            params,
            progress_cb=None,
            cancel_event=None,
        ):
            return self.outputs_dir / "dummy.glb"

    manifest = {
        "id": "demo/generate",
        "bundle_id": "demo",
        "name": "Demo",
        "input": "none",
        "https_downloads": plan,
        "download_check": ".modly/https-assets-ready.json",
        "weight_owner_id": "generate",
        "legacy_paths": ["demo/generate"],
    }
    ext_dir = tmp_path / "extension"
    ext_dir.mkdir()
    models_dir = tmp_path / "models"
    workspace_dir = tmp_path / "workspace"
    models_dir.mkdir()
    workspace_dir.mkdir()

    monkeypatch.setattr(registry_module, "MODELS_DIR", models_dir)
    monkeypatch.setattr(registry_module, "WORKSPACE_DIR", workspace_dir)
    monkeypatch.setattr(
        registry_module,
        "_discover_extensions",
        lambda: {
            "demo/generate": (
                DummyGenerator,
                manifest,
                ext_dir,
            )
        },
    )

    registry = registry_module.GeneratorRegistry()
    registry.initialize()
    generator = registry.get_generator("demo/generate")

    assert registry.get_model_input("demo/generate") == "none"
    assert registry.get_https_download_plan("demo/generate") == plan
    assert generator.model_id == "demo/generate"
    assert generator.input == "none"
    assert generator.https_downloads == plan

    with pytest.raises(RuntimeError, match="Models UI"):
        generator._auto_download()


def test_registry_records_malformed_https_plan_as_model_error(
    monkeypatch,
    tmp_path: Path,
):
    import services.generator_registry as registry_module
    from services.generators.base import BaseGenerator

    class DummyGenerator(BaseGenerator):
        def load(self):
            self._model = object()

        def generate(
            self,
            image_bytes,
            params,
            progress_cb=None,
            cancel_event=None,
        ):
            return self.outputs_dir / "dummy.glb"

    invalid_plan = [{
        **_asset("model.bin", b"model"),
        "unexpected": True,
    }]
    manifest = {
        "id": "demo/generate",
        "bundle_id": "demo",
        "name": "Demo",
        "input": "none",
        "https_downloads": invalid_plan,
        "weight_owner_id": "generate",
        "legacy_paths": ["demo/generate"],
    }
    ext_dir = tmp_path / "extension"
    ext_dir.mkdir()

    monkeypatch.setattr(
        registry_module,
        "_discover_extensions",
        lambda: {
            "demo/generate": (
                DummyGenerator,
                manifest,
                ext_dir,
            )
        },
    )

    registry = registry_module.GeneratorRegistry()
    registry.initialize()

    assert "demo/generate" in registry.load_errors()
    assert "unknown fields" in registry.load_errors()["demo/generate"]
    assert "demo/generate" not in registry._generators


def test_registry_rejects_https_plan_on_shared_weight_owner(
    monkeypatch,
    tmp_path: Path,
):
    import services.generator_registry as registry_module
    from services.generators.base import BaseGenerator

    class DummyGenerator(BaseGenerator):
        def load(self):
            self._model = object()

        def generate(
            self,
            image_bytes,
            params,
            progress_cb=None,
            cancel_event=None,
        ):
            return self.outputs_dir / "dummy.glb"

    plan = [_asset("model.bin", b"model")]
    ext_dir = tmp_path / "extension"
    ext_dir.mkdir()

    def manifest(model_id: str) -> dict:
        return {
            "id": model_id,
            "bundle_id": "demo",
            "name": model_id,
            "input": "none",
            "https_downloads": plan,
            "weight_owner_id": "shared",
            "legacy_paths": ["demo/a", "demo/b"],
        }

    monkeypatch.setattr(
        registry_module,
        "_discover_extensions",
        lambda: {
            "demo/a": (
                DummyGenerator,
                manifest("demo/a"),
                ext_dir,
            ),
            "demo/b": (
                DummyGenerator,
                manifest("demo/b"),
                ext_dir,
            ),
        },
    )

    registry = registry_module.GeneratorRegistry()
    registry.initialize()

    assert set(registry.load_errors()) == {"demo/a", "demo/b"}
    assert all(
        "node-specific weight owner" in error
        for error in registry.load_errors().values()
    )
