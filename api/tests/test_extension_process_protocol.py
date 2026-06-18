"""Load acknowledgement regressions with inert workers and real reply queues."""
import io
import json
import queue

import pytest

from services.extension_process import ExtensionProcess


class InertWorker:
    def __init__(self):
        self.dead = False

    def poll(self):
        return 0 if self.dead else None


@pytest.fixture
def load_process(monkeypatch, tmp_path):
    process = ExtensionProcess(tmp_path, {"id": "fixture/load"})
    process._proc = InertWorker()
    sent = []
    monkeypatch.setattr(process, "_send", sent.append)

    def forbidden_start():
        raise AssertionError("This fixture must not launch an extension worker")

    monkeypatch.setattr(process, "_start", forbidden_start)
    return process, sent


def send_load_reply(monkeypatch, process, sent, *replies):
    def send(request):
        sent.append(request)
        assert request == {"action": "load"}
        for reply in replies:
            process._queue.put(reply)

    monkeypatch.setattr(process, "_send", send)


@pytest.mark.parametrize("stale_count", [2, 4])
def test_extension_process_load_ignores_multiple_stale_unloaded_acks(
    monkeypatch, load_process, stale_count
):
    process, sent = load_process
    for _ in range(stale_count):
        process._queue.put({"type": "unloaded"})
    send_load_reply(monkeypatch, process, sent, {"type": "loaded"})

    process.load()

    assert sent == [{"action": "load"}]
    assert process.is_loaded()
    assert process._queue.empty()


@pytest.mark.parametrize("stale_ack", [False, True])
def test_extension_process_load_does_not_accept_ready_without_loaded(
    monkeypatch, load_process, stale_ack
):
    process, sent = load_process
    process._loaded = True
    waits = []

    class ObservedQueue(queue.Queue):
        def get(self, block=True, timeout=None):
            assert not process._loaded and not process.is_loaded()
            assert process._invocation_lock.locked()
            waits.append(timeout)
            # Fail immediately if the bounded fixture exhausts its replies.
            return super().get(block=False)

    process._queue = ObservedQueue()
    if stale_ack:
        process._queue.put({"type": "unloaded"})
    # EOF terminates the ready-only load without relying on a test timeout.
    send_load_reply(monkeypatch, process, sent, {"type": "ready"}, None)

    with pytest.raises(RuntimeError, match="Subprocess died unexpectedly"):
        process.load()

    assert sent == [{"action": "load"}]
    assert waits == [None] * (3 if stale_ack else 2)
    assert not process._loaded and not process.is_loaded()
    assert process._queue.empty()
    assert not process._invocation_lock.locked()


@pytest.mark.parametrize(
    "error, expected",
    [
        ({"type": "error", "traceback": "load traceback", "message": "short"}, "load traceback"),
        ({"type": "error", "message": "load message"}, "load message"),
    ],
)
def test_extension_process_load_propagates_error_after_stale_unload(
    monkeypatch, load_process, error, expected
):
    process, sent = load_process
    process._loaded = True
    process._queue.put({"type": "unloaded"})
    send_load_reply(monkeypatch, process, sent, error)

    with pytest.raises(RuntimeError, match=expected):
        process.load()

    assert not process._loaded and not process.is_loaded()
    assert process._queue.empty()


def test_extension_process_load_fails_on_eof_after_stale_unload(monkeypatch, load_process):
    process, sent = load_process
    process._loaded = True
    process._queue.put({"type": "unloaded"})
    send_load_reply(monkeypatch, process, sent, None)

    with pytest.raises(RuntimeError, match="Subprocess died unexpectedly"):
        process.load()

    assert not process._loaded and not process.is_loaded()
    assert process._queue.empty()


def test_extension_process_unload_timeout_late_ack_does_not_break_next_load(
    monkeypatch, load_process
):
    process, sent = load_process
    process._loaded = True
    worker = process._proc

    class UnloadTimeoutQueue(queue.Queue):
        def get(self, block=True, timeout=None):
            if timeout == 30.0:
                raise queue.Empty  # Model the timeout, without waiting 30 seconds.
            return super().get(block=block, timeout=timeout)

    process._queue = UnloadTimeoutQueue()
    process.unload()
    assert process._proc is worker and worker.poll() is None
    assert not process.is_loaded() and process._readiness_pending is None
    process._queue.put({"type": "unloaded"})
    send_load_reply(monkeypatch, process, sent, {"type": "loaded"})

    process.load()

    assert sent == [{"action": "unload"}, {"action": "load"}]
    assert process.is_loaded() and process._queue.empty()


