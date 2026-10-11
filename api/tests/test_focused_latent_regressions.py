"""Separate RED-only proposals: no production remedy before actual evidence."""
import asyncio

import httpx
import pytest
from fastapi import BackgroundTasks, FastAPI, HTTPException

from conftest import PNG_BYTES
from routers import agent
from services import generation_jobs
from services import generator_registry as registry_module
from services.extension_process import ExtensionProcess
from services.generators.base import BaseGenerator
from services.hf_download_assets import hf_download_assets_ready
from services.https_download_assets import https_download_assets_ready
from test_agent_worlds import request as worlds_request
from test_hf_download_assets import _plan
from test_https_download_assets import _asset, _collect, _ChunkStream
from test_model_selection_startup import make_registry, MODEL_A, MODEL_B


@pytest.mark.parametrize("registry_case", ["unselected", "empty", "all_failed"])
def test_latent_omitted_model_rejects_before_any_job_allocation(monkeypatch, tmp_path, registry_case):
    if registry_case == "unselected":
        registry = make_registry(monkeypatch, tmp_path, "", (MODEL_B, MODEL_A))
    else:
        monkeypatch.setenv("SELECTED_MODEL_ID", "fixture/missing")
        monkeypatch.setattr(registry_module, "MODELS_DIR", tmp_path / "models")
        monkeypatch.setattr(registry_module, "WORKSPACE_DIR", tmp_path / "workspace")
        extension = tmp_path / "extension"
        extension.mkdir()
        class FailingGenerator:
            def __init__(self, _model_dir, _outputs_dir):
                raise RuntimeError("fixture cannot instantiate")
        def discover(manager, _authorization):
            entries = {} if registry_case == "empty" else {
                MODEL_A: (FailingGenerator, {"id": MODEL_A, "ext_id": "fixture", "input": "image"},
                          extension, manager.register(extension)),
            }
            return entries, {}
        monkeypatch.setattr(registry_module, "_discover_extensions", discover)
        registry = registry_module.GeneratorRegistry()
        registry.initialize()
    monkeypatch.setattr(generation_jobs, "generator_registry", registry)
    jobs_before = set(generation_jobs._jobs)
    allocations = []
    real_create = generation_jobs.create_job
    def create():
        allocations.append("allocated")
        return real_create()
    monkeypatch.setattr(generation_jobs, "create_job", create)
    tasks = BackgroundTasks()
    try:
        assert registry._active_id is None
        with pytest.raises(HTTPException) as raised:
            generation_jobs.create_from_image_job(tasks, PNG_BYTES, {}, model_id=None)
        assert raised.value.status_code in (400, 409)
        assert "No model selected" in raised.value.detail
        assert allocations == []
        assert tasks.tasks == []
        assert set(generation_jobs._jobs) == jobs_before
    finally:
        # Retain the assertion, but do not let a RED leak state into another case.
        for job_id in set(generation_jobs._jobs) - jobs_before:
            generation_jobs._jobs.pop(job_id, None)
            generation_jobs._cancel_events.pop(job_id, None)
            generation_jobs._last_logged_snapshots.pop(job_id, None)
        registry._runtime_readiness_executor.shutdown(wait=False)


