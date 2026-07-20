import threading
import time
from pathlib import Path

from services.extension_process import (
    ExtensionProcess,
    _RUNTIME_READINESS_RESPONSE_TIMEOUT_SECONDS,
)


def _start_extension_process_with_ready_schema(monkeypatch, tmp_path, manifest, ready_schema):
    process = ExtensionProcess(tmp_path, manifest)
    python = tmp_path / "python"
    python.write_text("", encoding="utf-8")

    class FakePopen:
        pid = 123
        stdout = None
        stderr = None
        stdin = None

    class NoopThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            pass

    monkeypatch.setattr("services.extension_process._venv_python", lambda _ext_dir: python)
    monkeypatch.setattr("services.extension_process.subprocess.Popen", lambda *args, **kwargs: FakePopen())
    monkeypatch.setattr("services.extension_process.threading.Thread", NoopThread)
    monkeypatch.setattr(process, "_recv", lambda timeout=None: {
        "type": "ready",
        "params_schema": ready_schema,
    })

    process._start()
    return process


def test_extension_process_keeps_node_manifest_params_schema_over_generic_runner_schema(monkeypatch, tmp_path):
    scene_schema = [{"id": "mesh_footprint_ratio_threshold", "default": 12}]
    process = _start_extension_process_with_ready_schema(
        monkeypatch,
        tmp_path,
        {
            "id": "dreamcube/generate-scene",
            "params_schema": scene_schema,
        },
        [{"id": "output_format", "default": "equirect_rgb_png"}],
    )

    assert process.params_schema() == scene_schema


def test_extension_process_uses_runner_params_schema_when_manifest_omits_it(monkeypatch, tmp_path):
    runtime_schema = [{"id": "dynamic_option", "default": True}]
    process = _start_extension_process_with_ready_schema(
        monkeypatch,
        tmp_path,
        {"id": "legacy/generate"},
        runtime_schema,
    )

    assert process.params_schema() == runtime_schema


def test_extension_process_load_ignores_queued_runtime_readiness_before_loaded(monkeypatch, tmp_path):
    process = ExtensionProcess(tmp_path, {"id": "hunyuan3d-part/decompose-mesh"})
    sent: list[dict] = []
    responses = iter([
        {"type": "runtime_readiness", "status": {"ok": True, "machine_code": "ready"}},
        {"type": "loaded"},
    ])

    class RunningProc:
        def poll(self):
            return None

    process._proc = RunningProc()

    monkeypatch.setattr(process, "_ensure_started", lambda: None)
    monkeypatch.setattr(process, "_send", sent.append)
    monkeypatch.setattr(process, "_recv", lambda timeout=None: next(responses))

    process.load()

    assert sent == [{"action": "load"}]
    assert process.is_loaded() is True


def test_extension_process_load_ignores_stale_ready_before_loaded(monkeypatch, tmp_path):
    process = ExtensionProcess(tmp_path, {"id": "hy-world-2/worldnav"})
    sent: list[dict] = []
    responses = iter([
        {"type": "ready", "params_schema": []},
        {"type": "loaded"},
    ])

    class RunningProc:
        def poll(self):
            return None

    process._proc = RunningProc()

    monkeypatch.setattr(process, "_ensure_started", lambda: None)
    monkeypatch.setattr(process, "_send", sent.append)
    monkeypatch.setattr(process, "_recv", lambda timeout=None: next(responses))

    process.load()

    assert sent == [{"action": "load"}]
    assert process.is_loaded() is True


def test_extension_process_readiness_ignores_stale_loaded_before_runtime_readiness(monkeypatch, tmp_path):
    process = ExtensionProcess(tmp_path, {"id": "runtime-ext/text-to-image"})
    sent: list[dict] = []
    recv_timeouts: list[float | None] = []
    responses = iter([
        {"type": "loaded"},
        {"type": "runtime_readiness", "status": {"ok": True, "machine_code": "ready"}},
    ])

    class RunningProc:
        def poll(self):
            return None

    process._proc = RunningProc()

    monkeypatch.setattr(process, "_ensure_started", lambda: None)
    monkeypatch.setattr(process, "_send", sent.append)

    def fake_recv(timeout=None):
        recv_timeouts.append(timeout)
        return next(responses)

    monkeypatch.setattr(process, "_recv", fake_recv)

    status = process.readiness_status()

    assert sent == [{"action": "runtime_readiness"}]
    assert status == {"ok": True, "machine_code": "ready"}
    assert recv_timeouts[0] is not None
    assert _RUNTIME_READINESS_RESPONSE_TIMEOUT_SECONDS - 0.5 <= recv_timeouts[0] <= _RUNTIME_READINESS_RESPONSE_TIMEOUT_SECONDS