def test_extension_process_restart_keeps_old_control_frames_out_of_new_load(
    monkeypatch, load_process
):
    process, sent = load_process
    old_worker, old_queue = process._proc, process._queue
    process._loaded = True
    old_worker.dead = True
    old_worker.stdout = io.StringIO("\n".join(json.dumps({"type": kind}) for kind in (
        "loaded", "unloaded"
    )))
    new_worker = InertWorker()

    def start():
        assert not process._loaded
        process._proc = new_worker
        process._queue = queue.Queue()
        process._read_loop(old_worker, old_queue)
        assert process._queue.empty()

    monkeypatch.setattr(process, "_start", start)
    send_load_reply(monkeypatch, process, sent, {"type": "loaded"})

    process.load()

    assert process._proc is new_worker and process.is_loaded()
    assert process._queue.empty()
    assert [old_queue.get_nowait() for _ in range(3)] == [
        {"type": "loaded"}, {"type": "unloaded"}, None
    ]
    assert old_queue.empty()


@pytest.mark.parametrize("change", ["died", "replaced"])
def test_extension_process_load_does_not_publish_ack_for_changed_worker(
    monkeypatch, load_process, change
):
    process, sent = load_process
    worker = process._proc

    def send(request):
        sent.append(request)
        if change == "died":
            worker.dead = True
        else:
            process._proc = InertWorker()
        process._queue.put({"type": "loaded"})

    monkeypatch.setattr(process, "_send", send)

    with pytest.raises(RuntimeError, match="worker changed or stopped"):
        process.load()

    assert not process._loaded and not process.is_loaded()


@pytest.mark.parametrize("failure", ["start", "send"])
def test_extension_process_load_clears_previous_loaded_state_before_failure(
    monkeypatch, load_process, failure
):
    process, _ = load_process
    process._loaded = True

    def fail(*args):
        raise RuntimeError("inert transport failure")

    if failure == "start":
        process._proc.dead = True
        monkeypatch.setattr(process, "_start", fail)
    else:
        monkeypatch.setattr(process, "_send", fail)

    with pytest.raises(RuntimeError, match="inert transport failure"):
        process.load()

    assert not process._loaded and not process.is_loaded()


def test_extension_process_load_preserves_unbounded_wait_after_stale_acks(
    monkeypatch, load_process
):
    process, sent = load_process
    waits = []

    class ObservedQueue(queue.Queue):
        def get(self, block=True, timeout=None):
            waits.append(timeout)
            return super().get(block=block, timeout=timeout)

    process._queue = ObservedQueue()
    process._queue.put({"type": "unloaded"})
    send_load_reply(monkeypatch, process, sent, {"type": "loaded"})

    process.load()

    assert waits == [None, None]
    assert process.is_loaded()


@pytest.mark.parametrize("stale_count", [1, 3])
def test_extension_process_load_ignores_stale_ready_before_loaded(
    monkeypatch, load_process, stale_count
):
    process, sent = load_process
    worker, schema = process._proc, process._params_schema
    waits = []

    class ObservedQueue(queue.Queue):
        def get(self, block=True, timeout=None):
            assert not process._loaded and not process.is_loaded()
            assert process._invocation_lock.locked()
            waits.append(timeout)
            return super().get(block=False)

    process._queue = ObservedQueue()
    stale = [reply for _ in range(stale_count) for reply in (
        {"type": "ready", "params_schema": [{"name": "stale"}]},
        {"type": "unloaded"},
    )]
    send_load_reply(monkeypatch, process, sent, *stale, {"type": "loaded"})

    process.load()

    assert sent == [{"action": "load"}]
    assert process._proc is worker and process.is_loaded()
    assert process._params_schema is schema
    assert waits == [None] * (2 * stale_count + 1)
    assert process._queue.empty()
    assert not process._invocation_lock.locked()


@pytest.mark.parametrize(
    "error, expected",
    [
        ({"type": "error", "traceback": "ready load traceback", "message": "short"}, "ready load traceback"),
        ({"type": "error", "message": "ready load message"}, "ready load message"),
    ],
)
def test_extension_process_load_propagates_error_after_stale_ready(
    monkeypatch, load_process, error, expected
):
    process, sent = load_process
    process._loaded = True
    send_load_reply(monkeypatch, process, sent, {"type": "ready"}, error, None)

    with pytest.raises(RuntimeError, match=expected):
        process.load()

    assert sent == [{"action": "load"}]
    assert not process._loaded and not process.is_loaded()
    assert process._queue.get_nowait() is None and process._queue.empty()
    assert not process._invocation_lock.locked()


