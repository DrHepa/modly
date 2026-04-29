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
def test_extension_process_load_rejects_ready_without_loaded(
    monkeypatch, load_process, stale_ack
):
    process, sent = load_process
    process._loaded = True
    if stale_ack:
        process._queue.put({"type": "unloaded"})
    send_load_reply(monkeypatch, process, sent, {"type": "ready"})

    with pytest.raises(RuntimeError, match="Unexpected response to load.*ready"):
        process.load()

    assert sent == [{"action": "load"}]
    assert not process._loaded and not process.is_loaded()
    assert process._queue.empty()


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


def test_extension_process_ready_does_not_consume_later_loaded_ack(monkeypatch, load_process):
    process, sent = load_process
    send_load_reply(monkeypatch, process, sent, {"type": "ready"}, {"type": "loaded"})

    with pytest.raises(RuntimeError, match="Unexpected response to load.*ready"):
        process.load()

    assert not process.is_loaded()
    # Ordinary acknowledgements have no request ID. This remaining frame is not
    # claimed to be distinguishable from a later request's reply on this worker.
    assert process._queue.get_nowait() == {"type": "loaded"}
    assert process._queue.empty()