def test_extension_process_generate_ignores_stale_runtime_readiness_before_done(monkeypatch, tmp_path):
    process = ExtensionProcess(tmp_path, {"id": "runtime-ext/text-to-image"})
    sent: list[dict] = []
    recv_calls = 0

    class RunningProc:
        def poll(self):
            return None

    process._proc = RunningProc()

    monkeypatch.setattr(process, "_ensure_started", lambda: None)
    monkeypatch.setattr(process, "_send", sent.append)

    def fake_recv(timeout=None) -> dict:
        nonlocal recv_calls
        recv_calls += 1
        if recv_calls == 1:
            return {"type": "runtime_readiness", "status": {"ok": True, "machine_code": "ready"}}
        return {"type": "done", "id": sent[0]["id"], "output_path": str(tmp_path / "mesh.glb")}

    monkeypatch.setattr(process, "_recv", fake_recv)

    output_path = process.generate(b"image-bytes", {"filename": "mesh.glb"})

    assert sent[0]["action"] == "generate"
    assert output_path == Path(tmp_path / "mesh.glb")


def test_extension_process_propagates_https_plan_and_gates_readiness_before_start(
    monkeypatch,
    tmp_path,
):
    import hashlib

    from services.extension_process import ExtensionProcess

    payload = b"model"
    plan = [{
        "url": "https://assets.example.com/model.bin",
        "filename": "model.bin",
        "size_bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }]
    process = ExtensionProcess(
        tmp_path / "extension",
        {
            "id": "demo/generate",
            "name": "Demo",
            "input": "none",
            "https_downloads": plan,
        },
    )
    process.model_dir = tmp_path / "models" / "demo" / "generate"
    process.model_dir.mkdir(parents=True)

    def unexpected_start():
        raise AssertionError("asset readiness must not start the subprocess")

    monkeypatch.setattr(process, "_ensure_started", unexpected_start)

    assert process.model_id == "demo/generate"
    assert process.input == "none"
    assert process.https_downloads == plan
    assert process.is_downloaded() is False
    assert process.readiness_status() == {
        "ok": False,
        "machine_code": "assets_not_ready",
        "label_hint": "Install model assets",
        "reason": (
            "demo/generate requires its exact HTTPS asset plan. "
            "Install or repair the assets from the Models UI."
        ),
    }


def test_extension_process_serializes_readiness_and_load_requests(monkeypatch, tmp_path):
    process = ExtensionProcess(tmp_path, {"id": "hunyuan3d-part/decompose-mesh"})
    readiness_sent = threading.Event()
    allow_readiness_to_continue = threading.Event()
    readiness_done = threading.Event()
    load_sent = threading.Event()
    sent: list[dict] = []
    errors: list[BaseException] = []
    results: dict[str, dict] = {}

    class RunningProc:
        def poll(self):
            return None

    process._proc = RunningProc()

    monkeypatch.setattr(process, "_ensure_started", lambda: None)

    def fake_send(msg: dict) -> None:
        sent.append(msg)
        if msg["action"] == "runtime_readiness":
            readiness_sent.set()
            allow_readiness_to_continue.wait(timeout=1)
        elif msg["action"] == "load":
            load_sent.set()

    def fake_recv(timeout=None) -> dict:
        if threading.current_thread().name == "readiness-thread":
            readiness_done.set()
            return {"type": "runtime_readiness", "status": {"ok": True, "machine_code": "ready"}}
        if not readiness_done.is_set():
            return {"type": "runtime_readiness", "status": {"ok": True, "machine_code": "ready"}}
        return {"type": "loaded"}

    monkeypatch.setattr(process, "_send", fake_send)
    monkeypatch.setattr(process, "_recv", fake_recv)

    def run_readiness() -> None:
        try:
            results["readiness"] = process.readiness_status()
        except BaseException as exc:  # pragma: no cover - captured for assertion
            errors.append(exc)

    def run_load() -> None:
        try:
            process.load()
        except BaseException as exc:  # pragma: no cover - captured for assertion
            errors.append(exc)

    readiness_thread = threading.Thread(target=run_readiness, name="readiness-thread")
    load_thread = threading.Thread(target=run_load, name="load-thread")

    readiness_thread.start()
    assert readiness_sent.wait(timeout=1), "readiness request was never sent"

    load_thread.start()
    time.sleep(0.05)
    assert not load_sent.is_set(), "load request should wait until readiness RPC completes"

    allow_readiness_to_continue.set()

    readiness_thread.join(timeout=1)
    load_thread.join(timeout=1)

    assert errors == []
    assert results["readiness"] == {"ok": True, "machine_code": "ready"}
    assert sent == [{"action": "runtime_readiness"}, {"action": "load"}]
    assert process.is_loaded() is True


def test_extension_process_start_waits_for_ready_and_keeps_live_pid(monkeypatch, tmp_path):
    process = ExtensionProcess(tmp_path, {"id": "runtime-ext/text-to-image"})
    python = tmp_path / "python"
    python.write_text("", encoding="utf-8")

    class FakePopen:
        def __init__(self):
            self.pid = 4321
            self.stdin = None
            self.stdout = None
            self.stderr = None

        def poll(self):
            return None

    class NoopThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            pass

    monkeypatch.setattr("services.extension_process._venv_python", lambda _ext_dir: python)
    monkeypatch.setattr("services.extension_process.subprocess.Popen", lambda *args, **kwargs: FakePopen())
    monkeypatch.setattr("services.extension_process.threading.Thread", NoopThread)
    monkeypatch.setattr(process, "_recv", lambda timeout=None: {"type": "ready", "params_schema": []})

    process._start()

    assert process._proc is not None
    assert process._proc.pid == 4321
    assert process.is_loaded() is False


def test_extension_process_stop_graceful_path_and_kill_fallback_do_not_leak(monkeypatch, tmp_path):
    sent: list[dict] = []

    class GracefulProc:
        def __init__(self):
            self.wait_calls: list[float] = []

        def poll(self):
            return None

        def wait(self, timeout=None):
            self.wait_calls.append(timeout)
            return 0

    graceful = ExtensionProcess(tmp_path, {"id": "runtime-ext/text-to-image"})
    graceful._proc = GracefulProc()
    graceful._loaded = True
    graceful._queue.put({"type": "ready"})
    monkeypatch.setattr(graceful, "_send", sent.append)

    graceful.stop()

    assert sent == [{"action": "shutdown"}]
    assert graceful._proc is None
    assert graceful._loaded is False
    assert graceful._queue.empty()

    class KillProc:
        def __init__(self):
            self.kill_calls = 0
            self.wait_calls: list[float] = []

        def poll(self):
            return None

        def wait(self, timeout=None):
            self.wait_calls.append(timeout)
            if len(self.wait_calls) == 1:
                raise TimeoutError("stuck")
            return 0

        def kill(self):
            self.kill_calls += 1

    kill_sent: list[dict] = []
    fallback = ExtensionProcess(tmp_path, {"id": "runtime-ext/mesh"})
    fallback._proc = KillProc()
    fallback._loaded = True
    fallback._queue.put({"type": "ready"})
    monkeypatch.setattr(fallback, "_send", kill_sent.append)

    fallback.stop()

    assert kill_sent == [{"action": "shutdown"}]
    assert fallback._proc is None
    assert fallback._loaded is False
    assert fallback._queue.empty()


def test_extension_process_concurrent_readiness_and_load_start_one_pid(monkeypatch, tmp_path):
    process = ExtensionProcess(tmp_path, {"id": "runtime-ext/text-to-image"})
    start_calls = 0
    ready_release = threading.Event()
    sent: list[dict] = []

    class RunningProc:
        pid = 999

        def poll(self):
            return None

    def fake_start() -> None:
        nonlocal start_calls
        start_calls += 1
        ready_release.wait(timeout=1)
        process._proc = RunningProc()

    responses = iter([
        {"type": "runtime_readiness", "status": {"ok": True, "machine_code": "ready"}},
        {"type": "loaded"},
    ])

    monkeypatch.setattr(process, "_start", fake_start)
    monkeypatch.setattr(process, "_send", sent.append)
    monkeypatch.setattr(process, "_recv", lambda timeout=None: next(responses))

    readiness_result = {}

    def run_readiness() -> None:
        readiness_result.update(process.readiness_status())

    readiness_thread = threading.Thread(target=run_readiness)
    load_thread = threading.Thread(target=process.load)

    readiness_thread.start()
    load_thread.start()
    time.sleep(0.05)
    ready_release.set()
    readiness_thread.join(timeout=1)
    load_thread.join(timeout=1)

    assert start_calls == 1
    assert readiness_result == {"ok": True, "machine_code": "ready"}
    assert sent == [{"action": "runtime_readiness"}, {"action": "load"}]
