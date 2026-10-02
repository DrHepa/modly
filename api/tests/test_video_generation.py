from pathlib import Path

import pytest

MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2"


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


def test_generate_from_video_artifact_reaches_generator_and_returns_mesh(
    client,
    api_modules,
    monkeypatch,
):
    _select_video_model(api_modules)
    captured = _capture_video_generation(api_modules, monkeypatch)
    video_path = api_modules["workspace_dir"] / "Workflows" / "Imported Videos" / "turntable.mp4"
    video_path.parent.mkdir(parents=True)
    video_path.write_bytes(MP4)

    response = client.post(
        "/generate/from-artifact",
        json={
            "input_kind": "video",
            "input_path": "Workflows/Imported Videos/turntable.mp4",
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
            "remesh": "none",
            "enable_texture": False,
            "texture_resolution": 1024,
            "filename": "from-video.glb",
            "quality": "draft",
        },
    }]
    assert video_path.exists()


def test_generate_from_video_artifact_rejects_undeclared_transport_alias(
    client,
    api_modules,
):
    _select_video_model(api_modules)
    video_path = api_modules["workspace_dir"] / "Workflows" / "turntable.mp4"
    video_path.parent.mkdir(parents=True)
    video_path.write_bytes(MP4)

    response = client.post(
        "/generate/from-artifact",
        json={
            "input_kind": "video",
            "input_path": "Workflows/turntable.mp4",
            "model_id": api_modules["valid_model_id"],
            "params": {"video_path": "/forged/outside.mp4"},
        },
    )

    assert response.status_code == 400
    assert "not declared" in response.text
    assert api_modules["generation_jobs"]._jobs == {}


def test_generate_from_video_artifact_rejects_traversal_and_symlink_escape(
    client,
    api_modules,
    tmp_path,
):
    _select_video_model(api_modules)
    workspace_dir = api_modules["workspace_dir"]
    external_video = tmp_path / "external.mp4"
    external_video.write_bytes(MP4)
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
            "/generate/from-artifact",
            json={
                "input_kind": "video",
                "input_path": "../external.mp4",
                "model_id": api_modules["valid_model_id"],
            },
        ),
        client.post(
            "/generate/from-artifact",
            json={
                "input_kind": "video",
                "input_path": "Inputs/escape.mp4",
                "model_id": api_modules["valid_model_id"],
            },
        ),
    ]

    assert [response.status_code for response in responses] == [400, 400]
    assert api_modules["generation_jobs"]._jobs == {}


def test_generate_from_video_artifact_rejects_model_input_mismatch(
    client,
    api_modules,
):
    video_path = api_modules["workspace_dir"] / "Inputs" / "workflow.mp4"
    video_path.parent.mkdir(parents=True)
    video_path.write_bytes(MP4)

    response = client.post(
        "/generate/from-artifact",
        json={
            "input_kind": "video",
            "input_path": "Inputs/workflow.mp4",
            "model_id": api_modules["valid_model_id"],
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "Model 'demo/fake' expects input 'image' but this endpoint received 'video'."
    )
    assert api_modules["generation_jobs"]._jobs == {}


def test_generate_from_video_artifact_rejects_multipart_form_transport(
    client,
    api_modules,
):
    _select_video_model(api_modules)

    response = client.post(
        "/generate/from-artifact",
        data={
            "input_kind": "video",
            "input_path": "Inputs/workflow.mp4",
            "model_id": api_modules["valid_model_id"],
        },
    )

    assert response.status_code == 422
    assert api_modules["generation_jobs"]._jobs == {}


def test_video_route_pins_current_queue_abi_without_request_time_activation(api_modules, monkeypatch):
    import asyncio

    from fastapi import BackgroundTasks
    from routers.generation import generate_from_video
    from schemas.generation import GenerateFromVideoRequest

    _select_video_model(api_modules)
    jobs = api_modules["generation_jobs"]
    model_id = api_modules["valid_model_id"]
    jobs.generator_registry._manifests[model_id]["output"] = "video"
    video_path = api_modules["workspace_dir"] / "Inputs" / "queued.capture"
    video_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"video")
    activation_calls = []
    monkeypatch.setattr(jobs.generator_registry, "switch_model", activation_calls.append)
    background = BackgroundTasks()

    response = asyncio.run(generate_from_video(
        GenerateFromVideoRequest(
            video_path="Inputs/queued.capture", model_id=model_id,
            collection=" VideoRuns ", params={"quality": "draft"},
        ),
        background,
    ))

    assert activation_calls == []
    assert not api_modules["fake_generator"].is_loaded()
    assert jobs.get_job_status(response["job_id"]).status == "pending"
    assert len(background.tasks) == 1
    queued = background.tasks[0]
    assert queued.func is jobs._run_generation
    assert queued.args == (
        response["job_id"], video_path.resolve(),
        {"remesh": "quad", "enable_texture": False, "texture_resolution": 1024, "quality": "draft"},
        "VideoRuns", "video", model_id,
    )
    assert queued.kwargs == {}

    # Cancelling before execution must not activate or invoke this queued model.
    cancelled = jobs.cancel_job(response["job_id"])
    assert cancelled.status == "cancelled"
    assert jobs._cancel_events[response["job_id"]].is_set()
    assert activation_calls == []
    assert video_path.read_bytes() == b"video"


