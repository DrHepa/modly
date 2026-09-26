import asyncio
import hashlib
import json
import sys
from email.message import Message
from pathlib import Path
from types import ModuleType, SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request

import pytest

from services.hf_download_assets import (
    HfDownloadManifestError,
    _HfOriginBoundRedirectHandler,
    _default_download_file,
    _safe_exception_message,
    hf_download_assets_ready,
    resolve_confined_owner_dir,
    stream_hf_asset_downloads,
    validate_hf_downloads,
    _download_hf_file_streamed,
)


REVISION = "ef15eda2e413f994e3b4657960b0309487587718"


def _plan(*files: dict) -> list[dict]:
    return [{
        "repo_id": "owner/model",
        "revision": REVISION,
        "target_subdir": "cube3d",
        "files": list(files),
    }]


def _redirect_request(target: str):
    request = Request(
        "https://huggingface.co/owner/model/resolve/main/model.bin",
        headers={
            "Authorization": "Bearer synthetic-test-token",
            "Range": "bytes=7-",
            "User-Agent": "modly-test",
        },
    )
    return _HfOriginBoundRedirectHandler().redirect_request(
        request,
        None,
        302,
        "Found",
        Message(),
        target,
    )


def test_hf_redirect_keeps_bearer_only_for_same_origin():
    redirected = _redirect_request(
        "https://huggingface.co:443/owner/model/resolve/main/signed.bin"
    )

    assert redirected.get_header("Authorization") == (
        "Bearer synthetic-test-token"
    )
    assert redirected.get_header("Range") == "bytes=7-"


def test_hf_redirect_strips_bearer_from_cross_origin_signed_destination():
    redirected = _redirect_request(
        "https://cdn-lfs.hf.co/signed/model.bin?signature=synthetic"
    )

    assert redirected.get_header("Authorization") is None
    assert redirected.get_header("Range") == "bytes=7-"
    redirected_headers = {
        name.lower(): value for name, value in redirected.header_items()
    }
    assert redirected_headers["user-agent"] == "modly-test"


def test_hf_redirect_rejects_https_downgrade():
    with pytest.raises(HTTPError, match="HTTPS downgrade"):
        _redirect_request("http://huggingface.co/owner/model/model.bin")


def _install_fake_huggingface_hub(
    monkeypatch,
    outcomes: list[object],
    *,
    session_is_closed: bool = False,
):
    module = ModuleType("huggingface_hub")
    events: list[str] = []
    pending_outcomes = list(outcomes)
    session = SimpleNamespace(is_closed=session_is_closed)

    def hf_hub_download(**_kwargs):
        events.append("download")
        outcome = pending_outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    def get_session():
        events.append("get_session")
        return session

    def close_session():
        events.append("close_session")

    module.hf_hub_download = hf_hub_download
    module.get_session = get_session
    module.close_session = close_session
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    return events


def test_default_download_retries_exact_closed_client_with_open_session(monkeypatch):
    events = _install_fake_huggingface_hub(
        monkeypatch,
        [
            RuntimeError("Cannot send a request, as the client has been closed."),
            "/models/model.pt",
        ],
    )

    assert _default_download_file(filename="model.pt") == "/models/model.pt"
    assert events == ["download", "get_session", "download"]


def test_default_download_does_not_retry_other_runtime_errors(monkeypatch):
    error = RuntimeError("unrelated runtime failure")
    events = _install_fake_huggingface_hub(monkeypatch, [error])

    with pytest.raises(RuntimeError) as caught:
        _default_download_file(filename="model.pt")

    assert caught.value is error
    assert events == ["download"]


def test_stream_reports_second_failure_after_single_closed_client_retry(
    monkeypatch,
    tmp_path: Path,
):
    events = _install_fake_huggingface_hub(
        monkeypatch,
        [
            RuntimeError("Cannot send a request, as the client has been closed."),
            RuntimeError("Cannot send a request, as the client has been closed."),
        ],
    )

    async def collect():
        return [event async for event in stream_hf_asset_downloads(
            tmp_path,
            _plan({"path": "model.pt"}),
            download_file=_default_download_file,
        )]

    stream_events = asyncio.run(collect())

    assert events == ["download", "get_session", "download"]
    assert stream_events[-1]["error"]["code"] == "download_failed"
    assert stream_events[-1]["error"]["message"] == (
        "Cannot send a request, as the client has been closed."
    )


