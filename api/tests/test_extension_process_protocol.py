import threading
import time
from pathlib import Path

from services.extension_process import (
    ExtensionProcess,
    _RUNTIME_READINESS_RESPONSE_TIMEOUT_SECONDS,
)


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
