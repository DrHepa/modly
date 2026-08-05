from pathlib import Path

import pytest


def _select_video_model(api_modules):
    from services.generator_registry import generator_registry

    generator_registry._manifests[api_modules["valid_model_id"]]["input"] = "video"


def _capture_video_generation(api_modules, monkeypatch):
    captured: list[dict] = []

    def generate(generation_input, params, progress_cb=None, cancel_event=None):
        captured.append({
            "generation_input": generation_input,
            "exists_during_generate": Path(generation_input).is_file(),
            "params": dict(params),
        })
        if progress_cb:
            progress_cb(75, "Generating mesh")
        output_path = api_modules["fake_generator"].outputs_dir / params.get(
            "filename",
            "video-output.glb",
        )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"glb")
        return output_path

    monkeypatch.setattr(api_modules["fake_generator"], "generate", generate)
    return captured


def test_generate_from_video_workspace_path_reaches_generator_and_returns_mesh(
    client,
    api_modules,
    monkeypatch,
):
    _select_video_model(api_modules)
    captured = _capture_video_generation(api_modules, monkeypatch)
    video_path = api_modules["workspace_dir"] / "Inputs" / "turntable.capture"
    video_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"video")

    response = client.post(
        "/generate/from-video",
        json={
            "video_path": "Inputs/turntable.capture",
            "model_id": api_modules["valid_model_id"],
            "collection": "VideoRuns",
            "params": {"filename": "from-video.glb", "quality": "draft"},
        },
    )

    assert response.status_code == 200
    status_response = client.get(f"/generate/status/{response.json()['job_id']}")
    assert status_response.status_code == 200
    assert status_response.json()["status"] == "done"
    assert status_response.json()["output_kind"] == "mesh"
    assert status_response.json()["output_url"] == "/workspace/VideoRuns/from-video.glb"
    assert captured == [{
        "generation_input": video_path.resolve(),
        "exists_during_generate": True,
        "params": {
            "remesh": "quad",
            "enable_texture": False,
            "texture_resolution": 1024,
            "filename": "from-video.glb",
            "quality": "draft",
        },
    }]
    assert video_path.exists()


def test_generate_from_video_rejects_traversal_and_symlink_escape(
    client,
    api_modules,
    tmp_path,
):
    _select_video_model(api_modules)
    workspace_dir = api_modules["workspace_dir"]
    external_video = tmp_path / "external.mp4"
    external_video.write_bytes(b"video")
    symlink_path = workspace_dir / "Inputs" / "escape.mp4"
    symlink_path.parent.mkdir(parents=True)
    try:
        symlink_path.symlink_to(external_video)
    except NotImplementedError:
        pytest.skip("symlink creation is unavailable on this platform")
    except OSError as exc:
        if getattr(exc, "winerror", None) == 1314:
            pytest.skip("symlink creation requires additional privileges on this platform")
        raise

    responses = [
        client.post(
            "/generate/from-video",
            json={
                "video_path": "../external.mp4",
                "model_id": api_modules["valid_model_id"],
            },
        ),
        client.post(
            "/generate/from-video",
            json={
                "video_path": "Inputs/escape.mp4",
                "model_id": api_modules["valid_model_id"],
            },
        ),
    ]

    assert [response.status_code for response in responses] == [400, 400]
    assert api_modules["generation_jobs"]._jobs == {}


def test_generate_from_video_rejects_model_input_mismatch(
    client,
    api_modules,
):
    video_path = api_modules["workspace_dir"] / "Inputs" / "workflow.mp4"
    video_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"video")

    response = client.post(
        "/generate/from-video",
        json={
            "video_path": "Inputs/workflow.mp4",
            "model_id": api_modules["valid_model_id"],
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "Model 'demo/fake' expects input 'image' but this endpoint received 'video'."
    )
    assert api_modules["generation_jobs"]._jobs == {}


def test_generate_from_video_rejects_multipart_form_transport(
    client,
    api_modules,
):
    _select_video_model(api_modules)

    response = client.post(
        "/generate/from-video",
        data={
            "video_path": "Inputs/workflow.mp4",
            "model_id": api_modules["valid_model_id"],
        },
    )

    assert response.status_code == 422
    assert api_modules["generation_jobs"]._jobs == {}
