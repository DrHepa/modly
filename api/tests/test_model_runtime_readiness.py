import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import model
from services.generator_registry import generator_registry


class ReadyGenerator:
    DISPLAY_NAME = "Runtime Ready"
    VRAM_GB = 0

    def is_downloaded(self) -> bool:
        return True

    def is_loaded(self) -> bool:
        return False

    def readiness_status(self) -> dict:
        return {
            "ok": True,
            "machine_code": "ready",
            "label_hint": "Ready",
            "checked_at": "2026-04-24T00:00:00Z",
        }


class LegacyGenerator:
    DISPLAY_NAME = "Legacy"
    VRAM_GB = 0

    def is_downloaded(self) -> bool:
        return True

    def is_loaded(self) -> bool:
        return False



def _client() -> TestClient:
    app = FastAPI()
    app.include_router(model.router, prefix="/model")
    return TestClient(app)


def test_runtime_readiness_uses_canonical_ids_and_preserves_model_all(monkeypatch):
    monkeypatch.setattr(
        generator_registry,
        "_generators",
        {
            "runtime-ext/text-to-image": ReadyGenerator(),
            "legacy-ext/image-to-mesh": LegacyGenerator(),
        },
        raising=False,
    )
    monkeypatch.setattr(
        generator_registry,
        "_manifests",
        {
            "runtime-ext/text-to-image": {"id": "runtime-ext/text-to-image", "name": "Runtime Ready"},
            "legacy-ext/image-to-mesh": {"id": "legacy-ext/image-to-mesh", "name": "Legacy"},
        },
        raising=False,
    )
    monkeypatch.setattr(generator_registry, "_active_id", "runtime-ext/text-to-image", raising=False)

    client = _client()
    response = client.get(
        "/model/runtime-readiness",
        params={"model_ids": "runtime-ext/text-to-image,legacy-ext/image-to-mesh,missing/model"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload == {
        "readiness": {
            "runtime-ext/text-to-image": {
                "ok": True,
                "machine_code": "ready",
                "label_hint": "Ready",
                "checked_at": "2026-04-24T00:00:00Z",
            },
            "legacy-ext/image-to-mesh": {
                "ok": False,
                "machine_code": "unsupported_contract",
                "label_hint": "Checking failed",
                "reason": "Model does not expose runtime readiness.",
                "checked_at": payload["readiness"]["legacy-ext/image-to-mesh"]["checked_at"],
            },
        }
    }

    all_response = client.get("/model/all")
    assert all_response.status_code == 200
    assert all_response.json() == [
        {
            "id": "runtime-ext/text-to-image",
            "name": "Runtime Ready",
            "description": "",
            "version": "",
            "vram_gb": 0,
            "hf_repo": "",
            "tags": [],
            "downloaded": True,
            "loaded": False,
            "active": True,
        },
        {
            "id": "legacy-ext/image-to-mesh",
            "name": "Legacy",
            "description": "",
            "version": "",
            "vram_gb": 0,
            "hf_repo": "",
            "tags": [],
            "downloaded": True,
            "loaded": False,
            "active": False,
        },
    ]


def test_runtime_readiness_rejects_non_canonical_or_traversal_like_ids(monkeypatch):
    monkeypatch.setattr(generator_registry, "_generators", {"runtime-ext/text-to-image": ReadyGenerator()}, raising=False)
    monkeypatch.setattr(
        generator_registry,
        "_manifests",
        {"runtime-ext/text-to-image": {"id": "runtime-ext/text-to-image", "name": "Runtime Ready"}},
        raising=False,
    )

    client = _client()
    response = client.get("/model/runtime-readiness", params={"model_ids": "runtime-ext/text-to-image,../secret"})

    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid model ID: ../secret"
