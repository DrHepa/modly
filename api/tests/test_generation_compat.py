import asyncio
import inspect
import logging
import sys
import threading
import time

import pytest


@pytest.fixture(autouse=True)
def reset_progress_snapshots(api_modules):
    jobs = api_modules["generation_jobs"]
    with jobs._log_lock:
        jobs._last_logged_snapshots.clear()
    yield
    with jobs._log_lock:
        jobs._last_logged_snapshots.clear()


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

            assert cancel_event is not None and cancel_event.wait(3), "cancellation deadline exceeded"
            # A late extension callback must not change/log another terminal snapshot.
            if progress_cb:
                progress_cb(90, "Late callback after cancellation")
            raise GenerationCancelled()

    generation_jobs = api_modules["generation_jobs"]
    blocking_generator = BlockingGenerator(api_modules["workspace_dir"])
    caplog.set_level(logging.INFO, logger="modly.generation.jobs")
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
            assert job.step == "Preparing mesh"
            messages = [record.getMessage() for record in caplog.records if record.name == "modly.generation.jobs"]
            for cancelled_job in (job, queued):
                terminals = [message for message in messages if f"job_id={cancelled_job.job_id} status=cancelled " in message]
                assert len(terminals) == 1
            assert any(f"job_id={queued.job_id} status=pending progress=0 step_changed=True" in message for message in messages)
        assert len(blocking_generator.calls) == 2

    asyncio.run(asyncio.wait_for(exercise_both_flows(), 8))


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
    job.step = "Writing mesh"
    assert generation_jobs._log_job_progress(job) is True
    assert generation_jobs._log_job_progress(job) is False
    job.status = "done"
    assert generation_jobs._log_job_progress(job) is True

    messages = [record.getMessage() for record in caplog.records if record.name == "modly.generation.jobs"]

    assert messages == [
        f"generation job progress job_id={job.job_id} status=running progress=10 step_changed=True",
        f"generation job progress job_id={job.job_id} status=running progress=40 step_changed=False",
        f"generation job progress job_id={job.job_id} status=running progress=40 step_changed=True",
        f"generation job progress job_id={job.job_id} status=done progress=40 step_changed=False",
    ]
    assert all("prompt" not in message for message in messages)
    assert all("filename" not in message for message in messages)
    assert all("output_url" not in message for message in messages)


def test_run_generation_logs_progress_done_and_error_without_changing_contracts_or_leaking_payloads(api_modules, caplog, capsys):
    from fastapi import BackgroundTasks

    generation_jobs = api_modules["generation_jobs"]
    fake_generator = api_modules["fake_generator"]
    fake_generator._loaded = True

    caplog.set_level(logging.INFO, logger="modly.generation.jobs")

    async def exercise_success_and_error():
        background = BackgroundTasks()
        success_job = generation_jobs.create_from_text_job(
            background,
            prompt="secret prompt must not leak",
            params={"filename": "secret-output.glb"},
            collection="Legacy",
            model_id=api_modules["valid_model_id"],
        )
        await asyncio.wait_for(background(), 2)

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
        await asyncio.wait_for(generation_jobs._run_generation(
            error_job.job_id,
            model_input=b"secret-image-bytes",
            params={"filename": "error-output.glb"},
            collection="Legacy",
            model_id=api_modules["valid_model_id"],
        ), 2)

        error_status = generation_jobs.get_job_status(error_job.job_id)
        assert error_status.status == "error"
        assert error_status.progress == 0
        assert "sensitive failure detail" in error_status.error
        assert "Traceback" in error_status.error
        assert not generation_jobs._log_job_progress(success_job)
        assert not generation_jobs._log_job_progress(error_job)

    asyncio.run(asyncio.wait_for(exercise_success_and_error(), 5))

    messages = [record.getMessage() for record in caplog.records if record.name == "modly.generation.jobs"]

    assert any("status=running progress=40 step_changed=True" in message for message in messages)
    assert any("status=running progress=85 step_changed=True" in message for message in messages)
    assert sum("status=done progress=100 step_changed=False" in message for message in messages) == 1
    assert sum("status=error progress=0 step_changed=False" in message for message in messages) == 1
    assert not any("secret prompt" in message for message in messages)
    assert not any("secret-output.glb" in message for message in messages)
    assert not any("secret-image-bytes" in message for message in messages)
    assert not any("sensitive failure detail" in message for message in messages)
    assert not any("Traceback" in message for message in messages)

    captured = capsys.readouterr()
    terminal_output = captured.out + captured.err
    assert "sensitive failure detail" not in terminal_output
    assert "Traceback" not in terminal_output


