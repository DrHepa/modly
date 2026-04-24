"""Inert worker tests: no extension imports, model loads or real subprocesses."""
import queue
import io
import json
import threading
from pathlib import Path

import pytest

from services.extension_process import ExtensionProcess


class FakeWorker:
    def __init__(self):
        self.dead = False

    def poll(self):
        return 0 if self.dead else None

    def kill(self):
        self.dead = True

    def wait(self, timeout=None):
        return 0


def make_process():
    return ExtensionProcess(Path('/unused/inert-extension'), {'id': 'ext/node'})


def test_readiness_never_starts_a_stopped_worker(monkeypatch):
    process = make_process()
    def forbidden():
        raise AssertionError('diagnostics must not start/import/repair a worker')
    monkeypatch.setattr(process, '_ensure_started', forbidden)
    with pytest.raises(RuntimeError, match='not running'):
        process.readiness_status()


def test_readiness_does_not_steal_an_active_generation_reply(monkeypatch):
    process = make_process()
    process._proc = FakeWorker()
    started, release = threading.Event(), threading.Event()
    sent, results = [], []
    monkeypatch.setattr(process, '_send', sent.append)
    monkeypatch.setattr(process, '_recv', lambda **kwargs: {'type': 'runtime_readiness', 'status': {}})
    def receive(*args):
        started.set()
        assert release.wait(2)
        return Path('/inert/output.glb')
    monkeypatch.setattr(process, '_receive_generation', receive)
    thread = threading.Thread(target=lambda: results.append(process.generate(b'', {})))
    thread.start()
    try:
        assert started.wait(1)
        with pytest.raises(RuntimeError, match='busy'):
            process.readiness_status()
        assert [message['action'] for message in sent] == ['generate']
    finally:
        release.set()
        thread.join(2)
    assert not thread.is_alive()
    assert results == [Path('/inert/output.glb')]


def test_readiness_does_not_consume_load_reply(monkeypatch):
    process = make_process()
    process._proc = FakeWorker()
    started, release = threading.Event(), threading.Event()
    monkeypatch.setattr(process, '_send', lambda message: started.set())
    def receive(**kwargs):
        assert release.wait(2)
        return {'type': 'loaded'}
    monkeypatch.setattr(process, '_recv', receive)
    thread = threading.Thread(target=process.load)
    thread.start()
    try:
        assert started.wait(1)
        with pytest.raises(RuntimeError, match='busy'):
            process.readiness_status()
    finally:
        release.set()
        thread.join(2)
    assert not thread.is_alive()
    assert process.is_loaded()


def test_timeout_keeps_worker_pending_until_exact_reply_then_load_is_clean(monkeypatch):
    process = make_process()
    process._proc = worker = FakeWorker()
    process._readiness_timeout = 0.01
    sent = []
    monkeypatch.setattr(process, '_send', sent.append)
    with pytest.raises(TimeoutError):
        process.readiness_status()
    request = sent[0]
    with pytest.raises(RuntimeError, match='busy'):
        process.load()
    assert len(sent) == 1
    process._route_readiness_reply(worker, {
        'type': 'runtime_readiness', 'id': 'readiness:wrong', 'status': {'ok': True},
    })
    with pytest.raises(RuntimeError, match='busy'):
        process.readiness_status()
    # Exercise the real reader routing, including a late correlated error.
    worker.stdout = io.StringIO(json.dumps({'type': 'error', 'id': request['id']}) + '\n')
    own_queue = queue.Queue()
    process._read_loop(worker, own_queue)
    assert own_queue.get_nowait() is None  # only EOF, never the late error
    assert own_queue.empty()
    process._queue.put({'type': 'loaded'})
    process.load()
    assert sent[-1] == {'action': 'load'}
    assert process.is_loaded()


def test_stop_wakes_probe_and_old_incarnation_cannot_finish_new_probe(monkeypatch):
    process = make_process()
    process._proc = old_worker = FakeWorker()
    started = threading.Event()
    sent, errors = [], []
    def send(message):
        sent.append(message)
        started.set()
    monkeypatch.setattr(process, '_send', send)
    def probe():
        try:
            process.readiness_status()
        except RuntimeError as exc:
            errors.append(str(exc))
    thread = threading.Thread(target=probe)
    thread.start()
    assert started.wait(1)
    process.stop()
    thread.join(1)
    assert not thread.is_alive()
    assert errors == ['Runtime readiness worker changed']
    process._proc = new_worker = FakeWorker()
    replies = queue.Queue()
    process._readiness_pending = (new_worker, 'readiness:new', replies)
    process._route_readiness_reply(old_worker, {
        'type': 'runtime_readiness', 'id': 'readiness:new', 'status': {'ok': True},
    })
    process._finish_readiness(old_worker)
    assert replies.empty()
    assert process._readiness_pending[0] is new_worker
    process._route_readiness_reply(new_worker, {
        'type': 'runtime_readiness', 'id': 'readiness:new', 'status': {'ok': False},
    })
    assert replies.get_nowait()['status'] == {'ok': False}
    assert process._readiness_pending is None


