"""The workflow service extraction must preserve the upstream job lifecycle."""

import asyncio
import json
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks


def test_relocated_workspace_controls_output_and_scene_candidate(api_modules, monkeypatch, tmp_path):
    import services.generator_registry as registry

    jobs = api_modules["generation_jobs"]
    relocated = tmp_path / "relocated"
    monkeypatch.setattr(registry, "WORKSPACE_DIR", relocated)
    job = jobs.create_from_image_job(BackgroundTasks(), b"mesh", {}, "Exports")
    asyncio.run(jobs._run_generation(job.job_id, b"mesh", {}, "Exports"))

    assert job.status == "done"
    assert api_modules["fake_generator"].outputs_dir == relocated / "Exports"
    assert job.scene_candidate.workspace_path == "Exports/mesh.glb"
    assert job.output_url == "/workspace/Exports/mesh.glb"
    assert not (api_modules["workspace_dir"] / "Exports").exists()


@pytest.mark.parametrize("output_kind", ["image", "audio", "scene"])
def test_non_mesh_outputs_do_not_become_mesh_candidates(api_modules, output_kind):
    jobs = api_modules["generation_jobs"]
    background = BackgroundTasks()
    params = {"filename": "result.png"}
    if output_kind == "scene":
        # A malformed scene must fail, never get advertised as an insertable mesh.
        params["filename"] = "scene-manifest.json"
    job = jobs.create_from_image_job(
        background, b"artifact", params, "Exports", output_kind, api_modules["valid_model_id"],
    )
    asyncio.run(background())
    assert job.status == ("error" if output_kind == "scene" else "done")
    assert job.scene_candidate is None


def test_job_creation_purges_terminal_jobs_from_every_store(api_modules):
    jobs = api_modules["generation_jobs"]
    stale = jobs.create_job()
    jobs.cancel_job(stale.job_id)
    assert stale.job_id in jobs._completed_at
    jobs._completed_at[stale.job_id] = time.monotonic() - jobs._JOB_TTL - 1
    fresh = jobs.create_job()
    for store in (jobs._jobs, jobs._cancel_events, jobs._cancelled, jobs._completed_at, jobs._job_generators):
        assert stale.job_id not in store
    assert fresh.job_id in jobs._jobs


def test_cancel_queued_job_does_not_kill_active_generator(api_modules):
    jobs = api_modules["generation_jobs"]
    killed = []
    gen = api_modules["fake_generator"]
    gen._proc = SimpleNamespace(poll=lambda: None, kill=lambda: killed.append(True))
    queued = jobs.create_job()
    jobs.cancel_job(queued.job_id)
    assert queued.status == "cancelled"
    assert jobs._cancel_events[queued.job_id].is_set()
    assert killed == []


def test_progress_never_moves_backwards(api_modules, monkeypatch):
    jobs = api_modules["generation_jobs"]
    gen = api_modules["fake_generator"]
    job = jobs.create_job()
    samples = []

    def generate(image_bytes, params, progress_cb, cancel_event=None):
        for progress in (40, 85, 0, 20):
            progress_cb(progress)
            samples.append(job.progress)
        output = gen.outputs_dir / "mesh.glb"
        output.write_bytes(b"mesh")
        return output

    monkeypatch.setattr(gen, "generate", generate)
    asyncio.run(jobs._run_generation(job.job_id, b"mesh", {}))
    assert job.status == "done"
    assert samples == [40, 85, 85, 85]


def test_selected_variant_fails_before_loading_pinned_model(api_modules, monkeypatch):
    jobs = api_modules["generation_jobs"]
    calls = []

    def preflight(params, model_id=None):
        calls.append((params, model_id))
        raise RuntimeError("Selected variant is not installed")

    monkeypatch.setattr(jobs.generator_registry, "assert_weight_variant_installed", preflight)
    background = BackgroundTasks()
    job = jobs.create_from_image_job(
        background, b"mesh", {"variant": "missing"}, "Exports", "mesh", api_modules["valid_model_id"],
    )
    asyncio.run(background())
    assert job.status == "error"
    assert "Selected variant is not installed" in job.error
    assert calls == [({"variant": "missing"}, api_modules["valid_model_id"])]
    assert not api_modules["fake_generator"].is_loaded()
    assert job.job_id in jobs._completed_at


