import asyncio
import logging
import time
import json


def assert_backend_ready(client) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_generate_routes_remain_backward_compatible(client, api_modules, image_upload):
    assert_backend_ready(client)

    create_response = client.post(
        "/generate/from-image",
        files={"image": image_upload},
        data={
            "model_id": api_modules["valid_model_id"],
            "collection": "Legacy",
            "remesh": "quad",
            "enable_texture": "false",
            "texture_resolution": "1024",
            "params": '{"filename": "legacy-output.glb"}',
        },
    )

    assert create_response.status_code == 200
    create_body = create_response.json()
    assert create_body["job_id"]

    status_response = client.get(f"/generate/status/{create_body['job_id']}")

    assert status_response.status_code == 200
    status_body = status_response.json()
    assert status_body["job_id"] == create_body["job_id"]
    assert status_body["status"] == "done"
    assert status_body["output_url"] == "/workspace/Legacy/legacy-output.glb"

    cancel_response = client.post(f"/generate/cancel/{create_body['job_id']}")

    assert cancel_response.status_code == 200
    assert cancel_response.json() == {"cancelled": True}


def test_generate_from_text_creates_job_with_status_and_cancel_parity(client, api_modules):
    assert_backend_ready(client)

    create_response = client.post(
        "/generate/from-text",
        json={
            "prompt": "Create a small marble bust",
            "model_id": api_modules["valid_model_id"],
            "collection": "Legacy",
            "remesh": "quad",
            "enable_texture": False,
            "texture_resolution": 1024,
            "params": {"filename": "legacy-text-output.glb"},
        },
    )

    assert create_response.status_code == 200
    create_body = create_response.json()
    assert create_body["job_id"]

    status_response = client.get(f"/generate/status/{create_body['job_id']}")

    assert status_response.status_code == 200
    status_body = status_response.json()
    assert status_body["job_id"] == create_body["job_id"]
    assert status_body["status"] == "done"
    assert status_body["output_url"] == "/workspace/Legacy/legacy-text-output.glb"

    cancel_response = client.post(f"/generate/cancel/{create_body['job_id']}")

    assert cancel_response.status_code == 200
    assert cancel_response.json() == {"cancelled": True}


def test_generate_from_text_rejects_missing_or_blank_prompt_without_creating_job(client, api_modules):
    assert_backend_ready(client)

    missing_prompt_response = client.post(
        "/generate/from-text",
        json={
            "model_id": api_modules["valid_model_id"],
            "collection": "Legacy",
        },
    )

    assert missing_prompt_response.status_code == 422
    assert api_modules["generation_jobs"]._jobs == {}

    blank_prompt_response = client.post(
        "/generate/from-text",
        json={
            "prompt": "   ",
            "model_id": api_modules["valid_model_id"],
            "collection": "Legacy",
        },
    )

    assert blank_prompt_response.status_code == 400
    assert api_modules["generation_jobs"]._jobs == {}


def test_generate_from_none_requires_none_model_and_passes_exact_empty_bytes(
    client,
    api_modules,
    monkeypatch,
):
    assert_backend_ready(client)
    from services.generator_registry import generator_registry

    generator_registry._manifests[api_modules["valid_model_id"]]["input"] = "none"
    captured: dict[str, object] = {}
    original_generate = api_modules["fake_generator"].generate

    def capture_generate(
        image_bytes: bytes,
        params: dict,
        progress_cb=None,
        cancel_event=None,
    ):
        captured["image_bytes"] = image_bytes
        captured["params"] = dict(params)
        return original_generate(
            image_bytes,
            params,
            progress_cb,
            cancel_event,
        )

    monkeypatch.setattr(
        api_modules["fake_generator"],
        "generate",
        capture_generate,
    )

    response = client.post(
        "/generate/from-none",
        json={
            "model_id": api_modules["valid_model_id"],
            "collection": "NoneRuns",
            "remesh": "none",
            "enable_texture": False,
            "texture_resolution": 1024,
            "params": {
                "seed": 7,
                "filename": "none-output.glb",
            },
        },
    )

    assert response.status_code == 200
    status_response = client.get(
        f"/generate/status/{response.json()['job_id']}"
    )
    assert status_response.status_code == 200
    assert status_response.json()["status"] == "done"
    assert captured == {
        "image_bytes": b"",
        "params": {
            "remesh": "none",
            "enable_texture": False,
            "texture_resolution": 1024,
            "seed": 7,
            "filename": "none-output.glb",
        },
    }