def test_stop_wakes_in_progress_generation_without_waiting_for_invocation(monkeypatch):
    process = make_process()
    process._proc = FakeWorker()
    started, failed = threading.Event(), threading.Event()
    monkeypatch.setattr(process, '_send', lambda message: started.set())
    def generate():
        try:
            process.generate(b'', {})
        except RuntimeError:
            failed.set()
    thread = threading.Thread(target=generate)
    thread.start()
    assert started.wait(1)
    process.stop()
    thread.join(1)
    assert not thread.is_alive()
    assert failed.is_set()


def test_switch_model_releases_timed_out_probe_without_affecting_target_worker(monkeypatch):
    import sys
    from types import SimpleNamespace
    from services.generator_registry import GeneratorRegistry

    first, second = make_process(), make_process()
    first._proc, second._proc = old_worker, target_worker = FakeWorker(), FakeWorker()
    first._loaded = second._loaded = True
    first._readiness_timeout = 0.01
    sent = []
    monkeypatch.setattr(first, '_send', sent.append)
    monkeypatch.setitem(sys.modules, 'services.llm_server', SimpleNamespace(
        llama_pool=SimpleNamespace(unload_all=lambda: None)))
    registry = GeneratorRegistry()
    registry._generators = {'a/node': first, 'b/node': second}
    registry._active_id = 'a/node'
    try:
        with pytest.raises(TimeoutError):
            first.readiness_status()
        assert not old_worker.dead  # diagnostics themselves never terminate workers
        registry.switch_model('b/node')
        assert registry._active_id == 'b/node'
        assert old_worker.dead and first._proc is None and not first.is_loaded()
        assert not target_worker.dead and second.is_loaded()
        assert first._readiness_pending is None
        assert [request['action'] for request in sent] == ['runtime_readiness']
        assert first._route_readiness_reply(old_worker, {
            'type': 'runtime_readiness', 'id': sent[0]['id'], 'status': {'ok': True},
        })
        assert first._queue.get_nowait() is None  # stop sentinel, not a late reply
        assert first._queue.empty()
    finally:
        first.stop()
        second.stop()
        registry._runtime_readiness_executor.shutdown(wait=True)


def test_unload_stops_pending_probe_and_wakes_waiter_before_diagnostic_deadline(monkeypatch):
    process = make_process()
    process._proc = worker = FakeWorker()
    sent, errors = threading.Event(), []
    monkeypatch.setattr(process, '_send', lambda request: sent.set())
    def probe():
        try:
            process.readiness_status()
        except RuntimeError as exc:
            errors.append(str(exc))
    probe_thread = threading.Thread(target=probe)
    unload_thread = threading.Thread(target=process.unload)
    probe_thread.start()
    try:
        assert sent.wait(1)
        unload_thread.start()
        unload_thread.join(0.5)
        probe_thread.join(0.5)
        assert not unload_thread.is_alive() and not probe_thread.is_alive()
        assert worker.dead and process._readiness_pending is None
        assert errors == ['Runtime readiness worker changed']
    finally:
        process.stop()
        probe_thread.join(2)
        if unload_thread.ident is not None:
            unload_thread.join(2)


def test_unload_does_not_reap_generation_when_no_diagnostic_is_pending(monkeypatch):
    process = make_process()
    process._proc = worker = FakeWorker()
    started, release, unloaded = threading.Event(), threading.Event(), threading.Event()
    sent, results = [], []
    def send(request):
        sent.append(request['action'])
        if request['action'] == 'unload':
            process._queue.put({'type': 'unloaded'})
    def receive(*args):
        started.set()
        assert release.wait(2)
        return Path('/inert/generated.glb')
    monkeypatch.setattr(process, '_send', send)
    monkeypatch.setattr(process, '_receive_generation', receive)
    generation = threading.Thread(target=lambda: results.append(process.generate(b'', {})))
    def unload():
        process.unload()
        unloaded.set()
    unloader = threading.Thread(target=unload)
    generation.start()
    try:
        assert started.wait(1)
        unloader.start()
        assert not unloaded.wait(0.02)
        assert not worker.dead and sent == ['generate']
    finally:
        release.set()
        generation.join(2)
        if unloader.ident is not None:
            unloader.join(2)
    assert not generation.is_alive() and not unloader.is_alive()
    assert results == [Path('/inert/generated.glb')]
    assert sent == ['generate', 'unload'] and unloaded.is_set() and not worker.dead
    process.stop()
