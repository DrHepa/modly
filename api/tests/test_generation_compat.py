import asyncio
import logging
import time


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
    assert "Traceback" not in terminal_output
