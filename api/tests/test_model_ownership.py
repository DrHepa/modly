import importlib
from itertools import permutations
import json
import sys
from pathlib import Path

import pytest

import services.generator_registry as registry_module
from services.extension_process import ExtensionProcess
from services.generator_registry import GeneratorRegistry


API_DIR = Path(__file__).resolve().parents[1]
FIXTURES_DIR = API_DIR.parent / "tests" / "fixtures" / "bundled-image-models"


def _read_bundle_fixture_manifest() -> dict:
    return json.loads((FIXTURES_DIR / "image-bundle.manifest.json").read_text(encoding="utf-8"))


def _write_extension_bundle(extensions_dir: Path) -> Path:
    ext_dir = extensions_dir / "image-bundle"
    ext_dir.mkdir(parents=True)
    manifest = _read_bundle_fixture_manifest()
    (ext_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (ext_dir / "generator.py").write_text(
        """
from pathlib import Path
from services.generators.base import BaseGenerator


class DummyGenerator(BaseGenerator):
    DISPLAY_NAME = "Dummy Generator"
    VRAM_GB = 1

    def load(self) -> None:
        self._model = object()

    def generate(self, image_bytes: bytes, params: dict, progress_cb=None, cancel_event=None) -> Path:
        output_path = self.outputs_dir / "dummy.glb"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(image_bytes or b"glb")
        return output_path
""".strip(),
        encoding="utf-8",
    )
    return ext_dir


def _build_registry(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[GeneratorRegistry, Path, Path, Path]:
    models_dir = tmp_path / "models"
    workspace_dir = tmp_path / "workspace"
    extensions_dir = tmp_path / "extensions"
    models_dir.mkdir()
    workspace_dir.mkdir()
    extensions_dir.mkdir()

    monkeypatch.setattr(registry_module, "MODELS_DIR", models_dir)
    monkeypatch.setattr(registry_module, "WORKSPACE_DIR", workspace_dir)
    monkeypatch.setattr(registry_module, "EXTENSIONS_DIR", extensions_dir)
    return GeneratorRegistry(), models_dir, workspace_dir, extensions_dir


def test_initialize_registers_owner_aware_model_paths_and_metadata(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    registry, models_dir, _, extensions_dir = _build_registry(monkeypatch, tmp_path)
    _write_extension_bundle(extensions_dir)

    registry.initialize()

    sd15_manifest = registry.get_manifest("image-bundle/sd15")
    sdxl_manifest = registry.get_manifest("image-bundle/sdxl-base")
    flux_manifest = registry.get_manifest("image-bundle/flux-schnell")

    assert sd15_manifest["id"] == "image-bundle/sd15"
    assert sd15_manifest["weight_owner_id"] == "image-bundle/shared-base"
    assert sd15_manifest["shared_owner"] is True
    assert sd15_manifest["legacy_paths"] == ["image-bundle/sd15", "image-bundle/sdxl-base"]
    assert sdxl_manifest["weight_owner_id"] == "image-bundle/shared-base"
    assert sdxl_manifest["legacy_paths"] == ["image-bundle/sd15", "image-bundle/sdxl-base"]
    assert flux_manifest["weight_owner_id"] == "image-bundle/flux-schnell"
    assert flux_manifest["shared_owner"] is False
    assert flux_manifest["legacy_paths"] == ["image-bundle/flux-schnell"]

    assert registry.get_generator("image-bundle/sd15").model_dir == models_dir / "image-bundle/shared-base"
    assert registry.get_generator("image-bundle/sdxl-base").model_dir == models_dir / "image-bundle/shared-base"
    assert registry.get_generator("image-bundle/flux-schnell").model_dir == models_dir / "image-bundle/flux-schnell"


def test_node_manifest_projects_ordered_inputs_instead_of_extension_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    registry, _, _, extensions_dir = _build_registry(monkeypatch, tmp_path)
    ext_dir = _write_extension_bundle(extensions_dir)
    manifest_path = ext_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["inputs"] = [{"name": "image", "type": "image", "required": True}]
    manifest["nodes"][0]["inputs"] = ["image", "image", "image", "image"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    registry.initialize()

    assert registry.get_manifest("image-bundle/sd15")["inputs"] == ["image"] * 4
    assert registry.get_manifest("image-bundle/sdxl-base")["inputs"] is None


def test_readiness_uses_owner_path_with_legacy_fallback(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    registry, models_dir, _, extensions_dir = _build_registry(monkeypatch, tmp_path)
    _write_extension_bundle(extensions_dir)
    legacy_dir = models_dir / "image-bundle/sdxl-base/weights"
    legacy_dir.mkdir(parents=True)
    (legacy_dir / "model.safetensors").write_bytes(b"legacy")

    registry.initialize()

    status_by_id = {entry["id"]: entry for entry in registry.all_status()}
    assert registry.resolve_active_model_dir("image-bundle/sd15") == models_dir / "image-bundle/sdxl-base"
    assert status_by_id["image-bundle/sd15"]["downloaded"] is True
    assert status_by_id["image-bundle/sdxl-base"]["downloaded"] is True
    assert status_by_id["image-bundle/flux-schnell"]["downloaded"] is False

    canonical_dir = models_dir / "image-bundle/shared-base/weights"
    canonical_dir.mkdir(parents=True)
    (canonical_dir / "model.safetensors").write_bytes(b"canonical")

    assert registry.resolve_active_model_dir("image-bundle/sd15") == models_dir / "image-bundle/shared-base"


def test_extension_process_and_runner_keep_capability_id_with_owner_model_dir(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    _, models_dir, workspace_dir, extensions_dir = _build_registry(monkeypatch, tmp_path)
    ext_dir = _write_extension_bundle(extensions_dir)
    owner_model_dir = models_dir / "image-bundle/shared-base"

    process = ExtensionProcess(
        ext_dir,
        {
            "id": "image-bundle/sdxl-base",
            "ext_id": "image-bundle",
            "node_id": "sdxl-base",
            "hf_repo": "acme/sdxl-base",
            "download_check": "weights/model.safetensors",
            "weight_owner_id": "image-bundle/shared-base",
            "legacy_paths": ["image-bundle/sd15", "image-bundle/sdxl-base"],
        },
    )
    process.model_dir = owner_model_dir

    env = process._build_env()
    assert env["MODEL_DIR"] == str(owner_model_dir)
    assert env["MODEL_ID"] == "image-bundle/sdxl-base"

    monkeypatch.setenv("EXTENSION_DIR", str(ext_dir))
    monkeypatch.setenv("MODELS_DIR", str(models_dir))
    monkeypatch.setenv("WORKSPACE_DIR", str(workspace_dir))
    monkeypatch.setenv("MODLY_API_DIR", str(API_DIR))
    monkeypatch.setenv("MODEL_DIR", str(owner_model_dir))
    monkeypatch.setenv("MODEL_ID", "image-bundle/sdxl-base")
    sys.modules.pop("runner", None)
    runner_module = importlib.import_module("runner")

    manifest = json.loads((ext_dir / "manifest.json").read_text(encoding="utf-8"))
    node, model_dir = runner_module.resolve_runner_context(manifest)

    assert node["id"] == "sdxl-base"
    assert node["hf_repo"] == "acme/sdxl-base"
    assert model_dir == owner_model_dir


def test_extension_process_load_ignores_stale_unloaded_ack(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    process = ExtensionProcess(tmp_path, {"id": "kimodo-soma-rp/animate-rigged-mesh"})
    responses = iter([
        {"type": "unloaded"},
        {"type": "loaded"},
    ])
    sent: list[dict] = []

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


def test_reload_keeps_bundled_fixture_capabilities_ready_across_legacy_and_canonical_layouts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    registry, models_dir, _, extensions_dir = _build_registry(monkeypatch, tmp_path)
    _write_extension_bundle(extensions_dir)

    legacy_dir = models_dir / "image-bundle/sdxl-base/weights"
    legacy_dir.mkdir(parents=True)
    (legacy_dir / "model.safetensors").write_bytes(b"legacy")

    registry.initialize()
    legacy_status_by_id = {entry["id"]: entry for entry in registry.all_status()}

    assert set(legacy_status_by_id) == {
        "image-bundle/sd15",
        "image-bundle/sdxl-base",
        "image-bundle/flux-schnell",
    }
    assert legacy_status_by_id["image-bundle/sd15"]["downloaded"] is True
    assert legacy_status_by_id["image-bundle/sdxl-base"]["downloaded"] is True
    assert legacy_status_by_id["image-bundle/flux-schnell"]["downloaded"] is False

    canonical_dir = models_dir / "image-bundle/shared-base/weights"
    canonical_dir.mkdir(parents=True)
    (canonical_dir / "model.safetensors").write_bytes(b"canonical")

    registry.reload()
    reloaded_status_by_id = {entry["id"]: entry for entry in registry.all_status()}

    assert registry.resolve_active_model_dir("image-bundle/sd15") == models_dir / "image-bundle/shared-base"
    assert registry.resolve_active_model_dir("image-bundle/sdxl-base") == models_dir / "image-bundle/shared-base"
    assert reloaded_status_by_id["image-bundle/sd15"]["downloaded"] is True
    assert reloaded_status_by_id["image-bundle/sdxl-base"]["downloaded"] is True


def test_owner_alias_keeps_source_and_shared_group_readiness_independent(monkeypatch, tmp_path):
    registry, models_dir, _, extensions_dir = _build_registry(monkeypatch, tmp_path)
    ext_dir = _write_extension_bundle(extensions_dir)
    manifest = json.loads((ext_dir / 'manifest.json').read_text())
    source = {'id': 'base', 'provider': 'huggingface', 'repo_id': 'acme/base',
              'destination': '.', 'checks': ['weights.bin']}
    manifest['weight_groups'] = [{'id': 'common', 'model_sources': [source]}]
    manifest['nodes'] = [
        {'id': 'a', 'weight_owner_id': 'private', 'model_sources': [source], 'weight_groups': ['common']},
        {'id': 'b', 'weight_owner_id': 'private', 'model_sources': [source]},
    ]
    (ext_dir / 'manifest.json').write_text(json.dumps(manifest))
    legacy = models_dir / 'image-bundle/b'
    legacy.mkdir(parents=True)
    (legacy / 'weights.bin').write_bytes(b'private')
    registry.initialize()
    assert registry.model_status('image-bundle/b')['downloaded'] is True
    assert registry.model_status('image-bundle/a')['downloaded'] is False
    gen = registry.get_generator('image-bundle/a')
    group = models_dir / 'image-bundle/_shared/common'
    assert gen.model_dir == legacy
    assert gen.shared_model_dirs == {'common': group}
    group.mkdir(parents=True)
    (group / 'weights.bin').write_bytes(b'shared')
    assert registry.model_status('image-bundle/a')['downloaded'] is True
    assert (legacy / 'weights.bin').read_bytes() == b'private'
    assert not (models_dir / 'image-bundle/private').exists()


def test_runner_explicit_node_id_wins_over_capability_and_owner_path(monkeypatch, tmp_path):
    monkeypatch.setenv('EXTENSION_DIR', str(tmp_path))
    monkeypatch.setenv('MODEL_ID', 'image-bundle/sd15')
    monkeypatch.setenv('MODEL_NODE_ID', 'sdxl-base')
    monkeypatch.setenv('MODEL_DIR', str(tmp_path / 'shared-base'))
    sys.modules.pop('runner', None)
    runner_module = importlib.import_module('runner')
    node, root = runner_module.resolve_runner_context(_read_bundle_fixture_manifest())
    assert node['id'] == 'sdxl-base'
    assert root == tmp_path / 'shared-base'


@pytest.mark.parametrize('owner', ['../other', '/tmp/escape', '_shared', 'CON'])
def test_invalid_owner_is_not_registered(monkeypatch, tmp_path, owner):
    registry, _, _, extensions_dir = _build_registry(monkeypatch, tmp_path)
    ext_dir = _write_extension_bundle(extensions_dir)
    manifest = json.loads((ext_dir / 'manifest.json').read_text())
    manifest['nodes'][0]['weight_owner_id'] = owner
    (ext_dir / 'manifest.json').write_text(json.dumps(manifest))
    registry.initialize()
    assert 'image-bundle/sd15' in registry.load_errors()


def test_owner_path_cannot_alias_another_owners_legacy_capability(monkeypatch, tmp_path):
    registry, _, _, extensions_dir = _build_registry(monkeypatch, tmp_path)
    ext_dir = _write_extension_bundle(extensions_dir)
    manifest = json.loads((ext_dir / 'manifest.json').read_text())
    manifest['nodes'][0]['weight_owner_id'] = 'sdxl-base'
    (ext_dir / 'manifest.json').write_text(json.dumps(manifest))
    registry.initialize()
    assert 'image-bundle/sd15' in registry.load_errors()


@pytest.mark.parametrize('nodes', [
    [{'id': 'a', 'weight_owner_id': 'Shared'}, {'id': 'b', 'weight_owner_id': 'shared'}],
    [{'id': 'a', 'weight_owner_id': 'B'}, {'id': 'b', 'weight_owner_id': 'other'}],
    [{'id': 'a', 'weight_owner_id': 'A'}],
    [{'id': 'A', 'weight_owner_id': 'shared'}, {'id': 'a', 'weight_owner_id': 'shared'}],
])
def test_portable_owner_and_alias_collisions_are_not_registered(monkeypatch, tmp_path, nodes):
    registry, _, _, extensions_dir = _build_registry(monkeypatch, tmp_path)
    ext = _write_extension_bundle(extensions_dir)
    manifest = json.loads((ext / 'manifest.json').read_text())
    manifest['nodes'] = nodes
    (ext / 'manifest.json').write_text(json.dumps(manifest))
    registry.initialize()
    assert not registry._generators
    assert registry.load_errors()
    assert any('portable' in error or 'overlap' in error for error in registry.load_errors().values())


def test_exact_owner_sharing_preserves_declared_spelling(monkeypatch, tmp_path):
    registry, _, _, extensions_dir = _build_registry(monkeypatch, tmp_path)
    ext = _write_extension_bundle(extensions_dir)
    manifest = json.loads((ext / 'manifest.json').read_text())
    manifest['nodes'] = [{'id': node, 'weight_owner_id': 'Shared'} for node in ['a', 'b']]
    (ext / 'manifest.json').write_text(json.dumps(manifest))
    registry.initialize()
    assert not registry.load_errors()
    for node in ['a', 'b']:
        metadata = registry.get_manifest('image-bundle/' + node)
        assert metadata['weight_owner_id'] == 'image-bundle/Shared'
        assert metadata['shared_owner'] is True


@pytest.fixture(params=['process', 'direct'])
def bound_owner_runtime(request, monkeypatch, tmp_path):
    """Real dummy runner/direct adapter, no BaseGenerator unload/Torch or downloads."""
    import signal
    if not hasattr(signal, 'SIGALRM'):
        pytest.skip('bounded dummy runner fixture requires POSIX alarm')
    mode, _, contract = request.param.partition(':')
    registry, models, workspace, extensions = _build_registry(monkeypatch, tmp_path)
    ext = extensions / 'demo'
    ext.mkdir()
    variants = {'param': 'variant', 'default': 'old', 'options': [
        {'id': name, 'label': name, 'include_prefixes': [name + '/'], 'checks': [name + '/weights.bin']}
        for name in ['old', 'new']
    ]}
    manifest = {'id': 'demo', 'type': 'model', 'generator_class': 'Dummy',
                'params_schema': [{'id': 'variant', 'type': 'select', 'options': ['old', 'new']}],
                'nodes': [{'id': 'a', 'weight_owner_id': 'owner', 'hf_repo': 'org/model',
                           'download_check': 'payload.txt', 'weight_variants': variants}]}
    if contract == 'source':
        manifest['nodes'][0] = {'id': 'a', 'weight_owner_id': 'owner', 'model_sources': [
            {'id': 's', 'provider': 'huggingface', 'repo_id': 'org/model',
             'destination': '.', 'checks': ['payload.txt']},
        ]}
    (ext / 'manifest.json').write_text(json.dumps(manifest))
    (ext / 'generator.py').write_text('''import json, time
from pathlib import Path
class Dummy:
    DISPLAY_NAME = 'CPU ownership fixture'
    VRAM_GB = 0
    def __init__(self, model_dir, outputs_dir):
        self.model_dir = model_dir
        self.constructor_root = model_dir
        self.outputs_dir = outputs_dir
        self.loaded = False
    @staticmethod
    def params_schema(): return []
    def is_downloaded(self): return (self.model_dir / 'payload.txt').is_file()
    def is_loaded(self): return self.loaded
    def load(self): self.loaded = True
    def unload(self): self.loaded = False
    def _auto_download(self): raise AssertionError('No fixture downloads allowed')
    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):
        if params.get('wait'):
            (self.outputs_dir / 'entered').write_text('entered')
            deadline = time.monotonic() + 4
            while not (self.outputs_dir / 'release').exists():
                if time.monotonic() > deadline: raise TimeoutError('fixture release deadline')
                time.sleep(0.01)
        p = self.outputs_dir / 'result.json'
        p.write_text(json.dumps({'root': str(self.model_dir), 'constructor_root': str(self.constructor_root),
                                'payload': (self.constructor_root / 'payload.txt').read_text()}))
        return p
''')
    if mode == 'process':
        python = ext / 'venv/bin/python'
        python.parent.mkdir(parents=True)
        python.symlink_to(sys.executable)
    def refuse_install(*args):
        raise AssertionError('No fixture package installs allowed')
    monkeypatch.setattr(ExtensionProcess, '_install_missing_package', refuse_install)
    owned = []
    start = ExtensionProcess._start
    def tracked_start(gen):
        try:
            return start(gen)
        finally:
            if gen._proc is not None:
                owned.append(gen._proc)
    monkeypatch.setattr(ExtensionProcess, '_start', tracked_start)
    legacy, canonical = models / 'demo/a', models / 'demo/owner'
    (legacy / 'old').mkdir(parents=True)
    (legacy / 'payload.txt').write_text('legacy')
    (legacy / 'old/weights.bin').write_text('old')
    previous = signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('12s fixture deadline')))
    signal.alarm(12)
    try:
        registry.initialize()
        yield registry, legacy, canonical, workspace, mode
    finally:
        # Only processes created by this fixture; no process discovery or user signals.
        for gen in registry._generators.values():
            if isinstance(gen, ExtensionProcess):
                gen.stop()
        for proc in owned:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2)
            assert proc.poll() is not None
            print(f'OWNED_CPU_CHILD_REAPED pid={proc.pid} returncode={proc.returncode}')
        registry._remove_legacy_paths()
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def _create_preferred_fixture_root(canonical):
    (canonical / 'new').mkdir(parents=True)
    (canonical / 'payload.txt').write_text('canonical')
    (canonical / 'new/weights.bin').write_text('new')


@pytest.mark.parametrize('cooperative_unload', [False, True])
def test_bound_root_stays_coherent_until_real_unload_route(bound_owner_runtime, monkeypatch, cooperative_unload):
    import asyncio
    from routers import model as model_router
    registry, legacy, canonical, _, mode = bound_owner_runtime
    monkeypatch.setattr(model_router, 'generator_registry', registry)
    gen = registry.get_ready_generator('demo/a')
    child = gen._proc if mode == 'process' else None
    _create_preferred_fixture_root(canonical)
    if cooperative_unload:
        gen.unload()
    status = registry.model_status('demo/a')
    assert gen.model_dir == legacy
    assert status['loaded'] is (not cooperative_unload)
    registry.assert_weight_variant_installed({'variant': 'old'}, 'demo/a')
    with pytest.raises(RuntimeError, match='new weights'):
        registry.assert_weight_variant_installed({'variant': 'new'}, 'demo/a')
    (legacy / 'payload.txt').unlink()
    assert registry.model_status('demo/a')['downloaded'] is False
    assert registry.all_status()[0]['downloaded'] is False
    (legacy / 'payload.txt').write_text('legacy')
    ready = registry.get_ready_generator('demo/a')
    assert json.loads(ready.generate(b'', {}).read_text())['payload'] == 'legacy'
    if child:
        assert ready._proc is child and child.poll() is None
    assert asyncio.run(model_router.unload_model('demo/a')) == {'unloaded': True}
    assert gen.model_dir == canonical
    assert not gen.is_loaded()
    if child:
        assert child.poll() is not None
    registry.assert_weight_variant_installed({'variant': 'new'}, 'demo/a')
    with pytest.raises(RuntimeError, match='old weights'):
        registry.assert_weight_variant_installed({'variant': 'old'}, 'demo/a')
    ready = registry.get_ready_generator('demo/a')
    output = json.loads(ready.generate(b'', {}).read_text())
    assert output == {'root': str(canonical), 'constructor_root': str(canonical), 'payload': 'canonical'}


@pytest.mark.parametrize('transition', ['unload_all', 'reload', 'update_paths'])
def test_explicit_registry_transitions_rebind_constructor_and_readiness(bound_owner_runtime, transition):
    registry, legacy, canonical, _, mode = bound_owner_runtime
    gen = registry.get_ready_generator('demo/a')
    child = gen._proc if mode == 'process' else None
    _create_preferred_fixture_root(canonical)
    if transition == 'update_paths':
        registry.update_paths(registry_module.MODELS_DIR, None)
    else:
        getattr(registry, transition)()
    if child:
        assert child.poll() is not None
    ready = registry.get_ready_generator('demo/a')
    output = json.loads(ready.generate(b'', {}).read_text())
    assert output['constructor_root'] == str(canonical)
    assert output['payload'] == 'canonical'


@pytest.mark.parametrize('bound_owner_runtime', ['process'], indirect=True)
def test_status_during_real_generation_does_not_retarget_or_interrupt(bound_owner_runtime):
    import threading
    import time
    registry, legacy, canonical, workspace, mode = bound_owner_runtime
    gen = registry.get_ready_generator('demo/a')
    child = gen._proc
    result, errors = [], []
    def generate():
        try:
            result.append(json.loads(gen.generate(b'', {'wait': True}).read_text()))
        except BaseException as exc:
            errors.append(exc)
    worker = threading.Thread(target=generate)
    worker.start()
    try:
        deadline = time.monotonic() + 3
        while not (workspace / 'entered').exists():
            assert time.monotonic() < deadline, 'generation did not enter fixture'
            time.sleep(0.01)
        _create_preferred_fixture_root(canonical)
        assert registry.model_status('demo/a')['loaded'] is True
        registry.all_status()
        assert gen.model_dir == legacy
        assert gen._proc is child and child.poll() is None
    finally:
        (workspace / 'release').write_text('release')
        worker.join(3)
    assert not worker.is_alive()
    assert not errors
    assert result[0]['payload'] == 'legacy'


@pytest.mark.parametrize('bound_owner_runtime', ['process'], indirect=True)
def test_scoped_unload_route_waits_for_lifecycle_without_blocking_event_loop(bound_owner_runtime, monkeypatch):
    import asyncio
    import threading
    from routers import model as model_router
    registry, _, canonical, _, _ = bound_owner_runtime
    monkeypatch.setattr(model_router, 'generator_registry', registry)
    registry.get_ready_generator('demo/a')
    _create_preferred_fixture_root(canonical)
    held, release = threading.Event(), threading.Event()
    def hold_lifecycle():
        with registry._lifecycle_lock:
            held.set()
            release.wait(2)
    holder = threading.Thread(target=hold_lifecycle)
    holder.start()
    assert held.wait(2)
    async def run():
        task = asyncio.create_task(model_router.unload_model('demo/a'))
        try:
            await asyncio.sleep(0.05)
            assert not task.done(), 'scoped unload blocked the event loop while waiting for lifecycle'
        finally:
            release.set()
            await asyncio.wait_for(task, 3)
    try:
        asyncio.run(run())
    finally:
        release.set()
        holder.join(3)
    assert not holder.is_alive()
    assert registry.get_generator('demo/a').model_dir == canonical


@pytest.mark.parametrize('bound_owner_runtime', ['process:source', 'direct:source'], indirect=True)
def test_source_readiness_stays_on_bound_runtime_root(bound_owner_runtime):
    registry, legacy, canonical, _, _ = bound_owner_runtime
    gen = registry.get_ready_generator('demo/a')
    _create_preferred_fixture_root(canonical)
    (legacy / 'payload.txt').unlink()
    assert registry.model_status('demo/a')['downloaded'] is False
    assert gen.model_dir == legacy
    (legacy / 'payload.txt').write_text('legacy')
    registry.unload_all()
    assert registry.model_status('demo/a')['downloaded'] is True
    assert json.loads(registry.get_ready_generator('demo/a').generate(b'', {}).read_text())['payload'] == 'canonical'


def test_free_memory_endpoint_adopts_preferred_root_after_confirmed_release(bound_owner_runtime, monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from routers import model as model_router
    registry, _, canonical, _, mode = bound_owner_runtime
    monkeypatch.setattr(model_router, 'generator_registry', registry)
    llm_calls = []
    # Exercise the real Free Memory route without touching any user LLM runtime.
    monkeypatch.setitem(sys.modules, 'services.llm_server', SimpleNamespace(
        llama_pool=SimpleNamespace(unload_all=lambda: llm_calls.append('unload')),
    ))
    gen = registry.get_ready_generator('demo/a')
    child = gen._proc if mode == 'process' else None
    _create_preferred_fixture_root(canonical)
    assert asyncio.run(model_router.unload_all_models()) == {'unloaded': True}
    assert llm_calls == ['unload']
    if child:
        assert child.poll() is not None
    assert gen.model_dir == canonical
    assert registry.model_status('demo/a')['loaded'] is False
    ready = registry.get_ready_generator('demo/a')
    assert json.loads(ready.generate(b'', {}).read_text())['constructor_root'] == str(canonical)


@pytest.mark.parametrize('failure, concurrent_status', [
    ('constructor', False), ('metadata', False), (None, False), (None, True),
])
def test_changed_model_root_is_prepared_for_all_direct_adapters_before_publication(monkeypatch, tmp_path, failure, concurrent_status):
    import signal
    if not hasattr(signal, 'SIGALRM'):
        pytest.skip('POSIX bounded direct fixture')
    registry, old, work, extensions = _build_registry(monkeypatch, tmp_path)
    new, new_work = tmp_path / 'new-models', tmp_path / 'new-workspace'
    new.mkdir()
    previous = signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('12s atomic path fixture deadline')))
    signal.alarm(12)
    try:
        for name in ['first', 'second']:
            ext = extensions / name
            ext.mkdir()
            source = {'id': 'weights', 'provider': 'huggingface', 'repo_id': 'org/model',
                      'destination': '.', 'checks': ['payload.txt']}
            (ext / 'manifest.json').write_text(json.dumps({
                'id': name, 'type': 'model', 'generator_class': 'AtomicDummy',
                'weight_groups': [{'id': 'base', 'model_sources': [source]}],
                'nodes': [{'id': 'a', 'weight_owner_id': 'owner',
                           'model_sources': [source], 'weight_groups': ['base']}],
            }))
            (ext / 'generator.py').write_text('''from pathlib import Path
class AtomicDummy:
    DISPLAY_NAME = 'Atomic CPU fixture'
    VRAM_GB = 0
    def __init__(self, model_dir, outputs_dir):
        if 'check_preparation' in globals(): check_preparation()
        self.model_dir = self.constructor_root = model_dir
        self.outputs_dir = self.constructor_outputs = outputs_dir
        self.loaded = False
        flag = model_dir.parent.parent / 'fail-constructor'
        if model_dir.parent.name == 'second' and flag.exists():
            raise RuntimeError('second constructor failed')
    def __setattr__(self, name, value):
        if name == 'shared_model_dirs' and 'check_preparation' in globals(): check_preparation()
        if name == 'shared_model_dirs' and value and any((root.parents[2] / 'fail-metadata').exists() for root in value.values()):
            if self.model_dir.parent.name == 'second':
                raise RuntimeError('second metadata setter failed')
        object.__setattr__(self, name, value)
    def load(self): self.loaded = True
    def unload(self): self.loaded = False
    def is_loaded(self): return self.loaded
    def is_downloaded(self): return (self.model_dir / 'payload.txt').is_file()
    def params_schema(self): return []
    def generate(self, image_bytes, params):
        return self.constructor_root / 'payload.txt'
''')
            for root, content in [(old, 'old'), (new, 'new')]:
                for rel in [f'{name}/owner', f'{name}/_shared/base']:
                    path = root / rel
                    path.mkdir(parents=True)
                    (path / 'payload.txt').write_text(content)
        registry.initialize()
        gens = {name: registry.get_ready_generator(name + '/a') for name in ['first', 'second']}
        targets = {name: object.__getattribute__(gen, '_target') for name, gen in gens.items()}
        def check_preparation():
            # Hook -> status takes publication after import isolation. The
            # inverse is forbidden; publication must never wait for a hook.
            assert not registry._path_publication_lock.locked()
            assert registry_module.MODELS_DIR == old
            assert registry_module.WORKSPACE_DIR == work
            assert registry.model_status('first/a')['downloaded'] is True
        if failure:
            # Reentrant hooks and the publication barrier have separate cases.
            for target in targets.values():
                type(target).__init__.__globals__['check_preparation'] = check_preparation
        if failure:
            (new / ('fail-' + failure)).write_text('reject')
            with pytest.raises(RuntimeError, match='second .* failed'):
                registry.update_paths(new, new_work)
            assert registry_module.MODELS_DIR == old
            assert registry_module.WORKSPACE_DIR == work
            for name, gen in gens.items():
                assert object.__getattribute__(gen, '_target') is targets[name]
                assert gen.model_dir == old / name / 'owner'
                assert gen.outputs_dir == work
                assert gen.shared_model_dirs == {'base': old / name / '_shared/base'}
                assert not gen.is_loaded()
                assert registry.model_status(name + '/a')['downloaded'] is True
                assert registry.get_ready_generator(name + '/a').generate(b'', {}).read_text() == 'old'
            (new / ('fail-' + failure)).unlink()
        if concurrent_status:
            # The registry classifies the second adapter before publishing it.
            # A test-only wrapper places an explicit barrier there, after the
            # first target swap, with no import lock held. No line tracing.
            import builtins
            import concurrent.futures
            import threading
            publishing, release, reading, read_done = (threading.Event() for _ in range(4))
            updater_ident = []
            def classify_with_publication_barrier(value, kind):
                if (updater_ident and threading.get_ident() == updater_ident[0]
                    and value is gens['second'] and kind is registry_module._LegacyGeneratorProxy
                    and object.__getattribute__(gens['first'], '_target') is not targets['first']
                    and object.__getattribute__(gens['second'], '_target') is targets['second']
                    and not publishing.is_set()):
                    assert not registry._legacy_imports._lock._is_owned()
                    publishing.set()
                    if not release.wait(2):
                        raise TimeoutError('publication release deadline')
                return builtins.isinstance(value, kind)
            monkeypatch.setattr(registry_module, 'isinstance', classify_with_publication_barrier, raising=False)
            def update():
                updater_ident.append(threading.get_ident())
                registry.update_paths(new, new_work)
            def status():
                reading.set()
                try:
                    return registry.model_status('second/a')
                finally:
                    read_done.set()
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                updating = executor.submit(update)
                try:
                    assert publishing.wait(6)
                    checking = executor.submit(status)
                    assert reading.wait(2)
                    if read_done.wait(0.05):
                        checking.result(timeout=2)
                        pytest.fail('Status escaped a partially published path update')
                finally:
                    release.set()
                updating.result(timeout=2)
                assert checking.result(timeout=2)['downloaded'] is True
        else:
            registry.update_paths(new, new_work)
        assert registry_module.MODELS_DIR == new
        assert registry_module.WORKSPACE_DIR == new_work
        for name, gen in gens.items():
            assert object.__getattribute__(gen, '_target') is not targets[name]
            assert gen.constructor_root == gen.model_dir == new / name / 'owner'
            assert gen.constructor_outputs == gen.outputs_dir == new_work
            assert gen.shared_model_dirs == {'base': new / name / '_shared/base'}
            assert gen.MODEL_ID == name + '/a'
            assert not gen.is_loaded()
            assert registry.model_status(name + '/a')['downloaded'] is True
            assert registry.get_ready_generator(name + '/a').generate(b'', {}).read_text() == 'new'
            assert (old / name / 'owner/payload.txt').read_text() == 'old'
            assert (new / name / 'owner/payload.txt').read_text() == 'new'
    finally:
        registry._remove_legacy_paths()
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


@pytest.mark.parametrize('bound_owner_runtime', ['process:source'], indirect=True)
def test_changed_model_root_stops_then_restarts_bound_child(bound_owner_runtime):
    registry, legacy, _, workspace, _ = bound_owner_runtime
    gen = registry.get_ready_generator('demo/a')
    child = gen._proc
    new_models, new_workspace = workspace.parent / 'different-models', workspace.parent / 'different-workspace'
    private = new_models / 'demo/owner'
    private.mkdir(parents=True)
    (private / 'payload.txt').write_text('new root')
    registry.update_paths(new_models, new_workspace)
    assert child.poll() is not None
    assert gen._proc is None
    assert gen.model_dir == private
    assert not registry.model_status('demo/a')['loaded']
    result = json.loads(registry.get_ready_generator('demo/a').generate(b'', {}).read_text())
    assert result == {'root': str(private), 'constructor_root': str(private), 'payload': 'new root'}
    assert gen.outputs_dir == new_workspace


# N1 discovery describes exact legacy identities; it does not provision weights.
_N1_CASE_SPELLINGS = ("foo", "foO", "fOo", "fOO", "Foo", "FoO", "FOo", "FOO")
_N1_CASE_ORDERS = tuple(
    order[offset:] + order[:offset]
    for order in (_N1_CASE_SPELLINGS, tuple(reversed(_N1_CASE_SPELLINGS)))
    for offset in range(len(order))
)
_N1_SOURCE = {
    "id": "payload", "provider": "huggingface", "repo_id": "org/model",
    "destination": ".", "checks": ["weights.bin"],
}
_N1_LEGACY_METADATA = {
    "plain": {},
    "hf": {"hf_repo": "org/model", "download_check": "base.bin"},
    "variants": {
        "hf_repo": "org/model", "download_check": "base.bin",
        "params_schema": [{"id": "variant", "type": "select", "options": ["small"]}],
        "weight_variants": {
            "param": "variant", "default": "small",
            "options": [{"id": "small", "label": "small", "include_prefixes": ["small/"], "checks": ["small/weights.bin"]}],
        },
    },
    "structured": {
        "hf_downloads": [{
            "repo_id": "org/model", "revision": "a" * 40, "target_subdir": "assets",
            "files": [{"path": "weights.bin"}],
        }],
    },
}


def _n1_discover_manifest(monkeypatch, tmp_path, nodes, *, setup_required=False, empty_models=False, weight_groups=None):
    extensions = tmp_path / "extensions"
    extension = extensions / "n1-legacy-cases"
    extension.mkdir(parents=True)
    models = tmp_path / "models"
    if empty_models:
        models.mkdir()
    manifest = {
        "id": "n1-legacy-cases", "type": "model",
        "generator_class": "N1DiscoveryFixture", "nodes": nodes,
    }
    if weight_groups is not None:
        manifest["weight_groups"] = weight_groups
    (extension / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (extension / "generator.py").write_text("class N1DiscoveryFixture: pass\n", encoding="utf-8")
    if setup_required:
        (extension / "setup.py").write_text("raise AssertionError('Discovery must not run setup')\n", encoding="utf-8")
    monkeypatch.setattr(registry_module, "EXTENSIONS_DIR", extensions)
    monkeypatch.setattr(registry_module, "MODELS_DIR", models)
    monkeypatch.setattr(registry_module, "WORKSPACE_DIR", tmp_path / "workspace")
    manager = registry_module._LegacyImportManager()
    try:
        # Actual CURRENT interface: manager argument and four-element entries.
        discovered, errors = registry_module._discover_extensions(manager)
        return discovered, errors, models, extension
    finally:
        manager.clear()


@pytest.mark.parametrize("order", _N1_CASE_ORDERS, ids=lambda value: "-".join(value))
@pytest.mark.parametrize("setup_required,empty_models", [(False, False), (True, True)], ids=["missing-model-root", "uninstalled-empty-model-root"])
def test_n1_readonly_discovery_preserves_every_implicit_case_member(monkeypatch, tmp_path, order, setup_required, empty_models):
    nodes = [{"id": node_id, **_N1_LEGACY_METADATA["hf"]} for node_id in order]
    discovered, errors, models, extension = _n1_discover_manifest(
        monkeypatch, tmp_path, nodes, setup_required=setup_required, empty_models=empty_models,
    )
    assert not errors, errors
    assert list(discovered) == [f"n1-legacy-cases/{node_id}" for node_id in order]
    for capability_id, (generator_class, metadata, extension_dir, legacy_context) in discovered.items():
        assert metadata["id"] == metadata["capability_id"] == capability_id
        assert metadata["weight_owner_id"] == capability_id
        assert metadata["legacy_paths"] == [capability_id]
        assert metadata["shared_owner"] is False
        assert extension_dir == extension
        assert (generator_class is None) is setup_required
        assert (legacy_context is None) is setup_required
    assert not (extension / "venv").exists()
    assert models.exists() is empty_models
    if empty_models:
        assert list(models.iterdir()) == []


@pytest.mark.parametrize("metadata", _N1_LEGACY_METADATA.values(), ids=_N1_LEGACY_METADATA.keys())
def test_n1_readonly_discovery_keeps_unprovisioned_legacy_metadata(monkeypatch, tmp_path, metadata):
    nodes = [{"id": node_id, **metadata} for node_id in ("Foo", "foo")]
    discovered, errors, models, _ = _n1_discover_manifest(monkeypatch, tmp_path, nodes, setup_required=True)
    assert not errors, errors
    assert set(discovered) == {"n1-legacy-cases/Foo", "n1-legacy-cases/foo"}
    for node in nodes:
        _, actual, _, _ = discovered[f"n1-legacy-cases/{node['id']}"]
        for field in metadata:
            assert actual[field] == node[field]
        assert actual["weight_owner_id"] == actual["capability_id"]
    assert not models.exists()


@pytest.mark.parametrize("order", tuple(permutations(("Foo", "foo", "other"))))
def test_n1_readonly_discovery_unrelated_explicit_owner_does_not_hide_implicit_nodes(monkeypatch, tmp_path, order):
    nodes = [{"id": node_id, **({"weight_owner_id": "Shared"} if node_id == "other" else {})} for node_id in order]
    discovered, errors, _, _ = _n1_discover_manifest(monkeypatch, tmp_path, nodes, setup_required=True)
    assert not errors, errors
    assert set(discovered) == {f"n1-legacy-cases/{node_id}" for node_id in order}
    for node_id in ("Foo", "foo"):
        _, metadata, _, _ = discovered[f"n1-legacy-cases/{node_id}"]
        assert metadata["weight_owner_id"] == f"n1-legacy-cases/{node_id}"
        assert metadata["legacy_paths"] == [f"n1-legacy-cases/{node_id}"]
    assert discovered["n1-legacy-cases/other"][1]["weight_owner_id"] == "n1-legacy-cases/Shared"


@pytest.mark.parametrize("owner", ["FOO", "Foo", "foo"])
@pytest.mark.parametrize("order", tuple(permutations(("Foo", "foo", "third"))))
def test_n1_readonly_discovery_rejects_every_protected_third_member_order(monkeypatch, tmp_path, owner, order):
    nodes = [{"id": node_id, **({"weight_owner_id": owner} if node_id == "third" else {})} for node_id in order]
    discovered, errors, _, _ = _n1_discover_manifest(monkeypatch, tmp_path, nodes, setup_required=True)
    assert not discovered
    assert set(errors) == {f"n1-legacy-cases/{node_id}" for node_id in order}
    assert all("portable" in error or "overlap" in error for error in errors.values())


@pytest.mark.parametrize("managed_kind", ["model_sources", "shared_group"])
@pytest.mark.parametrize("order", tuple(permutations(("Foo", "foo", "third"))))
def test_n1_readonly_discovery_preserves_manifest_wide_managed_identity_guard(monkeypatch, tmp_path, managed_kind, order):
    protected = {"model_sources": [_N1_SOURCE]} if managed_kind == "model_sources" else {"weight_groups": ["common"]}
    nodes = [{"id": node_id, **(protected if node_id == "third" else {})} for node_id in order]
    groups = [{"id": "common", "model_sources": [_N1_SOURCE]}] if managed_kind == "shared_group" else None
    discovered, errors, _, _ = _n1_discover_manifest(monkeypatch, tmp_path, nodes, setup_required=True, weight_groups=groups)
    assert not discovered
    assert set(errors) == {f"n1-legacy-cases/{node_id}" for node_id in order}
    assert all("portable" in error or "duplicate" in error for error in errors.values())


@pytest.mark.parametrize("getter", ["get_hf_download_plan", "get_https_download_plan", "get_model_sources_plan", "get_legacy_hf_download_plan"])
@pytest.mark.parametrize("order", [("Foo", "foo"), ("foo", "Foo")])
@pytest.mark.parametrize("registered", ["all", "selected-only"])
def test_n1_download_plan_rejects_readonly_case_collisions(monkeypatch, tmp_path, getter, order, registered):
    discovered, errors, models, _ = _n1_discover_manifest(
        monkeypatch, tmp_path, [{"id": node_id, **_N1_LEGACY_METADATA["hf"]} for node_id in order], setup_required=True,
    )
    assert not errors, errors
    registry = GeneratorRegistry()
    # Publish actual normalized discovery metadata, not a mocked plan/schema.
    registry._manifests.update({model_id: entry[1] for model_id, entry in discovered.items()
                                if registered == "all" or model_id.endswith("/Foo")})
    try:
        for model_id in registry._manifests:
            assert registry.get_manifest(model_id)["capability_id"] == model_id
            with pytest.raises(ValueError, match="portable-unique|overlaps"):
                getattr(registry, getter)(model_id)
        assert not models.exists()
    finally:
        registry._runtime_readiness_executor.shutdown(wait=True)


@pytest.mark.parametrize("getter,metadata", [
    ("get_hf_download_plan", _N1_LEGACY_METADATA["structured"]),
    ("get_https_download_plan", {"https_downloads": [{"url": "https://assets.example/weights.bin", "filename": "weights.bin", "size_bytes": 1, "sha256": "a" * 64}]}),
    ("get_legacy_hf_download_plan", _N1_LEGACY_METADATA["hf"]),
    ("get_model_sources_plan", {"model_sources": [_N1_SOURCE]}),
])
def test_n1_download_plan_preserves_safe_exact_owner(monkeypatch, tmp_path, getter, metadata):
    discovered, errors, models, _ = _n1_discover_manifest(
        monkeypatch, tmp_path, [{"id": "Foo", **metadata}], setup_required=True,
    )
    assert not errors, errors
    registry = GeneratorRegistry()
    registry._manifests.update({model_id: entry[1] for model_id, entry in discovered.items()})
    try:
        plan = getattr(registry, getter)("n1-legacy-cases/Foo")
        assert plan
        assert registry.get_manifest("n1-legacy-cases/Foo")["weight_owner_id"] == "n1-legacy-cases/Foo"
        assert not models.exists()
    finally:
        registry._runtime_readiness_executor.shutdown(wait=True)


@pytest.mark.parametrize("route_name", ["hf_download_assets", "https_download_assets"])
def test_n1_download_plan_storage_denial_uses_nonretryable_validation_contract(monkeypatch, tmp_path, route_name):
    import asyncio
    from fastapi import HTTPException
    from routers import model as model_router

    discovered, errors, models, _ = _n1_discover_manifest(
        monkeypatch, tmp_path, [{"id": node_id, **_N1_LEGACY_METADATA["hf"]} for node_id in ("Foo", "foo")], setup_required=True,
    )
    assert not errors, errors
    registry = GeneratorRegistry()
    registry._manifests.update({model_id: entry[1] for model_id, entry in discovered.items()})
    monkeypatch.setattr(model_router, "generator_registry", registry)
    try:
        kwargs = {"model_id": "n1-legacy-cases/Foo", "target_owner_id": None}
        if route_name == "hf_download_assets":
            kwargs["authorization"] = None
        with pytest.raises(HTTPException) as caught:
            asyncio.run(getattr(model_router, route_name)(**kwargs))
        assert caught.value.status_code == 422
        assert caught.value.detail["code"] == "source_plan_invalid"
        assert caught.value.detail["stage"] == "validate"
        assert caught.value.detail["retryable"] is False
        assert "portable-unique" in caught.value.detail["message"]
        assert not models.exists()
    finally:
        registry._runtime_readiness_executor.shutdown(wait=True)


@pytest.mark.parametrize("getter,metadata", [
    ("get_hf_download_plan", _N1_LEGACY_METADATA["structured"]),
    ("get_https_download_plan", {"https_downloads": [{"url": "https://assets.example/weights.bin", "filename": "weights.bin", "size_bytes": 1, "sha256": "a" * 64}]}),
    ("get_legacy_hf_download_plan", _N1_LEGACY_METADATA["hf"]),
    ("get_model_sources_plan", {"model_sources": [_N1_SOURCE]}),
    ("get_weight_group_sources_plan", {"weight_groups": ["common"]}),
])
def test_n1_download_plan_consumes_the_exact_validated_manifest_snapshot(monkeypatch, tmp_path, getter, metadata):
    groups = [{"id": "common", "model_sources": [_N1_SOURCE]}] if getter == "get_weight_group_sources_plan" else None
    discovered, errors, _, _ = _n1_discover_manifest(
        monkeypatch, tmp_path, [{"id": "Foo", **metadata}], setup_required=True, weight_groups=groups,
    )
    assert not errors, errors
    registry = GeneratorRegistry()
    registry._manifests.update({model_id: entry[1] for model_id, entry in discovered.items()})
    model_id = "n1-legacy-cases/Foo"
    arguments = (model_id, "n1-legacy-cases/_shared/common") if groups else (model_id,)
    try:
        expected = getattr(registry, getter)(*arguments)
        original = registry._assert_download_ownership
        validated = registry.get_manifest(model_id)

        def replace_after_validation(selected_id):
            snapshot = original(selected_id)
            assert snapshot is validated
            registry._manifests[selected_id] = {
                **snapshot, "nodes": [{"id": node_id, **metadata} for node_id in ("Foo", "foo")],
                "hf_downloads": [], "https_downloads": [], "model_sources": [],
                "weight_groups": [], "hf_repo": "org/replacement",
            }
            return snapshot

        monkeypatch.setattr(registry, "_assert_download_ownership", replace_after_validation)
        assert getattr(registry, getter)(*arguments) == expected
        assert registry.get_manifest(model_id) is not validated
    finally:
        registry._runtime_readiness_executor.shutdown(wait=True)