def test_scene_http_route_shares_status_and_validates_scene_output(client, api_modules, monkeypatch):
    jobs = api_modules["generation_jobs"]
    gen = api_modules["fake_generator"]
    model_id = api_modules["valid_model_id"]
    monkeypatch.setitem(jobs.generator_registry._manifests, model_id, {
        "input": "scene", "output": "scene", "name": "Fake Scene Generator",
    })
    scene = api_modules["workspace_dir"] / "Input"
    scene.mkdir()
    source = scene / "scene-manifest.json"
    source.write_text(json.dumps({"schema": "modly.scene-manifest.v1", "sceneRoot": ".", "assets": []}))
    calls = []

    def generate_artifact(kind, path, params, progress_cb, cancel_event=None):
        calls.append((kind, path, params))
        output = gen.outputs_dir / "scene-manifest.json"
        output.write_text(source.read_text())
        return output

    monkeypatch.setattr(gen, "generate_artifact", generate_artifact, raising=False)
    response = client.post("/generate/from-artifact", json={
        "input_kind": "scene", "input_path": "Input", "model_id": model_id,
        "collection": "Exports", "params": {"quality": "high", "artifact_path": "/not-trusted"},
    })
    assert response.status_code == 200
    job_id = response.json()["job_id"]
    legacy = client.get(f"/generate/status/{job_id}").json()
    workflow = client.get(f"/workflow-runs/{job_id}").json()
    assert legacy["status"] == workflow["status"] == "done"
    assert workflow["run_id"] == legacy["job_id"] == job_id
    assert workflow["scene_candidate"] is None
    assert workflow["output_url"] == "/workspace/Exports/scene-manifest.json"
    assert calls == [("scene", source.resolve(), {
        "quality": "high", "scene_manifest_path": str(source.resolve()),
    })]
    assert job_id in jobs._completed_at


def test_scene_input_is_revalidated_after_queueing(api_modules, monkeypatch):
    from routers.generation import generate_from_artifact
    from schemas.generation import GenerateFromArtifactRequest

    jobs = api_modules["generation_jobs"]
    model_id = api_modules["valid_model_id"]
    monkeypatch.setitem(jobs.generator_registry._manifests, model_id, {"input": "scene"})
    source = api_modules["workspace_dir"] / "scene-manifest.json"
    source.write_text(json.dumps({"schema": "modly.scene-manifest.v1", "sceneRoot": ".", "assets": []}))
    background = BackgroundTasks()
    response = asyncio.run(generate_from_artifact(GenerateFromArtifactRequest(
        input_kind="scene", input_path="scene-manifest.json", model_id=model_id,
    ), background))
    source.write_text("not a scene anymore")
    asyncio.run(background())
    job = jobs.get_job_status(response["job_id"])
    assert job.status == "error"
    assert job.output_url is None
    assert job.scene_candidate is None
    assert job.job_id in jobs._completed_at


def test_workflow_route_pins_without_loading_and_forwards_collection_and_output_kind(api_modules, image_upload):
    from fastapi import UploadFile
    from io import BytesIO
    from starlette.datastructures import Headers
    from routers.workflow_runs import create_from_image_run

    jobs = api_modules["generation_jobs"]
    jobs.generator_registry._manifests[api_modules["valid_model_id"]]["output"] = "image"
    image = UploadFile(BytesIO(image_upload[1]), headers=Headers({"content-type": "image/png"}))
    background = BackgroundTasks()
    response = asyncio.run(create_from_image_run(
        background, image, api_modules["valid_model_id"], " Exports ", '{"custom": 42}',
    ))
    assert response.status == "pending"
    assert not api_modules["fake_generator"].is_loaded()
    queued = background.tasks[0]
    assert queued.func is jobs._run_generation
    assert queued.args[2] == {"remesh": "quad", "enable_texture": False, "texture_resolution": 1024, "custom": 42}
    assert queued.args[3:] == ("Exports", "image", api_modules["valid_model_id"])
    asyncio.run(background())
    assert jobs.get_job_status(response.run_id).status == "done"
    assert jobs.get_job_status(response.run_id).scene_candidate is None


def test_status_remains_responsive_while_pinned_preflight_blocks(api_modules, monkeypatch):
    from routers.generation import job_status
    from routers.workflow_runs import get_workflow_run

    jobs = api_modules["generation_jobs"]
    entered = threading.Event()
    release = threading.Event()

    def preflight(params, model_id=None):
        entered.set()
        if not release.wait(2):
            raise AssertionError("test did not release variant preflight")

    monkeypatch.setattr(jobs.generator_registry, "assert_weight_variant_installed", preflight)
    background = BackgroundTasks()
    job = jobs.create_from_image_job(
        background, b"mesh", {}, "Exports", "mesh", api_modules["valid_model_id"],
    )

    async def scenario():
        task = asyncio.create_task(background())
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            legacy = await asyncio.wait_for(job_status(job.job_id), 0.25)
            workflow = await asyncio.wait_for(get_workflow_run(job.job_id), 0.25)
            assert legacy.status == workflow.status == "running"
        finally:
            release.set()
            await asyncio.wait_for(task, 1)

    asyncio.run(scenario())
    assert job.status == "done"


@pytest.mark.parametrize("params", ["{bad", "[]", "null", "42"])
def test_legacy_params_remain_permissive(client, api_modules, image_upload, params):
    response = client.post("/generate/from-image", files={"image": image_upload}, data={
        "model_id": api_modules["valid_model_id"], "params": params,
    })
    assert response.status_code == 200
    job_id = response.json()["job_id"]
    assert client.get(f"/generate/status/{job_id}").json()["status"] == "done"