def test_generate_from_none_rejects_non_none_model_without_creating_job(
    client,
    api_modules,
):
    assert_backend_ready(client)

    response = client.post(
        "/generate/from-none",
        json={
            "model_id": api_modules["valid_model_id"],
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Model 'demo/fake' expects input 'image' but this endpoint received 'none'."
    assert api_modules["generation_jobs"]._jobs == {}


def test_generate_routes_enforce_declared_model_input_symmetrically(client, api_modules, image_upload):
    assert_backend_ready(client)
    from services.generator_registry import generator_registry

    generator_registry._manifests[api_modules["valid_model_id"]]["input"] = "image"

    image_response = client.post(
        "/generate/from-image",
        files={"image": image_upload},
        data={"model_id": api_modules["valid_model_id"]},
    )
    assert image_response.status_code == 200

    text_mismatch = client.post(
        "/generate/from-text",
        json={"prompt": "hello", "model_id": api_modules["valid_model_id"]},
    )
    assert text_mismatch.status_code == 400
    assert text_mismatch.json()["detail"] == "Model 'demo/fake' expects input 'image' but this endpoint received 'text'."

    generator_registry._manifests[api_modules["valid_model_id"]]["input"] = "text"
    text_response = client.post(
        "/generate/from-text",
        json={"prompt": "hello", "model_id": api_modules["valid_model_id"]},
    )
    assert text_response.status_code == 200

    image_mismatch = client.post(
        "/generate/from-image",
        files={"image": image_upload},
        data={"model_id": api_modules["valid_model_id"]},
    )
    assert image_mismatch.status_code == 400
    assert image_mismatch.json()["detail"] == "Model 'demo/fake' expects input 'text' but this endpoint received 'image'."

    generator_registry._manifests[api_modules["valid_model_id"]]["input"] = "scene"
    scene_manifest = api_modules["workspace_dir"] / "Worlds" / "hero.scene.json"
    scene_manifest.parent.mkdir(parents=True, exist_ok=True)
    scene_manifest.write_text(json.dumps({
        "schema": "modly.scene-manifest.v1",
        "sceneRoot": "Worlds/hero",
        "assets": [],
    }), encoding="utf-8")

    scene_response = client.post(
        "/generate/from-scene",
        json={"scene_path": "Worlds/hero.scene.json", "model_id": api_modules["valid_model_id"]},
    )
    assert scene_response.status_code == 200

    none_mismatch = client.post(
        "/generate/from-none",
        json={"model_id": api_modules["valid_model_id"]},
    )
    assert none_mismatch.status_code == 400
    assert none_mismatch.json()["detail"] == "Model 'demo/fake' expects input 'scene' but this endpoint received 'none'."


def test_generate_from_image_accepts_legacy_missing_input_metadata(client, api_modules, image_upload):
    assert_backend_ready(client)
    from services.generator_registry import generator_registry

    generator_registry._manifests[api_modules["valid_model_id"]].pop("input", None)

    response = client.post(
        "/generate/from-image",
        files={"image": image_upload},
        data={"model_id": api_modules["valid_model_id"]},
    )

    assert response.status_code == 200


def test_generate_routes_reject_blank_model_id_before_job_creation(client, api_modules, image_upload):
    assert_backend_ready(client)

    image_response = client.post(
        "/generate/from-image",
        files={"image": image_upload},
        data={"model_id": "   "},
    )
    assert image_response.status_code == 400
    assert image_response.json()["detail"] == "model_id is required"

    none_response = client.post(
        "/generate/from-none",
        json={"model_id": "   "},
    )
    assert none_response.status_code == 400
    assert none_response.json()["detail"] == "model_id is required"
    assert api_modules["generation_jobs"]._jobs == {}


def test_generate_from_scene_validates_workspace_relative_scene_manifest_and_creates_job(client, api_modules, monkeypatch):
    assert_backend_ready(client)

    scene_manifest = api_modules["workspace_dir"] / "Worlds" / "hero.scene.json"
    scene_manifest.parent.mkdir(parents=True)
    scene_manifest.write_text(
        json.dumps(
            {
                "schema": "modly.scene-manifest.v1",
                "sceneRoot": "Worlds/hero",
                "assets": [],
            }
        ),
        encoding="utf-8",
    )

    captured: dict[str, object] = {}
    original_generate = api_modules["fake_generator"].generate

    def capture_generate(image_bytes: bytes, params: dict, progress_cb=None, cancel_event=None):
        captured["image_bytes"] = image_bytes
        captured["params"] = dict(params)
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(api_modules["fake_generator"], "generate", capture_generate)

    create_response = client.post(
        "/generate/from-scene",
        json={
            "scene_path": "Worlds/hero.scene.json",
            "model_id": api_modules["valid_model_id"],
            "collection": "SceneRuns",
            "remesh": "none",
            "enable_texture": False,
            "texture_resolution": 2048,
            "params": {"steps": 12, "filename": "hero-scene.glb"},
        },
    )

    assert create_response.status_code == 200
    create_body = create_response.json()
    assert create_body["job_id"]

    status_response = client.get(f"/generate/status/{create_body['job_id']}")

    assert status_response.status_code == 200
    assert status_response.json()["output_url"] == "/workspace/SceneRuns/hero-scene.glb"
    assert captured == {
        "image_bytes": b"",
        "params": {
            "remesh": "none",
            "enable_texture": False,
            "texture_resolution": 2048,
            "steps": 12,
            "filename": "hero-scene.glb",
            "scene_manifest_path": str(scene_manifest.resolve()),
            "scene_path": "Worlds/hero.scene.json",
            "input_scene_path": "Worlds/hero.scene.json",
        },
    }


def test_generate_from_scene_rejects_absolute_traversal_and_invalid_manifest_paths(client, api_modules):
    assert_backend_ready(client)

    absolute_response = client.post(
        "/generate/from-scene",
        json={
            "scene_path": "/tmp/hero.scene.json",
            "model_id": api_modules["valid_model_id"],
        },
    )
    assert absolute_response.status_code == 400
    assert absolute_response.json()["detail"] == "scene_path must be workspace-relative"

    traversal_response = client.post(
        "/generate/from-scene",
        json={
            "scene_path": "../hero.scene.json",
            "model_id": api_modules["valid_model_id"],
        },
    )
    assert traversal_response.status_code == 400
    assert traversal_response.json()["detail"] == "scene_path must not traverse outside the workspace"

    missing_response = client.post(
        "/generate/from-scene",
        json={
            "scene_path": "Worlds/missing.scene.json",
            "model_id": api_modules["valid_model_id"],
        },
    )
    assert missing_response.status_code == 404
    assert missing_response.json()["detail"] == "scene_path was not found in the workspace"

    invalid_scene_manifest = api_modules["workspace_dir"] / "Worlds" / "invalid.scene.json"
    invalid_scene_manifest.parent.mkdir(parents=True)
    invalid_scene_manifest.write_text(
        json.dumps(
            {
                "schema": "modly.scene-manifest.v0",
                "sceneRoot": "",
                "assets": [],
            }
        ),
        encoding="utf-8",
    )

    invalid_response = client.post(
        "/generate/from-scene",
        json={
            "scene_path": "Worlds/invalid.scene.json",
            "model_id": api_modules["valid_model_id"],
        },
    )
    assert invalid_response.status_code == 400
    assert invalid_response.json()["detail"] == "scene manifest schema must be modly.scene-manifest.v1"
    assert api_modules["generation_jobs"]._jobs == {}


def test_build_scene_candidate_detects_scene_manifest_outputs(api_modules):
    generation_jobs = api_modules["generation_jobs"]
    scene_manifest = api_modules["workspace_dir"] / "Worlds" / "hero.scene.json"
    scene_manifest.parent.mkdir(parents=True)
    scene_manifest.write_text(
        json.dumps(
            {
                "schema": "modly.scene-manifest.v1",
                "sceneRoot": "Worlds/hero",
                "preview": {"image": "Worlds/hero/panorama.png"},
                "assets": [],
            }
        ),
        encoding="utf-8",
    )

    candidate = generation_jobs.build_scene_candidate(scene_manifest)

    assert candidate is not None
    assert candidate.model_dump() == {
        "kind": "scene",
        "workspace_path": "Worlds/hero.scene.json",
        "output_url": "/workspace/Worlds/hero.scene.json",
        "display_name": "hero.scene.json",
    }


def test_build_scene_candidate_keeps_mesh_outputs_as_mesh(api_modules):
    generation_jobs = api_modules["generation_jobs"]
    mesh_output = api_modules["workspace_dir"] / "Meshes" / "hero.glb"
    mesh_output.parent.mkdir(parents=True)
    mesh_output.write_bytes(b"glb")

    candidate = generation_jobs.build_scene_candidate(mesh_output)

    assert candidate is not None
    assert candidate.model_dump() == {
        "kind": "mesh",
        "workspace_path": "Meshes/hero.glb",
        "output_url": "/workspace/Meshes/hero.glb",
        "display_name": "hero.glb",
    }


def test_detect_output_kind_returns_none_for_unknown_outputs(api_modules):
    generation_jobs = api_modules["generation_jobs"]
    opaque_output = api_modules["workspace_dir"] / "Meshes" / "opaque.bin"
    opaque_output.parent.mkdir(parents=True, exist_ok=True)
    opaque_output.write_bytes(b"opaque")

    assert generation_jobs.detect_output_kind(opaque_output) is None


def test_detect_output_kind_classifies_common_image_audio_and_video_outputs(api_modules):
    generation_jobs = api_modules["generation_jobs"]
    workspace_dir = api_modules["workspace_dir"]

    image_output = workspace_dir / "Outputs" / "preview.PNG"
    image_output.parent.mkdir(parents=True, exist_ok=True)
    image_output.write_bytes(b"png")

    audio_output = workspace_dir / "Outputs" / "voice.wav"
    audio_output.write_bytes(b"wav")

    video_output = workspace_dir / "Outputs" / "turntable.webm"
    video_output.write_bytes(b"webm")

    assert generation_jobs.detect_output_kind(image_output) == "image"
    assert generation_jobs.detect_output_kind(audio_output) == "audio"
    assert generation_jobs.detect_output_kind(video_output) == "video"


def test_build_scene_candidate_preserves_image_output_kind(api_modules):
    generation_jobs = api_modules["generation_jobs"]
    image_output = api_modules["workspace_dir"] / "Renders" / "preview.webp"
    image_output.parent.mkdir(parents=True, exist_ok=True)
    image_output.write_bytes(b"webp")

    candidate = generation_jobs.build_scene_candidate(image_output)

    assert candidate is not None
    assert candidate.model_dump() == {
        "kind": "image",
        "workspace_path": "Renders/preview.webp",
        "output_url": "/workspace/Renders/preview.webp",
        "display_name": "preview.webp",
    }


def test_validate_model_input_normalizes_legacy_json_to_scene():
    from services.generator_registry import normalize_model_input, validate_model_input

    assert normalize_model_input("JSON") == "scene"
    assert validate_model_input("json", context="demo/fake.input") == "scene"

def test_generation_jobs_preserve_running_status_and_cancel_parity_for_image_and_text(api_modules, monkeypatch, caplog):
    from services.generator_registry import generator_registry
    from services.generators.base import GenerationCancelled

    class BlockingGenerator:
        DISPLAY_NAME = "Blocking Generator"
        VRAM_GB = 0

        def __init__(self, outputs_dir):
            self.outputs_dir = outputs_dir
            self._loaded = True
            self.calls = []

        def is_loaded(self) -> bool:
            return self._loaded

        def is_downloaded(self) -> bool:
            return True

        def load(self) -> None:
            self._loaded = True

        def unload(self) -> None:
            self._loaded = False

        def generate(self, image_bytes: bytes, params: dict, progress_cb=None, cancel_event=None):
            if progress_cb:
                progress_cb(30, "Preparing mesh")

            self.calls.append(
                {
                    "image_bytes": image_bytes,
                    "params": dict(params),
                }
            )

            while cancel_event is not None and not cancel_event.wait(0.01):
                pass

            raise GenerationCancelled()

    generation_jobs = api_modules["generation_jobs"]
    blocking_generator = BlockingGenerator(api_modules["workspace_dir"])
    caplog.set_level(logging.INFO, logger="modly.generation.jobs")
    monkeypatch.setattr(generator_registry, "_generators", {api_modules["valid_model_id"]: blocking_generator}, raising=False)
    monkeypatch.setattr(generator_registry, "_active_id", api_modules["valid_model_id"], raising=False)

    async def exercise_both_flows():
        image_job = generation_jobs.create_job()
        text_job = generation_jobs.create_job()

        image_task = asyncio.create_task(
            generation_jobs._run_generation(
                image_job.job_id,
                image_bytes=b"png-bytes",
                params={"filename": "image-output.glb"},
                collection="Legacy",
            )
        )
        text_task = asyncio.create_task(
            generation_jobs._run_generation(
                text_job.job_id,
                prompt="Create a small marble bust",
                params={"filename": "text-output.glb"},
                collection="Legacy",
            )
        )

        deadline = time.time() + 1
        while len(blocking_generator.calls) < 2 and time.time() < deadline:
            await asyncio.sleep(0.01)

        assert len(blocking_generator.calls) == 2

        image_status = generation_jobs.get_job_status(image_job.job_id)
        text_status = generation_jobs.get_job_status(text_job.job_id)

        assert image_status.status == "running"
        assert text_status.status == "running"
        assert image_status.progress == text_status.progress == 30
        assert image_status.step == text_status.step == "Preparing mesh"

        calls_by_filename = {call["params"]["filename"]: call for call in blocking_generator.calls}
        assert calls_by_filename["image-output.glb"]["image_bytes"] == b"png-bytes"
        assert "prompt" not in calls_by_filename["image-output.glb"]["params"]
        assert calls_by_filename["text-output.glb"]["image_bytes"] == b""
        assert calls_by_filename["text-output.glb"]["params"]["prompt"] == "Create a small marble bust"

        image_cancel = generation_jobs.cancel_job(image_job.job_id)
        text_cancel = generation_jobs.cancel_job(text_job.job_id)

        assert image_cancel.status == text_cancel.status == "cancelled"

        await asyncio.gather(image_task, text_task)

        final_image = generation_jobs.get_job_status(image_job.job_id)
        final_text = generation_jobs.get_job_status(text_job.job_id)

        assert final_image.status == "cancelled"
        assert final_text.status == "cancelled"
        assert final_image.progress == final_text.progress == 30
        assert final_image.step == final_text.step == "Preparing mesh"

        messages = [record.getMessage() for record in caplog.records if record.name == "modly.generation.jobs"]
        assert any(
            f"job_id={image_job.job_id} status=cancelled progress=30 step=Preparing mesh" in message
            for message in messages
        )
        assert any(
            f"job_id={text_job.job_id} status=cancelled progress=30 step=Preparing mesh" in message
            for message in messages
        )

    asyncio.run(exercise_both_flows())


def test_generation_job_progress_logging_uses_safe_fields_and_deduplicates_snapshots(api_modules, caplog):
    generation_jobs = api_modules["generation_jobs"]
    job = generation_jobs.create_job()

    caplog.set_level(logging.INFO, logger="modly.generation.jobs")

    job.status = "running"
    job.progress = 10
    job.step = "Preparing mesh"

    assert generation_jobs._log_job_progress(job) is True
    assert generation_jobs._log_job_progress(job) is False

    job.progress = 40
    assert generation_jobs._log_job_progress(job) is True

    messages = [record.getMessage() for record in caplog.records if record.name == "modly.generation.jobs"]

    assert messages == [
        f"generation job progress job_id={job.job_id} status=running progress=10 step=Preparing mesh",
        f"generation job progress job_id={job.job_id} status=running progress=40 step=Preparing mesh",
    ]
    assert all("prompt" not in message for message in messages)
    assert all("filename" not in message for message in messages)
    assert all("output_url" not in message for message in messages)


def test_run_generation_logs_progress_done_and_error_without_changing_contracts_or_leaking_payloads(api_modules, caplog, capsys):
    generation_jobs = api_modules["generation_jobs"]
    fake_generator = api_modules["fake_generator"]

    caplog.set_level(logging.INFO, logger="modly.generation.jobs")

    async def exercise_success_and_error():
        success_job = generation_jobs.create_job()
        await generation_jobs._run_generation(
            success_job.job_id,
            prompt="secret prompt must not leak",
            params={"filename": "secret-output.glb"},
            collection="Legacy",
        )

        assert generation_jobs.get_job_status(success_job.job_id).model_dump() == {
            "job_id": success_job.job_id,
            "status": "done",
            "progress": 100,
            "step": "Writing mesh",
            "output_url": "/workspace/Legacy/secret-output.glb",
            "output_kind": "mesh",
            "error": None,
            "scene_candidate": {
                "kind": "mesh",
                "workspace_path": "Legacy/secret-output.glb",
                "output_url": "/workspace/Legacy/secret-output.glb",
                "display_name": "secret-output.glb",
            },
        }

        fake_generator.fail_with = RuntimeError("sensitive failure detail")
        error_job = generation_jobs.create_job()
        await generation_jobs._run_generation(
            error_job.job_id,
            image_bytes=b"secret-image-bytes",
            params={"filename": "error-output.glb"},
            collection="Legacy",
        )

        error_status = generation_jobs.get_job_status(error_job.job_id)
        assert error_status.status == "error"
        assert error_status.progress == 0
        assert "sensitive failure detail" in error_status.error

    asyncio.run(exercise_success_and_error())

    messages = [record.getMessage() for record in caplog.records if record.name == "modly.generation.jobs"]

    assert any("status=running progress=40 step=Preparing mesh" in message for message in messages)
    assert any("status=running progress=85 step=Writing mesh" in message for message in messages)
    assert any("status=done progress=100 step=Writing mesh" in message for message in messages)
    assert any("status=error progress=0 step=None" in message for message in messages)
    assert not any("secret prompt" in message for message in messages)
    assert not any("secret-output.glb" in message for message in messages)
    assert not any("secret-image-bytes" in message for message in messages)
    assert not any("sensitive failure detail" in message for message in messages)
    assert not any("Traceback" in message for message in messages)

    captured = capsys.readouterr()
    terminal_output = captured.out + captured.err
    assert "sensitive failure detail" not in terminal_output


def test_run_generation_leaves_output_kind_empty_when_backend_cannot_determine_it(api_modules, monkeypatch):
    generation_jobs = api_modules["generation_jobs"]

    def generate_unknown_output(image_bytes: bytes, params: dict, progress_cb=None, cancel_event=None):
        output_path = api_modules["workspace_dir"] / "Legacy" / "opaque-output.bin"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"opaque")
        return output_path

    monkeypatch.setattr(api_modules["fake_generator"], "generate", generate_unknown_output)

    async def exercise_unknown_output_kind():
        job = generation_jobs.create_job()
        await generation_jobs._run_generation(job.job_id, image_bytes=b"png", params={}, collection="Legacy")
        status = generation_jobs.get_job_status(job.job_id)
        assert status.output_kind is None
        assert status.scene_candidate is not None
        assert status.scene_candidate.kind == "mesh"

    asyncio.run(exercise_unknown_output_kind())
    assert "Traceback" not in terminal_output
