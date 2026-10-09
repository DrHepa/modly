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


@pytest.mark.parametrize('action', ['generate', 'load'])
def test_readiness_waits_for_active_model_invocation_without_stealing_reply(monkeypatch, action):
    process = make_process()
    process._proc = worker = FakeWorker()
    started, release, probe_done = threading.Event(), threading.Event(), threading.Event()
    sent, results, statuses = [], [], []

    def send(message):
        sent.append(message)
        if message['action'] == 'runtime_readiness':
            process._route_readiness_reply(worker, {
                'type': 'runtime_readiness', 'id': message['id'], 'status': {'ok': True},
            })

    def receive(**kwargs):
        started.set()
        assert release.wait(2)
        return {'type': 'loaded'}

    def generate(*args):
        started.set()
        assert release.wait(2)
        return Path('/inert/output.glb')

    def probe():
        statuses.append(process.readiness_status())
        probe_done.set()

    monkeypatch.setattr(process, '_send', send)
    monkeypatch.setattr(process, '_recv', receive)
    monkeypatch.setattr(process, '_receive_generation', generate)
    invocation = threading.Thread(target=lambda: results.append(
        process.generate(b'', {}) if action == 'generate' else process.load()))
    diagnostic = threading.Thread(target=probe)
    invocation.start()
    try:
        assert started.wait(1)
        diagnostic.start()
        assert not probe_done.wait(0.02)
        assert [message['action'] for message in sent] == [action]
    finally:
        release.set()
        invocation.join(2)
        if diagnostic.ident is not None:
            diagnostic.join(2)
    assert not invocation.is_alive() and not diagnostic.is_alive()
    assert statuses == [{'ok': True}]
    assert [message['action'] for message in sent] == [action, 'runtime_readiness']
    assert results == ([Path('/inert/output.glb')] if action == 'generate' else [None])


@pytest.mark.parametrize('late_type', ['runtime_readiness', 'error'])
def test_timeout_allows_queued_load_and_discards_late_probe_reply(monkeypatch, late_type):
    process = make_process()
    process._proc = worker = FakeWorker()
    process._readiness_timeout = 0.01
    sent = []
    monkeypatch.setattr(process, '_send', sent.append)
    with pytest.raises(TimeoutError):
        process.readiness_status()
    request = sent[0]

    def send_load(message):
        sent.append(message)
        assert message == {'action': 'load'}
        # The worker finishes its timed-out optional probe before processing
        # the queued load. Neither reply nor error may steal the loaded reply.
        worker.stdout = io.StringIO(json.dumps({
            'type': late_type, 'id': request['id'], 'status': {'ok': True},
        }) + '\n' + json.dumps({'type': 'loaded'}) + '\n')
        process._read_loop(worker, process._queue)

    monkeypatch.setattr(process, '_send', send_load)
    process.load()
    assert process.is_loaded() and not worker.dead
    assert [message['action'] for message in sent] == ['runtime_readiness', 'load']
    assert process._queue.get_nowait() is None
    assert process._queue.empty()


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


def test_switch_model_unloads_after_timed_out_probe_without_reaping_workers(monkeypatch):
    import sys
    from types import SimpleNamespace
    from services.generator_registry import GeneratorRegistry

    first, second = make_process(), make_process()
    first._proc, second._proc = old_worker, target_worker = FakeWorker(), FakeWorker()
    first._loaded = second._loaded = True
    first._readiness_timeout = 0.01
    sent = []
    def send(request):
        sent.append(request)
        if request['action'] == 'unload':
            first._queue.put({'type': 'unloaded'})
    monkeypatch.setattr(first, '_send', send)
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
        assert not old_worker.dead and first._proc is old_worker and not first.is_loaded()
        assert not target_worker.dead and second.is_loaded()
        assert first._readiness_pending is not None
        assert [request['action'] for request in sent] == ['runtime_readiness', 'unload']
        assert first._route_readiness_reply(old_worker, {
            'type': 'runtime_readiness', 'id': sent[0]['id'], 'status': {'ok': True},
        })
        assert first._readiness_pending is None
        assert first._queue.empty()
    finally:
        first.stop()
        second.stop()
        registry._runtime_readiness_executor.shutdown(wait=True)


def test_unload_waits_for_probe_timeout_then_cooperates_without_reaping(monkeypatch):
    process = make_process()
    process._proc = worker = FakeWorker()
    process._readiness_timeout = 0.05
    started = threading.Event()
    sent, errors = [], []

    def send(request):
        sent.append(request['action'])
        if request['action'] == 'runtime_readiness':
            started.set()
        else:
            process._queue.put({'type': 'unloaded'})

    def probe():
        try:
            process.readiness_status()
        except TimeoutError as exc:
            errors.append(str(exc))

    monkeypatch.setattr(process, '_send', send)
    diagnostic = threading.Thread(target=probe)
    unloader = threading.Thread(target=process.unload)
    diagnostic.start()
    try:
        assert started.wait(1)
        unloader.start()
        unloader.join(0.01)
        assert unloader.is_alive() and sent == ['runtime_readiness']
        diagnostic.join(1)
        unloader.join(1)
        assert not diagnostic.is_alive() and not unloader.is_alive()
        assert not worker.dead and sent == ['runtime_readiness', 'unload']
        assert errors == ['Runtime readiness check timed out']
    finally:
        process.stop()
        diagnostic.join(2)
        if unloader.ident is not None:
            unloader.join(2)


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