@pytest.mark.parametrize(
    "mutation, expected_error",
    [
        ("escape-file", "must stay within the workspace"),
        ("escape-parent", "must stay within the workspace"),
        ("deleted", "does not reference an existing file"),
        ("directory", "must reference a regular file"),
        ("workspace-relocated", "must stay within the workspace"),
    ],
)
def test_queued_direct_video_revalidates_current_workspace_before_generate(
    api_modules, monkeypatch, tmp_path, mutation, expected_error,
):
    import asyncio

    from fastapi import BackgroundTasks
    from routers.generation import generate_from_video
    from schemas.generation import GenerateFromVideoRequest
    import services.generator_registry as registry_module

    _select_video_model(api_modules)
    captured = _capture_video_generation(api_modules, monkeypatch)
    workspace = api_modules["workspace_dir"]
    video_path = workspace / "Inputs" / "queued.capture"
    video_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"accepted-video")
    background = BackgroundTasks()
    response = asyncio.run(generate_from_video(
        GenerateFromVideoRequest(
            video_path="Inputs/queued.capture", model_id=api_modules["valid_model_id"],
            collection="VideoRuns", params={"quality": "draft"},
        ),
        background,
    ))
    jobs = api_modules["generation_jobs"]
    assert jobs.get_job_status(response["job_id"]).status == "pending"
    assert background.tasks[0].args[1] == video_path.resolve()
    assert captured == []

    outside = tmp_path / "outside"
    outside.mkdir()
    outside_file = outside / "queued.capture"
    outside_file.write_bytes(b"external-video")
    if mutation == "escape-file":
        video_path.unlink()
        video_path.symlink_to(outside_file)
    elif mutation == "escape-parent":
        video_path.unlink()
        video_path.parent.rmdir()
        video_path.parent.symlink_to(outside, target_is_directory=True)
    elif mutation == "deleted":
        video_path.unlink()
    elif mutation == "directory":
        video_path.unlink()
        video_path.mkdir()
    else:
        relocated = tmp_path / "relocated-workspace"
        relocated.mkdir()
        monkeypatch.setattr(registry_module, "WORKSPACE_DIR", relocated)

    asyncio.run(background())

    status = jobs.get_job_status(response["job_id"])
    assert status.status == "error"
    assert expected_error in status.error
    assert captured == []
    assert outside_file.read_bytes() == b"external-video"
    assert status.output_url is None
    assert status.scene_candidate is None


def test_queued_direct_video_keeps_valid_capture_path_params_and_output_semantics(api_modules, monkeypatch):
    import asyncio

    from fastapi import BackgroundTasks
    from routers.generation import generate_from_video
    from schemas.generation import GenerateFromVideoRequest

    _select_video_model(api_modules)
    captured = _capture_video_generation(api_modules, monkeypatch)
    video_path = api_modules["workspace_dir"] / "Inputs" / "valid.capture"
    video_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"accepted-video")
    background = BackgroundTasks()
    response = asyncio.run(generate_from_video(
        GenerateFromVideoRequest(
            video_path="Inputs/valid.capture", model_id=api_modules["valid_model_id"],
            collection="VideoRuns", params={"quality": "draft", "filename": "valid.glb"},
        ),
        background,
    ))
    assert captured == []
    asyncio.run(background())
    status = api_modules["generation_jobs"].get_job_status(response["job_id"])
    assert status.status == "done"
    assert status.output_kind == "mesh"
    assert status.output_url == "/workspace/VideoRuns/valid.glb"
    assert len(captured) == 1
    assert captured[0]["generation_input"] == video_path.resolve()
    assert captured[0]["exists_during_generate"] is True
    assert captured[0]["params"] == {
        "remesh": "quad", "enable_texture": False, "texture_resolution": 1024,
        "quality": "draft", "filename": "valid.glb",
    }
    assert video_path.read_bytes() == b"accepted-video"

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


def test_registry_allows_model_image_to_video_output_but_rejects_video_input_arrays():
    from services.generator_registry import validate_model_node_video_shape

    validate_model_node_video_shape(
        {"id": "image-to-video", "input": "image", "output": "video"},
        context='model node "image-to-video"',
    )

    try:
        validate_model_node_video_shape(
            {"id": "video-array", "input": "video", "inputs": ["video"], "output": "mesh"},
            context='model node "video-array"',
        )
    except ValueError as exc:
        assert "single input field" in str(exc)
    else:
        raise AssertionError("video input arrays must remain rejected")

    for node in (
        {"id": "video-object-array", "input": "video", "inputs": [{"name": "clip", "type": "video"}], "output": "mesh"},
        {"id": "named-video-input", "input": "image", "inputs": [{"name": "clip", "type": "video"}], "output": "mesh"},
    ):
        try:
            validate_model_node_video_shape(node, context=f'model node "{node["id"]}"')
        except ValueError as exc:
            assert "single input field" in str(exc)
        else:
            raise AssertionError("object-shaped video inputs must remain rejected")

