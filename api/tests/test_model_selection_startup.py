"""Startup selection must not depend on extension discovery order."""

import asyncio
from pathlib import Path

import httpx
import pytest
from fastapi import BackgroundTasks, FastAPI, HTTPException

import services.generation_jobs as generation_jobs
import services.generator_registry as registry_module
from services.generator_registry import GeneratorRegistry


MODEL_A = "fixture/model-a"
MODEL_B = "fixture/model-b"


class NoLoadGenerator:
    DISPLAY_NAME = "Fixture"
    VRAM_GB = 0
    instances = []

    def __init__(self, model_dir, outputs_dir):
        self.model_dir = model_dir
        self.outputs_dir = outputs_dir
        self.load_calls = 0
        self.unload_calls = 0
        self.instances.append(self)

    def is_loaded(self):
        return False

    def is_downloaded(self):
        return True

    def load(self):
        self.load_calls += 1

    def unload(self):
        self.unload_calls += 1

    def params_schema(self):
        return []


def make_registry(monkeypatch, tmp_path: Path, selected: str, order: tuple[str, str]):
    monkeypatch.setenv("SELECTED_MODEL_ID", selected)
    monkeypatch.setattr(registry_module, "MODELS_DIR", tmp_path / "models")
    monkeypatch.setattr(registry_module, "WORKSPACE_DIR", tmp_path / "workspace")
    NoLoadGenerator.instances.clear()
    entries = {
        model_id: (
            NoLoadGenerator,
            {"id": model_id, "ext_id": "fixture", "name": model_id, "input": "image"},
            tmp_path / "extension",
        )
        for model_id in order
    }
    monkeypatch.setattr(registry_module, "_discover_extensions", lambda: entries)
    registry = GeneratorRegistry()
    registry.initialize()
    return registry


@pytest.mark.parametrize("order", [(MODEL_A, MODEL_B), (MODEL_B, MODEL_A)])
@pytest.mark.parametrize(
    ("selected", "expected"),
    [("", None), (MODEL_B, MODEL_B), ("fixture/missing", None)],
)
def test_startup_selection_is_explicit_and_never_loads_weights(
    monkeypatch, tmp_path, selected, expected, order
):
    registry = make_registry(monkeypatch, tmp_path, selected, order)
    try:
        assert registry._active_id == expected
        assert {row["id"]: row["active"] for row in registry.all_status()} == {
            MODEL_A: expected == MODEL_A,
            MODEL_B: expected == MODEL_B,
        }
        assert all(generator.load_calls == 0 for generator in NoLoadGenerator.instances)
        if expected is None:
            status = registry.active_status()
            assert status["id"] is None
            assert status["loaded"] is False
            assert status["downloaded"] is False
            with pytest.raises(ValueError, match="No model selected"):
                registry.get_active()
            registry.switch_model(MODEL_A)
            assert registry.active_status()["id"] == MODEL_A
            assert all(generator.load_calls == 0 for generator in NoLoadGenerator.instances)
        else:
            assert registry.active_status()["id"] == expected
    finally:
        registry._runtime_readiness_executor.shutdown(wait=False)


def test_unselected_status_and_omitted_job_are_clear_without_creating_work(
    monkeypatch, tmp_path
):
    from routers import generation as generation_router
    from routers import model as model_router
    from routers import workflow_runs as workflow_router

    registry = make_registry(monkeypatch, tmp_path, "", (MODEL_B, MODEL_A))
    monkeypatch.setattr(model_router, "generator_registry", registry)
    monkeypatch.setattr(generation_router, "generator_registry", registry)
    monkeypatch.setattr(workflow_router, "generator_registry", registry)
    monkeypatch.setattr(generation_jobs, "generator_registry", registry)
    jobs_before = set(generation_jobs._jobs)
    app = FastAPI()
    app.include_router(model_router.router, prefix="/model")
    app.include_router(generation_router.router, prefix="/generate")
    app.include_router(workflow_router.router, prefix="/workflow-runs")

    async def exercise_routes():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            status = await client.get("/model/status")
            assert status.status_code == 200
            assert status.json()["id"] is None
            assert status.json()["loaded"] is False
            assert all(not row["active"] for row in (await client.get("/model/all")).json())
            params = await client.get("/model/params")
            assert params.status_code == 409
            assert "No model selected" in params.text
            assert (await client.get(f"/model/params?model_id={MODEL_A}")).json() == []

            for path in ("/generate/from-image", "/workflow-runs/from-image"):
                response = await client.post(
                    path,
                    files={"image": ("input.png", b"image", "image/png")},
                )
                assert response.status_code == 400
                assert "No model selected" in response.text
            for path in ("/generate/from-text", "/workflow-runs/from-text"):
                response = await client.post(path, json={"prompt": "A small statue"})
                assert response.status_code == 400
                assert "No model selected" in response.text

            with pytest.raises(HTTPException, match="No model selected"):
                generation_jobs.create_from_image_job(BackgroundTasks(), b"image", {})
            assert set(generation_jobs._jobs) == jobs_before

            switched = await client.post(f"/model/switch?model_id={MODEL_A}")
            assert switched.status_code == 200
            assert switched.json() == {"active": MODEL_A}
            assert (await client.get("/model/status")).json()["id"] == MODEL_A
            assert all(generator.load_calls == 0 for generator in NoLoadGenerator.instances)

    try:
        asyncio.run(exercise_routes())
    finally:
        registry._runtime_readiness_executor.shutdown(wait=False)


@pytest.mark.parametrize("discovery_case", ["empty", "all_failed"])
def test_invalid_selected_id_with_no_usable_generators_is_unselected_before_jobs(
    monkeypatch, tmp_path, discovery_case
):
    from routers import model as model_router

    monkeypatch.setenv("SELECTED_MODEL_ID", "fixture/missing")
    monkeypatch.setattr(registry_module, "MODELS_DIR", tmp_path / "models")
    monkeypatch.setattr(registry_module, "WORKSPACE_DIR", tmp_path / "workspace")

    class FailingGenerator:
        def __init__(self, model_dir, outputs_dir):
            raise RuntimeError("fixture cannot instantiate")

    entries = {} if discovery_case == "empty" else {
        MODEL_A: (
            FailingGenerator,
            {"id": MODEL_A, "ext_id": "fixture", "name": MODEL_A, "input": "image"},
            tmp_path / "extension",
        )
    }
    monkeypatch.setattr(registry_module, "_discover_extensions", lambda: entries)
    registry = GeneratorRegistry()
    registry.initialize()
    monkeypatch.setattr(model_router, "generator_registry", registry)
    monkeypatch.setattr(generation_jobs, "generator_registry", registry)
    app = FastAPI()
    app.include_router(model_router.router, prefix="/model")
    jobs_before = set(generation_jobs._jobs)

    async def check_status():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            response = await client.get("/model/status")
            assert response.status_code == 200
            assert response.json()["id"] is None
            assert response.json()["loaded"] is False
            assert (await client.get("/model/all")).json() == []

    try:
        assert registry._active_id is None
        assert registry.all_status() == []
        asyncio.run(check_status())
        with pytest.raises(HTTPException, match="No model selected"):
            generation_jobs.create_from_image_job(BackgroundTasks(), b"image", {})
        assert set(generation_jobs._jobs) == jobs_before
    finally:
        registry._runtime_readiness_executor.shutdown(wait=False)
