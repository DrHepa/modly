import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from routers.generation import sanitize_collection_name


@pytest.mark.parametrize("collection", [".", ".."])
def test_sanitize_collection_name_rejects_dot_segments(collection):
    assert sanitize_collection_name(collection) == "Default"


@pytest.mark.parametrize(
    ("endpoint", "declared_input"),
    [
        ("image", "image"),
        ("text", "text"),
        ("none", "none"),
        ("scene", "scene"),
    ],
)
def test_generation_endpoints_keep_dot_segment_collections_in_workspace(
    endpoint,
    declared_input,
    client,
    api_modules,
    image_upload,
    monkeypatch,
):
    from services.generator_registry import generator_registry
    jobs = api_modules["generation_jobs"]

    generator_registry._manifests[api_modules["valid_model_id"]]["input"] = declared_input
    generator_registry._manifests[api_modules["valid_model_id"]].pop("inputs", None)
    workspace_dir = api_modules["workspace_dir"]
    captured = {}

    async def capture_job(job_id, model_input, params, collection, output_kind, model_id, *, private_input_dir=None):
        captured["collection"] = collection

    monkeypatch.setattr(jobs, "uuid", SimpleNamespace(uuid4=lambda: "safe-job"))
    monkeypatch.setattr(jobs, "_run_generation", capture_job)

    if endpoint == "image":
        response = client.post(
            "/generate/from-image",
            files={"image": image_upload},
            data={
                "model_id": api_modules["valid_model_id"],
                "collection": "..",
                "params": "{}",
            },
        )
    else:
        payload = {
            "model_id": api_modules["valid_model_id"],
            "collection": "..",
            "params": {},
        }
        if endpoint == "text":
            payload["prompt"] = "Create a safe mesh"
        elif endpoint == "scene":
            scene_dir = workspace_dir / "Scenes" / "safe"
            scene_dir.mkdir(parents=True)
            scene_path = scene_dir / "scene-manifest.json"
            scene_path.write_text(
                '{"schema":"modly.scene-manifest.v1","sceneRoot":".","assets":[]}',
                encoding="utf-8",
            )
            payload["scene_path"] = "Scenes/safe/scene-manifest.json"
        response = client.post(f"/generate/from-{endpoint}", json=payload)

    assert response.status_code == 200
    assert response.json() == {"job_id": "safe-job"}
    assert captured == {"collection": "Default"}


@pytest.mark.parametrize("collection", [".", ".."])
def test_direct_generation_job_sanitizes_dot_segment_collection(
    collection,
    api_modules,
):
    jobs = api_modules["generation_jobs"]
    job = jobs.create_job()

    asyncio.run(
        jobs._run_generation(
            job.job_id,
            model_input=b"image",
            params={"filename": "direct-safe.glb"},
            collection=collection,
        )
    )

    assert job.status == "done"
    assert job.output_url == "/workspace/Default/direct-safe.glb"
    assert (api_modules["workspace_dir"] / "Default" / "direct-safe.glb").is_file()
    assert not (api_modules["workspace_dir"].parent / "direct-safe.glb").exists()
