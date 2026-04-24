import queue
import threading
import time
import os
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from services.extension_process import ExtensionProcess
from services.generator_registry import GeneratorRegistry, _LegacyGeneratorProxy
os.environ.setdefault("EXTENSION_DIR", "/tmp/modly-test-extension")
import runner


class FakeReadinessWorker:
    dead = False
    def poll(self): return 0 if self.dead else None
    def kill(self): self.dead = True
    def wait(self, timeout=None): return 0


class CountingReadinessGenerator(ExtensionProcess):
    DISPLAY_NAME = "Counting"
    VRAM_GB = 0

    def __init__(self, statuses: list[dict] | None = None):
        super().__init__(Path('/unused/inert-extension'), {'id': 'ext/node'})
        self._proc = FakeReadinessWorker()
        self.calls = 0
        self.release = threading.Event()
        self.statuses = statuses or [
            {
                "ok": True,
                "machine_code": "ready",
                "label_hint": "Ready",
                "evidence": {"runtime_name": "codex", "token": "secret", "raw_output": "secret output"},
            }
        ]

    def is_downloaded(self) -> bool:
        return True

    def is_loaded(self) -> bool:
        return False

    def _send(self, message: dict) -> None:
        assert message['action'] == 'runtime_readiness'
        worker = self._proc
        self.calls += 1
        self.release.wait(timeout=1)
        status = self.statuses[min(self.calls - 1, len(self.statuses) - 1)]
        self._route_readiness_reply(worker, {
            'id': message['id'],
            **({'type': 'error'} if isinstance(status, Exception)
               else {'type': 'runtime_readiness', 'status': status}),
        })


class LegacyGenerator:
    DISPLAY_NAME = "Legacy"
    VRAM_GB = 0


def _registry(model_id: str, generator) -> GeneratorRegistry:
    registry = GeneratorRegistry()
    registry._generators = {model_id: generator}
    registry._manifests = {model_id: {"id": model_id, "name": "Runtime"}}
    registry._active_id = model_id
    return registry


def test_registry_detects_optional_readiness_method_caches_and_sanitizes_evidence():
    generator = CountingReadinessGenerator()
    registry = _registry("runtime-ext/text-to-image", generator)

    first_result: dict[str, dict] = {}
    second_result: dict[str, dict] = {}
    first = threading.Thread(target=lambda: first_result.update(registry.runtime_readiness(["runtime-ext/text-to-image"])))
    second = threading.Thread(target=lambda: second_result.update(registry.runtime_readiness(["runtime-ext/text-to-image"])))

    first.start()
    second.start()
    time.sleep(0.05)
    generator.release.set()
    first.join(timeout=2)
    second.join(timeout=2)

    assert generator.calls == 1
    assert first_result == second_result
    assert first_result["runtime-ext/text-to-image"]["machine_code"] == "ready"
    assert first_result["runtime-ext/text-to-image"]["checked_at"]
    assert first_result["runtime-ext/text-to-image"]["evidence"] == {"runtime_name": "codex"}

    cached = registry.runtime_readiness(["runtime-ext/text-to-image"])
    assert generator.calls == 1
    assert cached == first_result


def test_registry_returns_stale_cache_on_error_and_sanitized_failure_without_cache():
    generator = CountingReadinessGenerator(
        statuses=[
            {"ok": True, "machine_code": "ready", "checked_at": "2026-04-24T00:00:00Z"},
            RuntimeError("secret token leaked from subprocess"),
        ]
    )
    registry = _registry("runtime-ext/text-to-image", generator)
    registry._runtime_readiness_ttl_seconds = 0

    ready = registry.runtime_readiness(["runtime-ext/text-to-image"])["runtime-ext/text-to-image"]
    failed = registry.runtime_readiness(["runtime-ext/text-to-image"])["runtime-ext/text-to-image"]

    assert ready["machine_code"] == "ready"
    assert failed["machine_code"] == "ready"
    assert failed["stale"] is True
    assert "secret" not in str(failed)

    no_cache = _registry("runtime-ext/text-to-image", generator)
    no_cache._runtime_readiness_timeout_seconds = 0.01
    generator.release.clear()
    timed_out = no_cache.runtime_readiness(["runtime-ext/text-to-image"])["runtime-ext/text-to-image"]

    assert timed_out["ok"] is False
    assert timed_out["machine_code"] == "check_failed"
    assert timed_out["label_hint"] == "Checking failed"
    assert "secret" not in str(timed_out)


