import importlib
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