@pytest.mark.parametrize("surface", ["base", "extension"])
def test_latent_mixed_sources_require_both_hf_and_https_readiness(tmp_path, surface):
    model_id = "demo/generate"
    owner = tmp_path / model_id
    payload = b"model"
    https_plan = [_asset("model.bin", payload)]
    hf_plan = _plan({"path": "weights/missing.bin"})
    events = _collect(owner, model_id, https_plan,
        handler=lambda request: httpx.Response(200, stream=_ChunkStream(payload), request=request))
    assert events[-1]["status"] == "done"
    assert https_download_assets_ready(owner, model_id, https_plan)
    assert not hf_download_assets_ready(owner, hf_plan)
    if surface == "base":
        class Generator(BaseGenerator):
            def load(self):
                self._model = object()
            def generate(self, _image, _params, progress_cb=None, cancel_event=None):
                return self.outputs_dir / "unused.glb"
        generator = Generator(owner, tmp_path / "outputs")
        generator.model_id = model_id
        generator.hf_downloads = hf_plan
        generator.https_downloads = https_plan
    else:
        generator = ExtensionProcess(tmp_path / "extension", {
            "id": model_id, "hf_downloads": hf_plan, "https_downloads": https_plan,
        })
        generator.model_dir = owner
    assert generator.is_downloaded() is False

    hf_file = owner / hf_plan[0]["target_subdir"] / hf_plan[0]["files"][0]["path"]
    hf_file.parent.mkdir(parents=True, exist_ok=True)
    hf_file.write_bytes(b"hf weights")
    assert hf_download_assets_ready(owner, hf_plan)
    assert generator.is_downloaded() is True

    generator.hf_downloads = []
    assert generator.is_downloaded() is True  # HTTPS-only remains supported.
    generator.hf_downloads = hf_plan
    generator.https_downloads = []
    assert generator.is_downloaded() is True  # HF-only remains supported.
    hf_file.unlink()
    assert generator.is_downloaded() is False


@pytest.mark.parametrize("key", ["OPENAI_API_KEY", "apiKey", "authorization", "openaiApiKey"])
def test_latent_worlds_unknown_secret_field_is_rejected_without_echo(monkeypatch, key):
    async def forbidden(*_args, **_kwargs):
        raise AssertionError("Rejected body must not reach the dedicated provider")
    monkeypatch.setattr(agent, "_run_openai_worlds_chat", forbidden)
    app = FastAPI()
    app.include_router(agent.router)
    body = {**worlds_request(), "worldProvider": "openai", "model": "gpt-5.1", key: "sk-should-not-enter"}
    async def post():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/agent/chat", json=body)
    response = asyncio.run(post())
    assert response.status_code == 422
    assert any(error["type"] == "extra_forbidden" and error["loc"][-1] == key
               for error in response.json()["detail"])
    assert "sk-should-not-enter" not in response.text


@pytest.mark.parametrize(
    ("selected", "requested", "expected"),
    [(MODEL_B, None, MODEL_B), (MODEL_B, MODEL_A, MODEL_A), ("", MODEL_A, MODEL_A)],
)
def test_generation_admission_pins_selected_or_explicit_model_without_activation(
    monkeypatch, tmp_path, selected, requested, expected,
):
    registry = make_registry(monkeypatch, tmp_path, selected, (MODEL_A, MODEL_B))
    monkeypatch.setattr(generation_jobs, "generator_registry", registry)
    def forbidden_active():
        raise AssertionError("Admission must not activate a generator")
    monkeypatch.setattr(registry, "get_active", forbidden_active)
    jobs_before = set(generation_jobs._jobs)
    tasks = BackgroundTasks()
    params = {"quality": "high"}
    try:
        job = generation_jobs.create_from_image_job(tasks, PNG_BYTES, params, model_id=requested)
        assert len(tasks.tasks) == 1
        queued = tasks.tasks[0]
        assert queued.func is generation_jobs._run_generation
        assert queued.args == (job.job_id, PNG_BYTES, params, "Default", "mesh", expected)
        assert queued.kwargs == {"private_input_dir": None}
        assert all(generator.load_calls == 0 for generator in registry._generators.values())
        switched = MODEL_A if expected == MODEL_B else MODEL_B
        registry.switch_model(switched)
        assert registry._active_id == switched
        assert queued.args[-1] == expected
        assert all(generator.load_calls == 0 for generator in registry._generators.values())
    finally:
        for job_id in set(generation_jobs._jobs) - jobs_before:
            generation_jobs._jobs.pop(job_id, None)
            generation_jobs._cancel_events.pop(job_id, None)
            generation_jobs._last_logged_snapshots.pop(job_id, None)
        registry._runtime_readiness_executor.shutdown(wait=False)