def test_registry_marks_models_without_readiness_as_unsupported_contract():
    registry = _registry("legacy-ext/image-to-mesh", LegacyGenerator())

    readiness = registry.runtime_readiness(["legacy-ext/image-to-mesh"])["legacy-ext/image-to-mesh"]

    assert readiness["ok"] is False
    assert readiness["machine_code"] == "unsupported_contract"
    assert readiness["reason"] == "Runtime readiness requires an isolated worker; direct model use is unchanged."


def test_extension_process_sends_runtime_readiness_action_with_bounded_timeout(monkeypatch):
    process = ExtensionProcess(Path('/unused'), {"id": "runtime-ext/text-to-image"})
    process._proc = type('FakeWorker', (), {'poll': lambda self: None})()
    sent: list[dict] = []
    def send(message):
        sent.append(message)
        process._route_readiness_reply(process._proc, {
            'type': 'runtime_readiness', 'id': message['id'],
            'status': {'ok': True, 'machine_code': 'ready'},
        })
    monkeypatch.setattr(process, "_send", send)

    status = process.readiness_status()

    assert len(sent) == 1
    assert sent[0]['action'] == 'runtime_readiness'
    assert sent[0]['id'].startswith('readiness:')
    assert process._readiness_timeout == 5.0
    assert status == {"ok": True, "machine_code": "ready"}


def test_runner_returns_generator_readiness_or_unsupported_contract():
    class ReadyGenerator:
        def readiness_status(self):
            return {"ok": True, "machine_code": "ready"}

    class UnsupportedGenerator:
        pass

    assert runner.resolve_runtime_readiness(ReadyGenerator()) == {"ok": True, "machine_code": "ready"}
    assert runner.resolve_runtime_readiness(UnsupportedGenerator())["machine_code"] == "unsupported_contract"


def test_cache_identity_separates_owner_siblings_and_runtime_roots():
    first, second = CountingReadinessGenerator(), CountingReadinessGenerator()
    first.release.set()
    second.release.set()
    first.model_dir = second.model_dir = Path('/inert/shared-owner')
    registry = _registry('ext/first', first)
    registry._generators['ext/second'] = second
    registry._manifests['ext/second'] = {'id': 'ext/second', 'weight_owner_id': 'ext/first'}
    registry.runtime_readiness(['ext/first', 'ext/second'])
    assert first.calls == second.calls == 1
    first.model_dir = Path('/inert/new-root')
    registry.runtime_readiness(['ext/first', 'ext/second'])
    assert first.calls == 2 and second.calls == 1
    first.shared_model_dirs = {'group': Path('/inert/group')}
    registry.runtime_readiness(['ext/first'])
    assert first.calls == 3
    assert registry._active_id == 'ext/first'


def test_late_result_cannot_repopulate_cache_after_unload_or_replacement():
    generator = CountingReadinessGenerator()
    generator.model_dir = Path('/inert/old-root')
    generator.unload = lambda: None
    registry = _registry('ext/node', generator)
    registry._runtime_readiness_timeout_seconds = 0.01
    status = registry.runtime_readiness(['ext/node'])['ext/node']
    assert status['ok'] is False
    assert registry.unload_model('ext/node') is True
    replacement = CountingReadinessGenerator([{'ok': False, 'machine_code': 'login'}])
    replacement.release.set()
    registry._generators['ext/node'] = replacement
    generator.release.set()
    registry._runtime_readiness_timeout_seconds = 1
    assert registry.runtime_readiness(['ext/node'])['ext/node']['machine_code'] == 'login'
    assert all(key[1] is replacement for key in registry._runtime_readiness_cache)