def test_default_download_resets_closed_session_before_retry(monkeypatch):
    events = _install_fake_huggingface_hub(
        monkeypatch,
        [
            RuntimeError("Cannot send a request, as the client has been closed."),
            "/models/model.pt",
        ],
        session_is_closed=True,
    )

    assert _default_download_file(filename="model.pt") == "/models/model.pt"
    assert events == ["download", "get_session", "close_session", "download"]


def test_validate_hf_downloads_accepts_pinned_allowlisted_assets():
    assert validate_hf_downloads(_plan(
        {"path": "config.json"},
        {"path": "weights/model.pt", "sha256": "A" * 64},
    )) == _plan(
        {"path": "config.json"},
        {"path": "weights/model.pt", "sha256": "a" * 64},
    )


@pytest.mark.parametrize("field,value", [
    ("revision", "main"),
    ("target_subdir", "../escape"),
    ("files", [{"path": "../secret"}]),
    ("files", [{"path": "model.pt", "sha256": "bad"}]),
])
def test_validate_hf_downloads_rejects_mutable_or_unsafe_assets(field, value):
    descriptor = _plan({"path": "model.pt"})[0]
    descriptor[field] = value
    with pytest.raises(HfDownloadManifestError):
        validate_hf_downloads([descriptor])


def test_readiness_requires_all_nonempty_files_and_verifies_declared_hashes(
    monkeypatch,
    tmp_path: Path,
):
    import services.hf_download_assets as assets_module

    plan = _plan(
        {"path": "config.json"},
        {"path": "model.pt", "sha256": hashlib.sha256(b"expected").hexdigest()},
    )
    target = tmp_path / "cube3d"
    target.mkdir()
    (target / "config.json").write_text("{}", encoding="utf-8")
    assert hf_download_assets_ready(tmp_path, plan) is False

    calls = 0
    real_sha256 = assets_module._sha256

    def counting_sha256(path: Path) -> str:
        nonlocal calls
        calls += 1
        return real_sha256(path)

    (target / "model.pt").write_bytes(b"expected")
    monkeypatch.setattr(assets_module, "_sha256", counting_sha256)
    assert hf_download_assets_ready(tmp_path, plan) is True
    assert hf_download_assets_ready(tmp_path, plan) is True
    assert calls == 1

    (target / "model.pt").write_bytes(b"changed!")
    assert hf_download_assets_ready(tmp_path, plan) is False
    assert calls == 2


def test_readiness_keeps_no_hash_files_presence_compatible(tmp_path: Path):
    plan = _plan({"path": "config.json"})
    target = tmp_path / "cube3d"
    target.mkdir()

    assert hf_download_assets_ready(tmp_path, plan) is False
    (target / "config.json").write_text("{}", encoding="utf-8")
    assert hf_download_assets_ready(tmp_path, plan) is True


def test_readiness_rejects_symlinked_owner_root(tmp_path: Path):
    plan = _plan({"path": "config.json"})
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "config.json").write_text("{}", encoding="utf-8")
    owner = tmp_path / "cube3d"
    try:
        owner.symlink_to(outside, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"Symlinks unavailable: {error}")

    assert hf_download_assets_ready(owner, plan) is False


def test_readiness_rejects_child_alias_inside_owner(tmp_path: Path):
    plan = _plan({"path": "alias/model.pt"})
    target = tmp_path / "cube3d"
    victim = tmp_path / "victim"
    target.mkdir()
    victim.mkdir()
    (victim / "model.pt").write_bytes(b"weights")
    try:
        (target / "alias").symlink_to(victim, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"Symlinks unavailable: {error}")

    assert hf_download_assets_ready(tmp_path, plan) is False


def test_stream_rejects_target_subdir_alias_inside_owner(tmp_path: Path):
    plan = _plan({"path": "model.pt"})
    victim = tmp_path / "victim"
    victim.mkdir()
    try:
        (tmp_path / "cube3d").symlink_to(victim, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"Symlinks unavailable: {error}")

    async def collect():
        return [event async for event in stream_hf_asset_downloads(
            tmp_path,
            plan,
            download_file=lambda **_kwargs: None,
        )]

    events = asyncio.run(collect())
    assert events[-1]["error"]["code"] == "unsafe_target"
    assert "symbolic link" in events[-1]["error"]["message"]