@pytest.mark.parametrize("change", ["died", "replaced"])
def test_extension_process_load_checks_worker_after_stale_ready(
    monkeypatch, load_process, change
):
    process, sent = load_process
    worker = process._proc
    seen = []

    class ChangedWorkerQueue(queue.Queue):
        def get(self, block=True, timeout=None):
            assert not process._loaded and process._invocation_lock.locked()
            assert timeout is None
            reply = super().get(block=False)
            seen.append(reply["type"])
            if reply["type"] == "loaded":
                if change == "died":
                    worker.dead = True
                else:
                    process._proc = InertWorker()
            return reply

    process._queue = ChangedWorkerQueue()
    send_load_reply(monkeypatch, process, sent, {"type": "ready"}, {"type": "loaded"})

    with pytest.raises(RuntimeError, match="worker changed or stopped"):
        process.load()

    assert seen == ["ready", "loaded"]
    assert sent == [{"action": "load"}]
    assert not process._loaded and not process.is_loaded()
    assert process._queue.empty()
    assert not process._invocation_lock.locked()


@pytest.fixture(params=["image", "artifact"])
def generation_process(request, monkeypatch, tmp_path):
    """Exercise both public generation routes without starting a worker."""
    from services import generator_registry

    process = ExtensionProcess(tmp_path, {"id": "fixture/generation"})
    process._proc = InertWorker()
    process._loaded = True
    sent, progress = [], []
    output = tmp_path / "current.glb"
    scene = tmp_path / "Workflows" / "scene-manifest.json"
    scene.parent.mkdir()
    scene.write_text(json.dumps({
        "schema": "modly.scene-manifest.v1", "sceneRoot": ".", "assets": [],
    }))
    monkeypatch.setattr(generator_registry, "WORKSPACE_DIR", tmp_path)
    monkeypatch.setattr(process, "_start", lambda: pytest.fail("Must not start a worker"))

    def generate(cancel_event=None):
        callback = lambda pct, step: progress.append((pct, step))
        if request.param == "image":
            return process.generate(b"inert-image", {}, callback, cancel_event)
        return process.generate_artifact("scene", scene, {}, callback, cancel_event)

    def reply_on_send(*replies):
        def send(message):
            sent.append(message)
            if message["action"] == "generate":
                for reply in replies:
                    frame = dict(reply)
                    if frame.pop("current_id", False):
                        frame["id"] = message["id"]
                    process._queue.put(frame)
                # A missing terminal reply must fail, never hang this fixture.
                process._queue.put(None)
        monkeypatch.setattr(process, "_send", send)

    return process, generate, reply_on_send, sent, progress, output


@pytest.mark.parametrize("reply_type", ["progress", "done", "error", "cancelled"])
@pytest.mark.parametrize("foreign_id", ["other-generation", None, "missing"])
def test_generation_ignores_foreign_or_untagged_replies(generation_process, reply_type, foreign_id):
    process, generate, reply_on_send, sent, progress, output = generation_process
    foreign = {
        "type": reply_type, "id": foreign_id, "pct": 99, "step": "foreign",
        "output_path": str(output.with_name("foreign.glb")),
        "message": "foreign error", "loaded": False,
    }
    if foreign_id == "missing":
        foreign.pop("id")
    reply_on_send(foreign, {"type": "done", "current_id": True, "output_path": str(output)})

    assert generate() == output

    assert process.is_loaded()  # Foreign errors cannot invalidate this model.
    assert progress == []
    assert sent[0]["model_id"] == process.MODEL_ID
    assert process._queue.get_nowait() is None and process._queue.empty()


@pytest.mark.parametrize("reply_type", ["progress", "done", "error", "cancelled"])
def test_generation_accepts_current_request_replies(generation_process, reply_type):
    from services.generators.base import GenerationCancelled

    process, generate, reply_on_send, _, progress, output = generation_process
    replies = [{
        "type": reply_type, "current_id": True, "pct": 42, "step": "current",
        "output_path": str(output), "message": "short",
        "traceback": "current traceback", "loaded": False,
    }]
    if reply_type == "progress":
        replies.append({"type": "done", "current_id": True, "output_path": str(output)})
    reply_on_send(*replies)

    if reply_type == "error":
        with pytest.raises(RuntimeError, match="current traceback"):
            generate()
        assert not process.is_loaded()
    elif reply_type == "cancelled":
        with pytest.raises(GenerationCancelled):
            generate()
        assert process.is_loaded()
    else:
        assert generate() == output
        assert process.is_loaded()
    assert progress == ([(42, "current")] if reply_type == "progress" else [])
    assert process._queue.get_nowait() is None and process._queue.empty()


def test_generation_preserves_logs_and_eof(generation_process, capsys):
    _, generate, reply_on_send, _, progress, _ = generation_process
    reply_on_send({"type": "log", "message": "inert worker log"})

    with pytest.raises(RuntimeError, match="Subprocess died during generation"):
        generate()

    assert "inert worker log" in capsys.readouterr().err
    assert progress == []


def test_generation_cooperative_cancel_uses_current_id(generation_process):
    import threading
    from services.generators.base import GenerationCancelled

    process, generate, reply_on_send, sent, _, _ = generation_process
    reply_on_send(
        {"type": "cancelled", "id": "foreign"},
        {"type": "cancelled", "current_id": True},
    )
    cancelled = threading.Event()
    cancelled.set()

    with pytest.raises(GenerationCancelled):
        generate(cancelled)

    assert sent[1:] == [{"action": "cancel", "id": sent[0]["id"]}]
    assert process.is_loaded()
    assert process._queue.get_nowait() is None and process._queue.empty()


