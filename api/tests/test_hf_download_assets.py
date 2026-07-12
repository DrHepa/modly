import asyncio
import hashlib
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

from services.hf_download_assets import (
    HfDownloadManifestError,
    _default_download_file,
    _safe_exception_message,
    hf_download_assets_ready,
    stream_hf_asset_downloads,
    validate_hf_downloads,
)


REVISION = "ef15eda2e413f994e3b4657960b0309487587718"


def _plan(*files: dict) -> list[dict]:
    return [{
        "repo_id": "owner/model",
        "revision": REVISION,
        "target_subdir": "cube3d",
        "files": list(files),
    }]


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
        "hf_repo": "owner/model",
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

    async def fake_stream(owner_dir, resolved_plan, token=None):
        calls.append((owner_dir, resolved_plan, token))
        yield {"percent": 100, "status": "done"}

    monkeypatch.setattr(model_router, "stream_hf_asset_downloads", fake_stream)

    app = FastAPI()
    app.include_router(model_router.router, prefix="/model")
    client = TestClient(app)
    response = client.get(
        "/model/hf-download-assets",
        params={"model_id": "cube3d/generate"},
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
    assert calls == [(tmp_path / "cube3d/generate", plan, "private-token")]