def test_registry_does_not_hold_lifecycle_lock_during_hook_or_accept_expired_completion():
    started, release = threading.Event(), threading.Event()
    class BlockingGenerator(CountingReadinessGenerator):
        def _send(self, message):
            started.set()
            assert release.wait(2)
            super()._send(message)
    generator = BlockingGenerator()
    generator.release.set()
    registry = _registry('ext/node', generator)
    registry._runtime_readiness_timeout_seconds = 0.02
    results = []
    thread = threading.Thread(target=lambda: results.append(registry.runtime_readiness(['ext/node'])))
    thread.start()
    assert started.wait(1)
    assert registry._lifecycle_lock.acquire(blocking=False)
    registry._lifecycle_lock.release()
    thread.join(1)
    assert not thread.is_alive()
    assert results[0]['ext/node']['ok'] is False
    future = next(iter(registry._runtime_readiness_inflight.values()))
    release.set()
    try:
        future.result(timeout=1)
    except TimeoutError:
        pass
    else:
        raise AssertionError('late readiness must expire')
    assert registry._runtime_readiness_cache == {}


def test_runtime_probe_does_not_start_worker_and_invalidates_after_stop(monkeypatch):
    process = ExtensionProcess(Path('/unused'), {'id': 'ext/node'})
    registry = _registry('ext/node', process)
    status = registry.runtime_readiness(['ext/node'])['ext/node']
    assert status['machine_code'] == 'runtime_not_running'
    class Worker:
        dead = False
        def poll(self): return 0 if self.dead else None
        def kill(self): self.dead = True
        def wait(self, timeout): return 0
    process._proc = Worker()
    monkeypatch.setattr(process, '_send', lambda request: process._route_readiness_reply(
        process._proc, {'type': 'runtime_readiness', 'id': request['id'], 'status': {'ok': True, 'machine_code': 'ready'}}))
    assert registry.runtime_readiness(['ext/node'])['ext/node']['ok'] is True
    process.stop()
    assert registry.runtime_readiness(['ext/node'])['ext/node']['machine_code'] == 'runtime_not_running'


def test_runner_readiness_correlates_without_load_or_generation(tmp_path, monkeypatch):
    (tmp_path / 'manifest.json').write_text(json.dumps({'id': 'ext', 'nodes': [{'id': 'node'}]}))
    calls, replies = [], []
    class InertGenerator:
        def __init__(self, model_dir, outputs_dir): calls.append('constructor')
        @classmethod
        def params_schema(cls): return []
        def readiness_status(self):
            calls.append('readiness')
            return {'ok': True, 'machine_code': 'ready'}
        def load(self): raise AssertionError('no load')
        def generate(self, *args): raise AssertionError('no inference')
    monkeypatch.setattr(runner, 'EXT_DIR', tmp_path)
    monkeypatch.setattr(runner, 'load_generator', lambda manifest: InertGenerator)
    monkeypatch.setattr(runner, 'recv', lambda: iter([{'action': 'runtime_readiness', 'id': 'readiness:one'}]))
    monkeypatch.setattr(runner, 'send', replies.append)
    runner.main()
    assert calls == ['constructor', 'readiness']
    assert replies[-1] == {'type': 'runtime_readiness', 'id': 'readiness:one', 'status': {'ok': True, 'machine_code': 'ready'}}


def test_direct_proxy_diagnostics_remain_unsupported_without_waiting_for_import_lock(tmp_path):
    generator = CountingReadinessGenerator()
    generator.release.set()
    registry = _registry('ext/node', generator)
    context = registry._legacy_imports.register(tmp_path)
    registry._generators['ext/node'] = _LegacyGeneratorProxy(generator, registry._legacy_imports, context)
    held, release = threading.Event(), threading.Event()
    def invocation():
        with registry._legacy_imports._lock:
            held.set()
            assert release.wait(2)
    thread = threading.Thread(target=invocation)
    thread.start()
    try:
        assert held.wait(1)
        result = registry.runtime_readiness(['ext/node'])['ext/node']
        assert result['machine_code'] == 'unsupported_contract'
        assert generator.calls == 0
    finally:
        release.set()
        thread.join(2)
    assert not thread.is_alive()
    assert registry.runtime_readiness(['ext/node'])['ext/node']['machine_code'] == 'unsupported_contract'
    assert generator.calls == 0
    assert registry._active_id == 'ext/node'