def test_generation_logs_step_changes_without_emitting_extension_text(api_modules, monkeypatch, caplog, capsys):
    jobs = api_modules["generation_jobs"]
    gen = api_modules["fake_generator"]
    gen._loaded = True
    first_step = "secret prompt /private/input.png\nFORGED LOG ENTRY"
    final_step = "secret output /private/result.glb\nRuntimeError: sensitive detail"

    def generate(image_bytes, params, progress_cb, cancel_event=None):
        progress_cb(40, first_step)
        progress_cb(40, first_step)
        progress_cb(40, final_step)
        progress_cb(20, final_step)
        output = gen.outputs_dir / "result.glb"
        output.write_bytes(b"mesh")
        return output

    monkeypatch.setattr(gen, "generate", generate)
    caplog.set_level(logging.INFO, logger="modly.generation.jobs")
    job = jobs.create_job()
    asyncio.run(asyncio.wait_for(jobs._run_generation(job.job_id, b"image", {}), 2))
    assert job.status == "done" and job.step == final_step
    assert jobs._last_logged_snapshots[job.job_id] == ("done", 100, final_step)
    records = [record for record in caplog.records if record.name == "modly.generation.jobs"]
    messages = [record.getMessage() for record in records]
    assert len(messages) == 4  # running, first step, changed step, done
    assert sum("progress=40 step_changed=True" in message for message in messages) == 2
    assert not any("progress=20" in message for message in messages)
    captured = capsys.readouterr()
    emitted = "\n".join(messages) + repr([record.args for record in records]) + captured.out + captured.err
    for secret in ("secret prompt", "/private/", "FORGED LOG ENTRY", "sensitive detail"):
        assert secret not in emitted
    assert all("\n" not in message for message in messages)


def test_concurrent_progress_logging_deduplicates_one_snapshot(api_modules, caplog):
    jobs = api_modules["generation_jobs"]
    job = jobs.create_job()
    job.status = "running"
    job.step = "Preparing mesh"
    caplog.set_level(logging.INFO, logger="modly.generation.jobs")
    ready = threading.Barrier(8, timeout=2)
    results = []

    def log_snapshot():
        ready.wait()
        results.append(jobs._log_job_progress(job))

    threads = [threading.Thread(target=log_snapshot, daemon=True) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=3)
        assert not thread.is_alive()
    assert len(results) == 8 and sum(results) == 1
    assert sum(record.name == "modly.generation.jobs" for record in caplog.records) == 1


@pytest.mark.parametrize("terminal", ["done", "error", "cancelled"])
def test_progress_snapshot_is_purged_with_terminal_job(api_modules, terminal):
    jobs = api_modules["generation_jobs"]
    stale = jobs.create_job()
    if terminal == "cancelled":
        jobs.cancel_job(stale.job_id)
    else:
        api_modules["fake_generator"]._loaded = True
        if terminal == "error":
            api_modules["fake_generator"].fail_with = RuntimeError("fixture failure")
        asyncio.run(asyncio.wait_for(jobs._run_generation(stale.job_id, b"image", {}), 2))
    assert stale.status == terminal
    assert stale.job_id in jobs._last_logged_snapshots
    retained = jobs.create_job()
    jobs.cancel_job(retained.job_id)
    jobs._completed_at[stale.job_id] = time.monotonic() - jobs._JOB_TTL - 1
    fresh = jobs.create_job()
    for store in (jobs._jobs, jobs._cancelled, jobs._cancel_events, jobs._completed_at,
                  jobs._job_generators, jobs._last_logged_snapshots):
        assert stale.job_id not in store
    assert retained.job_id in jobs._last_logged_snapshots
    assert fresh.job_id in jobs._jobs


@pytest.mark.parametrize("cancel_queued", [False, True])
def test_async_task_cancellation_logs_one_terminal_snapshot(api_modules, monkeypatch, caplog, cancel_queued):
    from services.generators.base import GenerationCancelled

    jobs = api_modules["generation_jobs"]
    gen = api_modules["fake_generator"]
    gen._loaded = True
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def generate(image_bytes, params, progress_cb, cancel_event=None):
        calls.append(image_bytes)
        progress_cb(30, "Preparing mesh")
        entered.set()
        assert release.wait(3), "test did not release generator"
        if cancel_event.is_set():
            progress_cb(90, "Late cancelled progress")
            raise GenerationCancelled()
        output = gen.outputs_dir / "result.glb"
        output.write_bytes(b"mesh")
        return output

    monkeypatch.setattr(gen, "generate", generate)
    caplog.set_level(logging.INFO, logger="modly.generation.jobs")

    async def scenario():
        active = jobs.create_job()
        tasks = [asyncio.create_task(jobs._run_generation(
            active.job_id, b"active", {}, model_id=api_modules["valid_model_id"],
        ))]
        target = active
        try:
            deadline = time.monotonic() + 1
            while not entered.is_set():
                assert time.monotonic() < deadline
                await asyncio.sleep(0.005)
            if cancel_queued:
                target = jobs.create_job()
                tasks.append(asyncio.create_task(jobs._run_generation(
                    target.job_id, b"queued", {}, model_id=api_modules["valid_model_id"],
                )))
                deadline = time.monotonic() + 1
                while target.step is None:
                    assert time.monotonic() < deadline
                    await asyncio.sleep(0.005)
                assert target.status == "pending"
            tasks[-1].cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(tasks[-1], 1)
            assert target.status == "cancelled"
            assert jobs._cancel_events[target.job_id].is_set()
            if cancel_queued:
                assert active.status == "running"
        finally:
            release.set()
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), 2)
            # Drain the single worker: the cancelled asyncio Future may finish
            # before its already-running synchronous generation has unwound.
            await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(
                jobs._pinned_generation_executor, lambda: None,
            ), 2)
        jobs.cancel_job(target.job_id)
        assert not jobs._log_job_progress(target)
        assert target.progress == (0 if cancel_queued else 30)
        assert target.job_id in jobs._completed_at
        assert target.job_id not in jobs._job_generators
        assert calls == [b"active"]
        messages = [record.getMessage() for record in caplog.records if record.name == "modly.generation.jobs"]
        assert sum(f"job_id={target.job_id} status=cancelled " in message for message in messages) == 1

    asyncio.run(asyncio.wait_for(scenario(), 7))


