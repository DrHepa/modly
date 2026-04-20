import asyncio
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


def test_generation_jobs_preserve_running_status_and_cancel_parity_for_image_and_text(api_modules, monkeypatch):
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
    monkeypatch.setattr(generator_registry, "_generators", {api_modules["valid_model_id"]: blocking_generator}, raising=False)
    monkeypatch.setattr(generator_registry, "_active_id", api_modules["valid_model_id"], raising=False)

    from fastapi import BackgroundTasks

    async def exercise_both_flows():
        for is_text in (False, True):
            background = BackgroundTasks()
            kwargs = {"model_id": api_modules["valid_model_id"]}
            job = (generation_jobs.create_from_text_job(background, "Create a small marble bust", {}, **kwargs)
                   if is_text else generation_jobs.create_from_image_job(background, b"png-bytes", {}, **kwargs))
            task = asyncio.create_task(background())
            queued_task = None
            queued = None
            try:
                deadline = time.monotonic() + 1
                while len(blocking_generator.calls) < (2 if is_text else 1):
                    assert time.monotonic() < deadline
                    await asyncio.sleep(0.005)
                assert job.status == "running" and job.progress == 30
                assert job.step == "Preparing mesh"
                call = blocking_generator.calls[-1]
                if is_text:
                    assert call["image_bytes"].startswith(b"\x89PNG")
                    assert call["params"]["prompt"] == call["params"]["text"] == "Create a small marble bust"
                else:
                    assert call["image_bytes"] == b"png-bytes"
                    assert "prompt" not in call["params"]
                queued_background = BackgroundTasks()
                queued = generation_jobs.create_from_text_job(queued_background, "queued", {}, **kwargs)
                queued_task = asyncio.create_task(queued_background())
                await asyncio.sleep(0.01)
                assert queued.status == "pending"
                generation_jobs.cancel_job(queued.job_id)
                assert job.status == "running"
            finally:
                if queued is not None:
                    generation_jobs.cancel_job(queued.job_id)
                generation_jobs.cancel_job(job.job_id)
                await asyncio.wait_for(task, 2)
                if queued_task is not None:
                    await asyncio.wait_for(queued_task, 2)
            assert queued.status == job.status == "cancelled"
            assert job.progress == 30
        assert len(blocking_generator.calls) == 2

    asyncio.run(exercise_both_flows())


def test_text_adapter_preserves_aliases_custom_params_and_current_workspace(client, api_modules, monkeypatch, tmp_path):
    import services.generator_registry as registry
    calls = []
    gen = api_modules["fake_generator"]
    original = gen.generate
    def capture(image_bytes, params, progress_cb=None, cancel_event=None):
        calls.append((image_bytes, dict(params)))
        return original(image_bytes, params, progress_cb, cancel_event)
    monkeypatch.setattr(gen, "generate", capture)
    relocated = tmp_path / "relocated"
    monkeypatch.setattr(registry, "WORKSPACE_DIR", relocated)
    response = client.post('/generate/from-text', json={
        'prompt': ' visible prompt ', 'model_id': api_modules['valid_model_id'], 'collection': '..',
        'params': {'seed': 0, 'enabled': False, 'prompt': '', 'text': '', 'custom': {'a': [1]}},
    })
    assert response.status_code == 200
    job = api_modules['generation_jobs'].get_job(response.json()['job_id'])
    assert job.status == 'done'
    assert gen.outputs_dir == relocated / 'Default'
    image, params = calls[0]
    assert image.startswith(b'\x89PNG')
    assert params['prompt'] == params['text'] == ''
    assert params['seed'] == 0 and params['enabled'] is False and params['custom'] == {'a': [1]}


def test_text_adapter_pins_model_variant_and_non_mesh_output(client, api_modules, monkeypatch):
    jobs = api_modules['generation_jobs']
    model_id = api_modules['valid_model_id']
    calls = []
    monkeypatch.setitem(jobs.generator_registry._manifests, model_id, {'name': 'Text Image', 'input': 'text', 'output': 'image'})
    monkeypatch.setattr(jobs.generator_registry, 'assert_weight_variant_installed', lambda params, model_id=None: calls.append((model_id, params.get('variant'))))
    response = client.post('/generate/from-text', json={'prompt': 'test', 'model_id': model_id, 'params': {'variant': 'selected', 'filename': 'result.png'}})
    assert response.status_code == 200
    job = jobs.get_job(response.json()['job_id'])
    assert job.status == 'done' and job.scene_candidate is None
    assert calls == [(model_id, 'selected')]