def test_reload_drops_old_runtime_cache_without_selecting_another_model(monkeypatch):
    old = CountingReadinessGenerator()
    old.release.set()
    old.unload = lambda: None
    replacement = CountingReadinessGenerator([{'ok': False, 'machine_code': 'login'}])
    replacement.release.set()
    registry = _registry('ext/node', old)
    assert registry.runtime_readiness(['ext/node'])['ext/node']['ok'] is True
    def initialize(*args):
        registry._generators['ext/node'] = replacement
        registry._manifests['ext/node'] = {'id': 'ext/node'}
    monkeypatch.setattr(registry, 'initialize', initialize)
    registry.reload()
    assert registry._active_id == 'ext/node'
    assert registry.runtime_readiness(['ext/node'])['ext/node']['machine_code'] == 'login'
    assert old.calls == 1 and replacement.calls == 1


def test_model_root_update_invalidates_ready_worker_without_probing_new_runtime(tmp_path, monkeypatch):
    import services.generator_registry as registry_module
    monkeypatch.setattr(registry_module, 'MODELS_DIR', tmp_path / 'old')
    process = ExtensionProcess(Path('/unused'), {'id': 'ext/node'})
    process.model_dir = tmp_path / 'old' / 'ext/node'
    class Worker:
        dead = False
        def poll(self): return 0 if self.dead else None
        def kill(self): self.dead = True
        def wait(self, timeout): return 0
    process._proc = worker = Worker()
    registry = _registry('ext/node', process)
    monkeypatch.setattr(process, '_send', lambda request: process._route_readiness_reply(
        worker, {'type': 'runtime_readiness', 'id': request['id'], 'status': {'ok': True, 'machine_code': 'ready'}}))
    assert registry.runtime_readiness(['ext/node'])['ext/node']['ok'] is True
    registry.update_paths(tmp_path / 'new', None)
    assert process.model_dir == tmp_path / 'new/ext/node'
    assert worker.dead
    assert registry.runtime_readiness(['ext/node'])['ext/node']['machine_code'] == 'runtime_not_running'
    assert registry._active_id == 'ext/node'


def test_expired_queued_probe_is_cancelled_and_never_runs_after_deadline():
    generator = CountingReadinessGenerator()
    generator.release.set()
    registry = _registry('ext/node', generator)
    registry._runtime_readiness_executor.shutdown(wait=True)
    registry._runtime_readiness_executor = ThreadPoolExecutor(max_workers=1)
    started, release = threading.Event(), threading.Event()
    def occupy():
        started.set()
        assert release.wait(2)
    running = registry._runtime_readiness_executor.submit(occupy)
    try:
        assert started.wait(1)
        registry._runtime_readiness_timeout_seconds = 0.01
        assert registry.runtime_readiness(['ext/node'])['ext/node']['ok'] is False
    finally:
        release.set()
        running.result(timeout=1)
        registry._runtime_readiness_executor.shutdown(wait=True)
    assert generator.calls == 0