def test_stream_uses_exact_revision_and_preserves_verified_files(tmp_path: Path):
    first, second = b"first", b"second"
    plan = _plan(
        {"path": "first.bin", "sha256": hashlib.sha256(first).hexdigest()},
        {"path": "second.bin", "sha256": hashlib.sha256(second).hexdigest()},
    )
    target = tmp_path / "cube3d"
    target.mkdir()
    (target / "first.bin").write_bytes(first)
    calls = []

    def fake_download(**kwargs):
        calls.append(kwargs)
        (Path(kwargs["local_dir"]) / kwargs["filename"]).write_bytes(second)

    async def collect():
        return [event async for event in stream_hf_asset_downloads(
            tmp_path, plan, download_file=fake_download,
        )]

    events = asyncio.run(collect())
    assert [(call["revision"], call["filename"]) for call in calls] == [(REVISION, "second.bin")]
    assert events[-1]["percent"] == 100


def test_stream_rejects_and_removes_a_download_with_wrong_declared_hash(tmp_path: Path):
    plan = _plan({
        "path": "model.pt",
        "sha256": hashlib.sha256(b"expected").hexdigest(),
    })

    def fake_download(**kwargs):
        target = Path(kwargs["local_dir"]) / kwargs["filename"]
        target.write_bytes(b"wrong")

    async def collect():
        return [event async for event in stream_hf_asset_downloads(
            tmp_path, plan, download_file=fake_download,
        )]

    events = asyncio.run(collect())
    assert events[-1]["error"]["code"] == "hash_mismatch"
    assert events[-1]["error"]["stage"] == "verify"
    assert not (tmp_path / "cube3d/model.pt").exists()


def test_safe_exception_message_redacts_bearer_query_and_raw_hf_tokens():
    message = _safe_exception_message(RuntimeError(
        "Authorization: Bearer bearer-secret "
        "https://example.test/file?token=query-secret&x=1 "
        "raw hf_abcdefghijklmnopqrstuvwxyz"
    ))

    assert "bearer-secret" not in message
    assert "query-secret" not in message
    assert "hf_abcdefghijklmnopqrstuvwxyz" not in message
    assert "Bearer [redacted]" in message
    assert "?token=[redacted]&x=1" in message
    assert "raw [redacted-token]" in message


def test_registry_propagates_hf_downloads_and_requires_every_asset(monkeypatch, tmp_path: Path):
    import services.generator_registry as registry_module
    from services.generators.base import BaseGenerator

    plan = _plan({"path": "config.json"}, {"path": "model.pt"})

    class DummyGenerator(BaseGenerator):
        DISPLAY_NAME = "Dummy"
        VRAM_GB = 1

        def load(self):
            self._model = object()

        def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):
            return self.outputs_dir / "dummy.glb"

    manifest = {
        "id": "cube3d/generate",
        "name": "Cube3D",
        "hf_downloads": plan,
        "download_check": "cube3d/model.pt",
        "weight_owner_id": "cube3d/generate",
        "legacy_paths": ["cube3d/generate"],
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
        lambda: {"cube3d/generate": (DummyGenerator, manifest, ext_dir)},
    )

    registry = registry_module.GeneratorRegistry()
    registry.initialize()
    generator = registry.get_generator("cube3d/generate")

    assert generator.hf_downloads == plan
    assert generator.is_downloaded() is False
    asset_dir = models_dir / "cube3d/generate/cube3d"
    asset_dir.mkdir(parents=True)
    (asset_dir / "config.json").write_text("{}", encoding="utf-8")
    assert generator.is_downloaded() is False
    (asset_dir / "model.pt").write_bytes(b"weights")
    assert generator.is_downloaded() is True


def test_registry_prefers_structured_hf_downloads_over_legacy_metadata(monkeypatch, tmp_path: Path):
    import services.generator_registry as registry_module
    from services.generators.base import BaseGenerator

    class DummyGenerator(BaseGenerator):
        def load(self):
            self._model = object()

        def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):
            return self.outputs_dir / "dummy.glb"

    manifest = {
        "id": "demo/generate",
        "name": "Demo",
        "hf_repo": "owner/legacy",
        "hf_downloads": _plan({"path": "weights/model.bin"}),
        "weight_owner_id": "generate",
    }
    ext_dir = tmp_path / "extension"
    ext_dir.mkdir()
    monkeypatch.setattr(
        registry_module,
        "_discover_extensions",
        lambda: {"demo/generate": (DummyGenerator, manifest, ext_dir)},
    )

    registry = registry_module.GeneratorRegistry()
    registry.initialize()

    generator = registry.get_generator("demo/generate")
    assert generator.hf_downloads == manifest["hf_downloads"]
    assert registry.get_legacy_hf_download_plan("demo/generate") == {}


