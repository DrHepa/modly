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
        ("video", "video"),
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
    from routers import generation

    generator_registry._manifests[api_modules["valid_model_id"]]["input"] = declared_input
    workspace_dir = api_modules["workspace_dir"]
    captured = {}

    def capture_job(*args, **kwargs):
        captured["collection"] = kwargs.get("collection", args[-1])
        return SimpleNamespace(job_id="safe-job")

    monkeypatch.setattr(generation, f"create_from_{endpoint}_job", capture_job)

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
        if endpoint == "video":
            video_path = workspace_dir / "Inputs" / "safe.capture"
            video_path.parent.mkdir(parents=True)
            video_path.write_bytes(b"video")
            payload["video_path"] = "Inputs/safe.capture"
        elif endpoint == "text":
            payload["prompt"] = "Create a safe mesh"
        elif endpoint == "scene":
            scene_path = workspace_dir / "Scenes" / "safe.json"
            scene_path.parent.mkdir(parents=True)
            scene_path.write_text(
                '{"schema":"modly.scene-manifest.v1","sceneRoot":"root.glb"}',
                encoding="utf-8",
            )
            payload["scene_path"] = "Scenes/safe.json"
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
            image_bytes=b"image",
            params={"filename": "direct-safe.glb"},
            collection=collection,
        )
    )

    assert job.status == "done"
    assert job.output_url == "/workspace/Default/direct-safe.glb"
    assert (api_modules["workspace_dir"] / "Default" / "direct-safe.glb").is_file()
    assert not (api_modules["workspace_dir"].parent / "direct-safe.glb").exists()