def test_direct_diagnostics_never_enter_hooks_or_block_other_model_controls(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    accesses, activations, failures = [], [], []

    class DirectGenerator:
        DISPLAY_NAME = 'Direct'
        loaded = False
        def is_downloaded(self): return True
        def is_loaded(self): return self.loaded
        def load(self): self.loaded = True
        def unload(self): self.loaded = False
        def generate(self, *args): return Path('/inert/direct.glb')
        @property
        def readiness_status(self):
            accesses.append('getter')
            def hook():
                entered.set()
                assert release.wait(2)
                return {'ok': True, 'machine_code': 'ready'}
            return hook

    registry = _registry('a/node', DirectGenerator())
    context = registry._legacy_imports.register(tmp_path)
    for model_id in ['a/node', 'b/node']:
        registry._generators[model_id] = _LegacyGeneratorProxy(
            DirectGenerator(), registry._legacy_imports, context)
        registry._manifests[model_id] = {'id': model_id}
    registry._runtime_readiness_timeout_seconds = 0.5
    original_activate = registry._legacy_imports.activate
    def activate(context):
        activations.append(threading.get_ident())
        return original_activate(context)
    monkeypatch.setattr(registry._legacy_imports, 'activate', activate)
    lock_started, lock_done = threading.Event(), threading.Event()
    lock_results = {}
    def probe_locks():
        lock_started.set()
        try:
            for name, lock in [('lifecycle', registry._lifecycle_lock), ('imports', registry._legacy_imports._lock)]:
                acquired = lock.acquire(blocking=False)
                lock_results[name] = acquired
                if acquired:
                    lock.release()
        except Exception as exc:
            failures.append(exc)
        finally:
            lock_done.set()
    status_started, status_done = threading.Event(), threading.Event()
    unload_started, unload_done = threading.Event(), threading.Event()
    def control(action, started, done):
        started.set()
        try:
            action()
        except Exception as exc:
            failures.append(exc)
        finally:
            done.set()
    threads = []
    try:
        result = registry.runtime_readiness(['a/node'])['a/node']
        assert result['machine_code'] == 'unsupported_contract'
        assert result['ok'] is False
        assert not entered.is_set() and accesses == [] and activations == []
        # Probe the actual RLocks from another thread before controls perform
        # their legitimate import work. Same-thread acquisition is reentrant.
        probe = threading.Thread(target=probe_locks, name='readiness-lock-probe')
        threads.append(probe)
        probe.start()
        assert lock_started.wait(1), 'lock probe was not scheduled'
        assert lock_done.wait(1), 'nonblocking lock probe did not settle'
        assert lock_results == {'lifecycle': True, 'imports': True}
        for action, started, done in [
            (lambda: registry.model_status('b/node'), status_started, status_done),
            (lambda: registry.unload_all(rebind_paths=False), unload_started, unload_done),
        ]:
            thread = threading.Thread(target=control, args=(action, started, done))
            threads.append(thread)
            thread.start()
        assert status_started.wait(1) and unload_started.wait(1), 'control thread was not scheduled'
        print(f'direct diagnostic: hook_entered={entered.is_set()}, locks={lock_results}')
    finally:
        release.set()
        for thread in threads:
            thread.join(2)
        settlement = threading.Thread(target=lambda: registry._runtime_readiness_executor.shutdown(wait=True),
                                      name='readiness-executor-settlement')
        settlement.start()
        settlement.join(2)
        threads.append(settlement)
    assert not [thread.name for thread in threads if thread.is_alive()], 'fixture owners did not settle'
    assert not failures
    # Functional completion is distinct from diagnostic lock ownership; real
    # proxy controls may spend time resolving modules during import isolation.
    assert status_done.is_set() and unload_done.is_set()
    # Unsupported diagnostics do not narrow ordinary direct model use.
    direct = registry.get_ready_generator('b/node')
    assert direct.is_loaded()
    assert direct.generate(b'', {}) == Path('/inert/direct.glb')
    assert registry._active_id == 'a/node'
    monkeypatch.setattr(registry, 'initialize', lambda *args: None)
    registry.reload()
    assert registry._generators == {}

    # Even an unwrapped in-process object must not have its optional getter read.
    plain = _registry('plain/node', DirectGenerator())
    try:
        assert plain.runtime_readiness(['plain/node'])['plain/node']['machine_code'] == 'unsupported_contract'
        assert accesses == []
    finally:
        plain._runtime_readiness_executor.shutdown(wait=True)