def test_registry_still_rejects_genuinely_conflicting_download_plan_kinds(monkeypatch, tmp_path: Path):
    import services.generator_registry as registry_module
    from services.generators.base import BaseGenerator

    class DummyGenerator(BaseGenerator):
        def load(self):
            self._model = object()

        def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):
            return self.outputs_dir / "dummy.glb"

    manifest = {
        "id": "demo/generate",
        "name": "Demo",
        "https_downloads": [{"url": "https://example.invalid/model.bin", "path": "model.bin"}],
        "hf_downloads": _plan({"path": "weights/model.bin"}),
        "weight_owner_id": "generate",
    }
    ext_dir = tmp_path / "extension"
    ext_dir.mkdir()
    monkeypatch.setattr(
        registry_module,
        "_discover_extensions",
        lambda: {"demo/generate": (DummyGenerator, manifest, ext_dir)},
    )

    registry = registry_module.GeneratorRegistry()
    registry.initialize()

    assert "demo/generate" not in registry._generators
    assert "conflicting download plan kinds" in registry.load_errors()["demo/generate"]


def test_discovery_skips_process_extension_before_requiring_generator(monkeypatch, tmp_path: Path, capsys):
    import services.generator_registry as registry_module

    extension = tmp_path / "process-extension"
    extension.mkdir()
    (extension / "manifest.json").write_text(
        json.dumps({"id": "process-extension", "type": "process"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(registry_module, "EXTENSIONS_DIR", tmp_path)

    assert registry_module._discover_extensions() == {}
    output = capsys.readouterr().out
    assert "type 'process' is not handled" in output
    assert "missing generator.py" not in output


def test_discovery_rejects_model_extension_without_generator(monkeypatch, tmp_path: Path, capsys):
    import services.generator_registry as registry_module

    extension = tmp_path / "model-extension"
    extension.mkdir()
    (extension / "manifest.json").write_text(
        json.dumps({"id": "model-extension", "type": "model"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(registry_module, "EXTENSIONS_DIR", tmp_path)

    assert registry_module._discover_extensions() == {}
    assert "missing generator.py" in capsys.readouterr().out


def test_registry_preserves_legacy_hf_include_prefixes_for_download_planning(monkeypatch, tmp_path: Path):
    import services.generator_registry as registry_module
    from services.generators.base import BaseGenerator

    class DummyGenerator(BaseGenerator):
        DISPLAY_NAME = "Dummy"
        VRAM_GB = 1

        def load(self):
            self._model = object()

        def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):
            return self.outputs_dir / "dummy.glb"

    manifest = {
        "id": "demo/generate",
        "name": "Demo",
        "hf_repo": "owner/model",
        "download_check": "weights/model.bin",
        "hf_skip_prefixes": ["weights/tmp/"],
        "hf_include_prefixes": ["weights/"],
        "weight_owner_id": "demo/generate",
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
        lambda: {"demo/generate": (DummyGenerator, manifest, ext_dir)},
    )

    registry = registry_module.GeneratorRegistry()
    registry.initialize()
    generator = registry.get_generator("demo/generate")
    plan = registry.get_legacy_hf_download_plan("demo/generate")

    assert generator.hf_include_prefixes == ["weights/"]
    assert plan["hf_include_prefixes"] == ["weights/"]
    assert plan["hf_skip_prefixes"] == ["weights/tmp/"]


def test_registry_node_normalization_preserves_legacy_hf_include_prefixes(monkeypatch, tmp_path: Path):
    import services.generator_registry as registry_module

    extensions_dir = tmp_path / "extensions"
    ext_dir = extensions_dir / "demo"
    models_dir = tmp_path / "models"
    workspace_dir = tmp_path / "workspace"
    ext_dir.mkdir(parents=True)
    models_dir.mkdir()
    workspace_dir.mkdir()
    (ext_dir / "manifest.json").write_text(json.dumps({
        "id": "demo",
        "type": "model",
        "name": "Demo",
        "generator_class": "DummyGenerator",
        "nodes": [{
            "id": "generate",
            "hf_repo": "owner/model",
            "download_check": "weights/model.bin",
            "hf_skip_prefixes": ["weights/tmp/"],
            "hf_include_prefixes": ["weights/"],
        }],
    }), encoding="utf-8")
    (ext_dir / "generator.py").write_text("""
from services.generators.base import BaseGenerator

class DummyGenerator(BaseGenerator):
    def load(self):
        self._model = object()

    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):
        return self.outputs_dir / "dummy.glb"
""", encoding="utf-8")

    monkeypatch.setattr(registry_module, "EXTENSIONS_DIR", extensions_dir)
    monkeypatch.setattr(registry_module, "MODELS_DIR", models_dir)
    monkeypatch.setattr(registry_module, "WORKSPACE_DIR", workspace_dir)

    registry = registry_module.GeneratorRegistry()
    registry.initialize()
    generator = registry.get_generator("demo/generate")
    plan = registry.get_legacy_hf_download_plan("demo/generate")

    assert generator.hf_include_prefixes == ["weights/"]
    assert plan["hf_include_prefixes"] == ["weights/"]


def test_hf_download_assets_endpoint_resolves_plan_from_canonical_model_id(monkeypatch, tmp_path: Path):
    fastapi = pytest.importorskip("fastapi")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import model as model_router

    plan = _plan({"path": "model.pt"})
    calls = []

    monkeypatch.setattr(
        model_router.generator_registry,
        "get_hf_download_plan",
        lambda model_id: plan if model_id == "cube3d/generate" else None,
    )
    monkeypatch.setattr(
        model_router.generator_registry,
        "canonical_model_dir",
        lambda model_id: tmp_path / model_id,
    )
    monkeypatch.setattr(model_router, "MODELS_DIR", tmp_path)

    async def fake_stream(owner_dir, resolved_plan, token=None, check_download_control=None, **_kwargs):
        calls.append((owner_dir, resolved_plan, token, check_download_control))
        assert check_download_control is not None
        check_download_control()
        yield {"percent": 100, "status": "done"}

    monkeypatch.setattr(model_router, "stream_hf_asset_downloads", fake_stream)

    app = FastAPI()
    app.include_router(model_router.router, prefix="/model")
    client = TestClient(app)
    response = client.get(
        "/model/hf-download-assets",
        params={"model_id": "cube3d/generate", "target_owner_id": "cube3d/generate"},
        headers={"Authorization": "Bearer private-token"},
    )

    assert response.status_code == 200
    frames = response.text.split("\n\n")
    assert frames[-1] == ""
    assert len(frames) == 2
    assert frames[0].startswith("data: ")
    assert json.loads(frames[0].removeprefix("data: ")) == {
        "percent": 100,
        "status": "done",
    }
    assert len(calls) == 1
    assert calls[0][0:3] == (tmp_path / "cube3d/generate", plan, "private-token")
    assert "cube3d/generate" not in model_router._download_controls


def test_hf_download_assets_rejects_mismatched_target_owner_before_streaming(monkeypatch, tmp_path: Path):
    fastapi = pytest.importorskip("fastapi")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import model as model_router

    plan = _plan({"path": "model.pt"})
    calls = []

    monkeypatch.setattr(
        model_router.generator_registry,
        "get_hf_download_plan",
        lambda model_id: plan if model_id == "cube3d/generate" else None,
    )
    monkeypatch.setattr(
        model_router.generator_registry,
        "canonical_model_dir",
        lambda model_id: tmp_path / "cube3d" / "shared-owner",
    )
    monkeypatch.setattr(model_router, "MODELS_DIR", tmp_path)

    async def fake_stream(*_args, **_kwargs):
        calls.append("streamed")
        yield {"percent": 100, "status": "done"}

    monkeypatch.setattr(model_router, "stream_hf_asset_downloads", fake_stream)

    app = FastAPI()
    app.include_router(model_router.router, prefix="/model")
    client = TestClient(app)
    response = client.get(
        "/model/hf-download-assets",
        params={"model_id": "cube3d/generate", "target_owner_id": "cube3d/generate"},
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "target_owner_mismatch"
    assert detail["stage"] == "request"
    assert detail["retryable"] is False
    assert "Target owner" in detail["message"]
    assert calls == []
    assert model_router._download_controls == {}


def test_hf_download_assets_rejects_unsafe_target_owner_before_streaming(monkeypatch, tmp_path: Path):
    fastapi = pytest.importorskip("fastapi")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import model as model_router

    plan = _plan({"path": "model.pt"})
    calls = []
    monkeypatch.setattr(
        model_router.generator_registry,
        "get_hf_download_plan",
        lambda model_id: plan if model_id == "cube3d/generate" else None,
    )
    monkeypatch.setattr(
        model_router.generator_registry,
        "canonical_model_dir",
        lambda model_id: tmp_path / "cube3d" / "generate",
    )
    monkeypatch.setattr(model_router, "MODELS_DIR", tmp_path)

    async def fake_stream(*_args, **_kwargs):
        calls.append("streamed")
        yield {"percent": 100, "status": "done"}

    monkeypatch.setattr(model_router, "stream_hf_asset_downloads", fake_stream)

    app = FastAPI()
    app.include_router(model_router.router, prefix="/model")
    client = TestClient(app)
    response = client.get(
        "/model/hf-download-assets",
        params={"model_id": "cube3d/generate", "target_owner_id": "cube3d/../generate"},
    )

    assert response.status_code == 400
    assert "Invalid target owner ID" in response.json()["detail"]
    assert calls == []
    assert model_router._download_controls == {}


def test_hf_download_assets_endpoint_uses_owner_scoped_control_for_cancel(monkeypatch, tmp_path: Path):
    fastapi = pytest.importorskip("fastapi")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import model as model_router

    plan = _plan({"path": "model.pt"})

    monkeypatch.setattr(
        model_router.generator_registry,
        "get_hf_download_plan",
        lambda model_id: plan if model_id == "cube3d/generate" else None,
    )
    monkeypatch.setattr(
        model_router.generator_registry,
        "canonical_model_dir",
        lambda model_id: tmp_path / "cube3d" / "shared-owner",
    )
    monkeypatch.setattr(model_router, "MODELS_DIR", tmp_path)

    async def fake_stream(owner_dir, resolved_plan, token=None, check_download_control=None, **_kwargs):
        assert owner_dir == tmp_path / "cube3d/shared-owner"
        assert check_download_control is not None
        model_router._download_controls["cube3d/shared-owner"]["cancel"].set()
        check_download_control()
        yield {"percent": 100, "status": "done"}

    monkeypatch.setattr(model_router, "stream_hf_asset_downloads", fake_stream)

    app = FastAPI()
    app.include_router(model_router.router, prefix="/model")
    client = TestClient(app)
    response = client.get("/model/hf-download-assets", params={"model_id": "cube3d/generate"})

    assert response.status_code == 200
    events = [json.loads(block.removeprefix("data: ")) for block in response.text.strip().split("\n\n")]
    assert events[-1] == {"cancelled": True, "status": "cancelled"}
    assert "cube3d/shared-owner" not in model_router._download_controls

def test_resolve_confined_owner_dir_rejects_in_root_symlink_alias(tmp_path: Path):
    models = tmp_path / "models"
    victim = models / "victim" / "owner"
    victim.mkdir(parents=True)
    alias_parent = models / "alias"
    try:
        alias_parent.symlink_to(models / "victim", target_is_directory=True)
    except OSError as error:
        pytest.skip(f"Symlinks unavailable: {error}")

    with pytest.raises(HfDownloadManifestError, match="symbolic link|alias"):
        resolve_confined_owner_dir(models, alias_parent / "owner")


def test_resolve_confined_owner_dir_allows_configured_models_root_symlink(tmp_path: Path):
    real_models = tmp_path / "real-models"
    real_owner = real_models / "safe" / "owner"
    real_owner.mkdir(parents=True)
    linked_models = tmp_path / "linked-models"
    try:
        linked_models.symlink_to(real_models, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"Symlinks unavailable: {error}")

    owner = resolve_confined_owner_dir(linked_models, linked_models / "safe" / "owner")
    assert owner == linked_models / "safe" / "owner"


def test_resolve_confined_owner_dir_rejects_existing_file_at_final_owner(tmp_path: Path):
    models = tmp_path / "models"
    owner = models / "cube3d" / "generate"
    owner.parent.mkdir(parents=True)
    owner.write_text("not a directory", encoding="utf-8")

    with pytest.raises(HfDownloadManifestError, match="non-directory"):
        resolve_confined_owner_dir(models, owner)


def test_stream_hf_download_polls_control_between_live_chunks(monkeypatch, tmp_path: Path):
    module = ModuleType("huggingface_hub")
    module.hf_hub_url = lambda repo_id, filename, revision=None: "https://hf.example/file"
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)

    class Response:
        status = 200
        headers = {"Content-Length": "2"}
        def __init__(self):
            self.reads = 0
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            return False
        def read(self, _size):
            self.reads += 1
            return b"x" if self.reads <= 2 else b""

    import services.hf_download_assets as assets_module
    monkeypatch.setattr(assets_module, "_CHUNK_BYTES", 1)
    monkeypatch.setattr(
        assets_module,
        "build_opener",
        lambda handler: SimpleNamespace(
            open=lambda *_args, **_kwargs: Response(),
        )
        if isinstance(handler, _HfOriginBoundRedirectHandler)
        else pytest.fail("missing origin-bound redirect handler"),
    )
    checks = 0

    def check_control():
        nonlocal checks
        checks += 1
        if checks >= 5:
            raise RuntimeError("cancelled-live")

    async def collect():
        return [event async for event in stream_hf_asset_downloads(
            tmp_path,
            _plan({"path": "model.pt"}),
            check_download_control=check_control,
        )]

    events = asyncio.run(collect())
    assert events[-1]["error"]["code"] == "download_failed"
    assert "cancelled-live" in events[-1]["error"]["message"]
    assert checks >= 5
    assert not (tmp_path / "cube3d" / "model.pt").exists()


def test_stream_hf_download_rejects_broken_temporary_symlink(tmp_path: Path):
    owner = tmp_path / "owner"
    target = owner / "cube3d" / "model.pt"
    target.parent.mkdir(parents=True)
    temp_path = target.with_suffix(".pt.part")
    try:
        temp_path.symlink_to(tmp_path / "missing-target")
    except OSError as error:
        pytest.skip(f"Symlinks unavailable: {error}")

    with pytest.raises(HfDownloadManifestError, match="temporary asset|symbolic link"):
        _download_hf_file_streamed(
            repo_id="owner/model",
            revision=REVISION,
            filename="model.pt",
            target_file=target,
            owner_root=owner,
            token=None,
            force_download=False,
            progress_cb=lambda _event: None,
            progress_base={},
            check_download_control=None,
        )


def test_stream_hf_download_marks_permanent_http_errors_non_retryable(tmp_path: Path):
    def fail(**_kwargs):
        raise HTTPError("https://hf.example/file", 404, "not found", {}, None)

    async def collect():
        return [event async for event in stream_hf_asset_downloads(
            tmp_path,
            _plan({"path": "model.pt"}),
            download_file=fail,
        )]

    events = asyncio.run(collect())
    assert events[-1]["error"]["retryable"] is False


def test_stream_hf_download_propagates_typed_control_exception(monkeypatch, tmp_path: Path):
    module = ModuleType("huggingface_hub")
    module.hf_hub_url = lambda repo_id, filename, revision=None: "https://hf.example/file"
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)

    class Cancelled(Exception):
        pass

    class Response:
        status = 200
        headers = {"Content-Length": "2"}
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            return False
        def read(self, _size):
            return b"x"

    import services.hf_download_assets as assets_module
    monkeypatch.setattr(
        assets_module,
        "build_opener",
        lambda handler: SimpleNamespace(
            open=lambda *_args, **_kwargs: Response(),
        )
        if isinstance(handler, _HfOriginBoundRedirectHandler)
        else pytest.fail("missing origin-bound redirect handler"),
    )

    def check_control():
        raise Cancelled("owner-cancelled")

    async def collect():
        return [event async for event in stream_hf_asset_downloads(
            tmp_path,
            _plan({"path": "model.pt"}),
            check_download_control=check_control,
            control_exceptions=(Cancelled,),
        )]

    with pytest.raises(Cancelled):
        asyncio.run(collect())


def test_hf_sdk_response_statuses_drive_retry_classification():
    from services.hf_download_assets import _is_retryable_download_error

    class SdkError(Exception):
        def __init__(self, status_code):
            self.response = type("Response", (), {"status_code": status_code})()

    assert _is_retryable_download_error(SdkError(401)) is False
    assert _is_retryable_download_error(SdkError(403)) is False
    assert _is_retryable_download_error(SdkError(404)) is False
    assert _is_retryable_download_error(SdkError(408)) is True
    assert _is_retryable_download_error(SdkError(425)) is True
    assert _is_retryable_download_error(SdkError(429)) is True
    assert _is_retryable_download_error(SdkError(503)) is True
