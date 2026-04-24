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


class ActionReadyGenerator(ReadyGenerator):
    def readiness_status(self) -> dict:
        return {
            "ok": True,
            "machine_code": "ready",
            "label_hint": "Ready",
            "checked_at": "2026-04-24T00:00:00Z",
            "actions": [
                {"id": "details", "kind": "show_details", "label": "Details", "safety": "manual"},
                {
                    "id": "refresh",
                    "kind": "refresh_readiness",
                    "label": "Refresh",
                    "safety": "non_destructive",
                    "refresh_after": "always",
                },
            ],
            "details": {
                "title": "Runtime ready",
                "summary": "Codex is available.",
                "diagnostics": {
                    "runtime_name": "codex",
                    "runtime_version": "0.122.0",
                    "runtime_version_supported": "true",
                    "platform_supported": "true",
                    "auth_state": "authenticated",
                    "entitlement_state": "available",
                    "diagnostic_status": "complete",
                },
            },
        }


class RepairActionGenerator(ReadyGenerator):
    def readiness_status(self) -> dict:
        return {
            "ok": False,
            "machine_code": "preflight/import_failed",
            "label_hint": "Extension setup needs attention",
            "checked_at": "2026-04-24T00:00:00Z",
            "actions": [
                {
                    "id": "repair-extension",
                    "kind": "repair_extension",
                    "label": "Repair extension",
                    "safety": "confirm",
                    "requires_confirmation": True,
                },
                {"id": "details", "kind": "show_details", "label": "Details", "safety": "manual"},
            ],
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


def test_runtime_readiness_endpoint_returns_sanitized_actions_and_details(monkeypatch):
    monkeypatch.setattr(generator_registry, "_generators", {"runtime-ext/text-to-image": ActionReadyGenerator()}, raising=False)
    monkeypatch.setattr(
        generator_registry,
        "_manifests",
        {"runtime-ext/text-to-image": {"id": "runtime-ext/text-to-image", "name": "Runtime Ready"}},
        raising=False,
    )
    generator_registry._runtime_readiness_cache.clear()

    client = _client()
    response = client.get("/model/runtime-readiness", params={"model_ids": "runtime-ext/text-to-image"})

    assert response.status_code == 200
    readiness = response.json()["readiness"]["runtime-ext/text-to-image"]
    assert readiness["actions"] == [
        {"id": "details", "kind": "show_details", "label": "Details", "safety": "manual"},
        {
            "id": "refresh",
            "kind": "refresh_readiness",
            "label": "Refresh",
            "safety": "non_destructive",
            "refresh_after": "always",
        },
    ]
    assert readiness["details"]["diagnostics"] == {
        "runtime_name": "codex",
        "runtime_version": "0.122.0",
        "runtime_version_supported": "true",
        "platform_supported": "true",
        "auth_state": "authenticated",
        "entitlement_state": "available",
        "diagnostic_status": "complete",
    }


def test_runtime_readiness_endpoint_strips_repair_extension_actions(monkeypatch):
    monkeypatch.setattr(generator_registry, "_generators", {"runtime-ext/text-to-image": RepairActionGenerator()}, raising=False)
    monkeypatch.setattr(
        generator_registry,
        "_manifests",
        {"runtime-ext/text-to-image": {"id": "runtime-ext/text-to-image", "name": "Runtime Ready"}},
        raising=False,
    )
    generator_registry._runtime_readiness_cache.clear()

    client = _client()
    response = client.get("/model/runtime-readiness", params={"model_ids": "runtime-ext/text-to-image"})

    assert response.status_code == 200
    readiness = response.json()["readiness"]["runtime-ext/text-to-image"]
    assert readiness["actions"] == [{"id": "details", "kind": "show_details", "label": "Details", "safety": "manual"}]
    assert "repair_extension" not in str(readiness)


def test_runtime_readiness_endpoint_preserves_legacy_payload_without_actions(monkeypatch):
    monkeypatch.setattr(generator_registry, "_generators", {"runtime-ext/text-to-image": ReadyGenerator()}, raising=False)
    monkeypatch.setattr(
        generator_registry,
        "_manifests",
        {"runtime-ext/text-to-image": {"id": "runtime-ext/text-to-image", "name": "Runtime Ready"}},
        raising=False,
    )
    generator_registry._runtime_readiness_cache.clear()

    client = _client()
    response = client.get("/model/runtime-readiness", params={"model_ids": "runtime-ext/text-to-image"})

    assert response.status_code == 200
    readiness = response.json()["readiness"]["runtime-ext/text-to-image"]
    assert readiness == {
        "ok": True,
        "machine_code": "ready",
        "label_hint": "Ready",
        "checked_at": "2026-04-24T00:00:00Z",
    }