def test_generation_retains_three_second_cancel_grace_and_reap(generation_process, monkeypatch):
    import threading
    import time
    from services.generators.base import GenerationCancelled

    process, generate, _, sent, _, _ = generation_process
    elapsed, waits = [0.0], []

    class NoReplyQueue(queue.Queue):
        def get(self, block=True, timeout=None):
            waits.append(timeout)
            elapsed[0] += 1.5
            raise queue.Empty

    class CancelWorker(InertWorker):
        def kill(self):
            assert elapsed[0] == 3.0
            self.dead = True

        def wait(self, timeout=None):
            assert timeout == 5.0
            waits.append("reaped")
            return 0

    worker = process._proc = CancelWorker()
    process._queue = NoReplyQueue()
    monkeypatch.setattr(process, "_send", sent.append)
    monkeypatch.setattr(time, "monotonic", lambda: elapsed[0])
    cancelled = threading.Event()
    cancelled.set()

    with pytest.raises(GenerationCancelled):
        generate(cancelled)

    assert sent[1:] == [{"action": "cancel", "id": sent[0]["id"]}]
    assert worker.dead and process._proc is None and not process.is_loaded()
    assert waits == [0.5, 0.5, "reaped"]


def test_extension_process_load_ignores_queued_runtime_readiness_before_loaded(monkeypatch, load_process):
    """Original33 intent: reader routing, not a shared-queue diagnostic drain."""
    process, sent = load_process

    def send(request):
        sent.append(request)
        process._proc.stdout = io.StringIO("\n".join(map(json.dumps, [
            {"type": "runtime_readiness", "id": "readiness:late", "status": {"ok": True}},
            {"type": "loaded"},
        ])))
        process._read_loop(process._proc, process._queue)

    monkeypatch.setattr(process, "_send", send)
    process.load()
    assert sent == [{"action": "load"}] and process.is_loaded()
    assert process._queue.get_nowait() is None and process._queue.empty()


def test_extension_process_readiness_ignores_stale_loaded_before_runtime_readiness(monkeypatch, load_process):
    """Diagnostics must leave regular control replies untouched."""
    process, sent = load_process
    stale = {"type": "loaded"}
    process._queue.put(stale)

    def send(request):
        sent.append(request)
        process._route_readiness_reply(process._proc, {
            "type": "runtime_readiness", "id": request["id"], "status": {"ok": True},
        })

    monkeypatch.setattr(process, "_send", send)
    assert process.readiness_status() == {"ok": True}
    assert len(sent) == 1 and sent[0]["action"] == "runtime_readiness"
    assert process._queue.get_nowait() == stale and process._queue.empty()


def test_extension_process_generate_ignores_stale_runtime_readiness_before_done(generation_process):
    process, generate, reply_on_send, _, _, output = generation_process
    assert process._route_readiness_reply(process._proc, {
        "type": "runtime_readiness", "id": "readiness:late", "status": {"ok": True},
    })
    reply_on_send({"type": "done", "current_id": True, "output_path": str(output)})
    assert generate() == output


def test_extension_process_serializes_readiness_and_load_requests(monkeypatch, load_process):
    """Current owner rejects a pending diagnostic rather than waiting on it."""
    process, sent = load_process
    process._readiness_timeout = 0.001
    with pytest.raises(TimeoutError):
        process.readiness_status()
    pending = process._readiness_pending
    with pytest.raises(RuntimeError, match="busy"):
        process.load()
    assert len(sent) == 1 and process._readiness_pending is pending
    process._route_readiness_reply(process._proc, {
        "type": "runtime_readiness", "id": sent[0]["id"], "status": {"ok": True},
    })
    send_load_reply(monkeypatch, process, sent, {"type": "loaded"})
    process.load()
    assert process.is_loaded() and process._readiness_pending is None
    assert [request["action"] for request in sent] == ["runtime_readiness", "load"]


@pytest.mark.parametrize("failure", ["wait", "still_alive"])
def test_stop_retains_worker_when_reap_is_unconfirmed(load_process, failure):
    process, _ = load_process

    class UnreapedWorker(InertWorker):
        def kill(self):
            pass

        def wait(self, timeout=None):
            assert timeout == 5
            if failure == "wait":
                raise TimeoutError("inert reap timeout")
            return 0

    process._proc = worker = UnreapedWorker()
    process._loaded = True
    with pytest.raises(RuntimeError, match="Could not stop|still running"):
        process.stop()
    assert process._proc is worker and worker.poll() is None
    assert not process.is_loaded()