def test_inflight_progress_callback_cannot_mutate_cancelled_job(api_modules, monkeypatch, caplog):
    from services.generators.base import GenerationCancelled

    jobs = api_modules["generation_jobs"]
    gen = api_modules["fake_generator"]
    gen._loaded = True
    entered = threading.Event()
    release = threading.Event()
    errors = []
    lines, first = inspect.getsourcelines(jobs._run_generation_impl)
    comparison_line = first + next(i for i, line in enumerate(lines) if "if pct > job.progress:" in line)

    def trace(frame, event, arg):
        if (event == "line" and frame.f_code.co_filename == jobs.__file__
                and frame.f_code.co_name == "progress_cb" and frame.f_lineno == comparison_line
                and frame.f_locals.get("pct") == 90):
            entered.set()
            assert release.wait(3), "test did not release in-flight progress"
        return trace

    def generate(image_bytes, params, progress_cb, cancel_event=None):
        progress_cb(30, "Preparing mesh")
        progress_cb(90, "Finishing mesh")
        raise GenerationCancelled()

    def run():
        sys.settrace(trace)
        try:
            jobs._run_generation_impl(job.job_id, b"image", {}, "Default", "mesh", api_modules["valid_model_id"])
        except BaseException as exc:
            errors.append(repr(exc))
        finally:
            sys.settrace(None)

    monkeypatch.setattr(gen, "generate", generate)
    caplog.set_level(logging.INFO, logger="modly.generation.jobs")
    job = jobs.create_job()
    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        assert entered.wait(2), "callback did not reach progress comparison"
        assert job.progress == 30
        jobs.cancel_job(job.job_id)
        cancelled_at = jobs._completed_at[job.job_id]
        assert job.status == "cancelled"
    finally:
        release.set()
        thread.join(3)
    assert not thread.is_alive() and not errors
    assert job.progress == 30 and job.step == "Preparing mesh"
    assert jobs._completed_at[job.job_id] == cancelled_at
    messages = [record.getMessage() for record in caplog.records if record.name == "modly.generation.jobs"]
    assert sum(f"job_id={job.job_id} status=cancelled " in message for message in messages) == 1


@pytest.mark.parametrize("outcome", ["cancelled", "error", "done"])
def test_late_worker_cannot_recreate_retired_job_state(api_modules, monkeypatch, caplog, outcome):
    from services.generators.base import GenerationCancelled

    jobs = api_modules["generation_jobs"]
    gen = api_modules["fake_generator"]
    gen._loaded = True
    entered = threading.Event()
    release = threading.Event()
    errors = []

    def generate(image_bytes, params, progress_cb, cancel_event=None):
        progress_cb(30, "Preparing mesh")
        entered.set()
        assert release.wait(3), "test did not release retired worker"
        progress_cb(90, "Late progress after retirement")
        if outcome == "cancelled":
            raise GenerationCancelled()
        if outcome == "error":
            raise RuntimeError("Late worker failure")
        output = gen.outputs_dir / "result.glb"
        output.write_bytes(b"mesh")
        return output

    def run():
        try:
            jobs._run_generation_impl(job.job_id, b"image", {}, "Default", "mesh", api_modules["valid_model_id"])
        except BaseException as exc:
            errors.append(repr(exc))

    monkeypatch.setattr(gen, "generate", generate)
    caplog.set_level(logging.INFO, logger="modly.generation.jobs")
    job = jobs.create_job()
    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        assert entered.wait(2), "generator did not start"
        jobs.cancel_job(job.job_id)
        jobs._completed_at[job.job_id] = time.monotonic() - jobs._JOB_TTL - 1
        fresh = jobs.create_job()
        assert job.job_id not in jobs._jobs
        assert job.job_id not in jobs._last_logged_snapshots
    finally:
        release.set()
        thread.join(3)
    assert not thread.is_alive() and not errors
    assert not jobs._log_job_progress(job)
    assert job.status == "cancelled" and job.progress == 30 and job.step == "Preparing mesh"
    assert job.error is None and job.output_url is None
    for store in (jobs._jobs, jobs._cancelled, jobs._cancel_events, jobs._completed_at,
                  jobs._job_generators, jobs._last_logged_snapshots):
        assert job.job_id not in store
    assert jobs._jobs[fresh.job_id] is fresh
    messages = [record.getMessage() for record in caplog.records if record.name == "modly.generation.jobs"]
    assert sum(f"job_id={job.job_id} status=cancelled " in message for message in messages) == 1
