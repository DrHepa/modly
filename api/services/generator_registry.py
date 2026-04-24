"""
GeneratorRegistry — manages the lifecycle of all model adapters.
Dynamically loads extensions from the extensions/ folder.

To add a new model: create a folder in extensions/ with
  - manifest.json  (metadata + hf_repo + pip_requirements...)
  - generator.py   (class extending BaseGenerator)
No other file needs to be modified.
"""
import importlib.util
import json
import os
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional, Tuple

from services.generators.base import BaseGenerator
from services.extension_process import ExtensionProcess, _venv_python

# ------------------------------------------------------------------ #
# Global paths
# ------------------------------------------------------------------ #

_models_dir_raw    = os.environ.get("MODELS_DIR")    or str(Path.home() / ".modly" / "models")
_workspace_dir_raw = os.environ.get("WORKSPACE_DIR") or str(Path.home() / ".modly" / "workspace")
MODELS_DIR    = Path(_models_dir_raw)
WORKSPACE_DIR = Path(_workspace_dir_raw)

MODELS_DIR.mkdir(parents=True, exist_ok=True)
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

# extensions/ folder — in userData (passed by Electron via EXTENSIONS_DIR)
_extensions_dir_raw = os.environ.get("EXTENSIONS_DIR", "")
EXTENSIONS_DIR = Path(_extensions_dir_raw) if _extensions_dir_raw else None

print(f"[Registry] MODELS_DIR     = {MODELS_DIR}")
print(f"[Registry] WORKSPACE_DIR  = {WORKSPACE_DIR}")
print(f"[Registry] EXTENSIONS_DIR = {EXTENSIONS_DIR or '(not set)'}")


# ------------------------------------------------------------------ #
# Extension loader
# ------------------------------------------------------------------ #

def _discover_extensions() -> Dict[str, Tuple[type, dict]]:
    """
    Scans EXTENSIONS_DIR to find valid extensions.
    Each extension must have manifest.json + generator.py.
    Returns {full_id: (GeneratorClass, node_manifest, ext_dir)}
    where full_id is "ext_id/node_id".
    """
    result: Dict[str, Tuple[type, dict]] = {}

    if EXTENSIONS_DIR is None or not EXTENSIONS_DIR.exists():
        print(f"[Registry] WARNING: EXTENSIONS_DIR not set or not found: {EXTENSIONS_DIR}")
        return result

    for ext_dir in sorted(EXTENSIONS_DIR.iterdir()):
        if not ext_dir.is_dir():
            continue

        manifest_path  = ext_dir / "manifest.json"
        generator_path = ext_dir / "generator.py"

        if not manifest_path.exists():
            print(f"[Registry] Skipping '{ext_dir.name}': missing manifest.json")
            continue
        if not generator_path.exists():
            print(f"[Registry] Skipping '{ext_dir.name}': missing generator.py")
            continue

        try:
            manifest   = json.loads(manifest_path.read_text(encoding="utf-8"))
            ext_id     = manifest["id"]
            class_name = manifest["generator_class"]

            nodes = [n for n in manifest.get("nodes", []) if n.get("id")]

            # --- Subprocess mode (new): venv present → use ExtensionProcess ---
            # Also force subprocess mode for extensions that ship a build_vendor.py
            # but whose vendor/ directory hasn't been built yet: this surfaces a
            # loadError in the UI (Repair button) so the user can run setup.py.
            has_venv         = _venv_python(ext_dir).exists()
            has_build_vendor = (ext_dir / "build_vendor.py").exists()
            vendor_built     = (ext_dir / "vendor").exists()
            subprocess_mode  = has_venv or (has_build_vendor and not vendor_built)

            cls_or_None = None
            if not subprocess_mode:
                # --- Direct mode (legacy): no venv → load generator.py directly ---
                module_name = f"extensions.{ext_id}.generator"
                spec   = importlib.util.spec_from_file_location(module_name, generator_path)
                module = importlib.util.module_from_spec(spec)
                sys.modules[module_name] = module
                spec.loader.exec_module(module)
                cls_or_None = getattr(module, class_name)

            legacy_paths_by_owner: Dict[str, list[str]] = {}
            for node in nodes:
                owner_id = node.get("weight_owner_id") or node["id"]
                weight_owner_id = f"{ext_id}/{owner_id}"
                legacy_paths_by_owner.setdefault(weight_owner_id, []).append(f"{ext_id}/{node['id']}")

            if nodes:
                for node in nodes:
                    owner_id = node.get("weight_owner_id") or node["id"]
                    weight_owner_id = f"{ext_id}/{owner_id}"
                    legacy_paths = list(legacy_paths_by_owner.get(weight_owner_id, [f"{ext_id}/{node['id']}"]))
                    node_manifest = {
                        **manifest,
                        "id":               f"{ext_id}/{node['id']}",
                        "capability_id":    f"{ext_id}/{node['id']}",
                        "bundle_id":        ext_id,
                        "ext_id":           ext_id,
                        "node_id":          node["id"],
                        "name":             node.get("name", node["id"]),
                        "hf_repo":          node.get("hf_repo", ""),
                        "download_check":   node.get("download_check", ""),
                        "hf_skip_prefixes": node.get("hf_skip_prefixes", []),
                        "params_schema":    node.get("params_schema", []),
                        "input":            node.get("input", "image"),
                        "output":           node.get("output", "mesh"),
                        "weight_owner_id":  weight_owner_id,
                        "shared_owner":     len(legacy_paths) > 1,
                        "legacy_paths":     legacy_paths,
                    }
                    full_id = f"{ext_id}/{node['id']}"
                    result[full_id] = (cls_or_None, node_manifest, ext_dir)
                    if subprocess_mode:
                        if has_venv:
                            print(f"[Registry] Loaded subprocess node: {full_id}")
                        else:
                            print(f"[Registry] Node '{full_id}' needs setup (venv missing)")
                    else:
                        print(f"[Registry] Loaded node: {full_id} ({class_name})")
            else:
                # No nodes defined — register by ext_id as fallback
                result[ext_id] = (cls_or_None, manifest, ext_dir)
                if subprocess_mode:
                    if has_venv:
                        print(f"[Registry] Loaded subprocess extension: {ext_id}")
                    else:
                        print(f"[Registry] Extension '{ext_id}' needs setup (venv missing)")
                else:
                    print(f"[Registry] Loaded extension: {ext_id} ({class_name})")

        except Exception as exc:
            print(f"[Registry] ERROR loading extension '{ext_dir.name}': {exc}")

    return result


def canonical_model_dir(models_dir: Path, manifest: dict) -> Path:
    owner_id = manifest.get("weight_owner_id") or manifest.get("id")
    return models_dir / owner_id


def resolve_active_model_dir(models_dir: Path, manifest: dict) -> Path:
    canonical_dir = canonical_model_dir(models_dir, manifest)
    if canonical_dir.exists():
        return canonical_dir

    # Read-through compatibility only: prefer the canonical owner path, then the
    # first existing legacy alias in manifest order. We do NOT merge aliases or
    # move files automatically because that could delete valid shared weights.
    for legacy_path in manifest.get("legacy_paths", [manifest.get("id")]):
        legacy_dir = models_dir / legacy_path
        if legacy_dir == canonical_dir:
            continue
        if legacy_dir.exists():
            return legacy_dir

    return canonical_dir


# ------------------------------------------------------------------ #
# GeneratorRegistry
# ------------------------------------------------------------------ #

class GeneratorRegistry:
    def __init__(self) -> None:
        self._generators: Dict[str, BaseGenerator] = {}
        self._manifests:  Dict[str, dict]          = {}
        self._errors:     Dict[str, str]           = {}
        self._active_id:  str = os.environ.get("SELECTED_MODEL_ID", "sf3d")
        self._runtime_readiness_ttl_seconds = 30.0
        self._runtime_readiness_timeout_seconds = 5.0
        self._runtime_readiness_cache: Dict[str, tuple[float, dict]] = {}
        self._runtime_readiness_inflight: Dict[str, Future] = {}
        self._runtime_readiness_lock = threading.Lock()
        self._runtime_readiness_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="runtime-readiness")

    def initialize(self) -> None:
        """Discovers and instantiates all extensions. Call at startup."""
        extensions = _discover_extensions()

        for model_id, entry in extensions.items():
            cls, manifest, ext_dir = entry
            try:
                if cls is None:
                    # Subprocess mode: venv must exist
                    if not _venv_python(ext_dir).exists():
                        raise RuntimeError(
                            "venv not found — extension needs setup. "
                            "Click 'Repair' on the Models page to run setup.py."
                        )
                    # Subprocess mode: wrap in ExtensionProcess
                    gen = ExtensionProcess(ext_dir, manifest)
                    gen.model_dir   = canonical_model_dir(MODELS_DIR, manifest)
                    gen.outputs_dir = WORKSPACE_DIR
                else:
                    # Legacy direct mode
                    gen = cls(canonical_model_dir(MODELS_DIR, manifest), WORKSPACE_DIR)
                    gen.hf_repo          = manifest.get("hf_repo", "")
                    gen.hf_skip_prefixes = manifest.get("hf_skip_prefixes", [])
                    gen.download_check   = manifest.get("download_check", "")
                    gen._params_schema   = manifest.get("params_schema", [])

                self._generators[model_id] = gen
                self._manifests[model_id]  = manifest
                self._errors.pop(model_id, None)
            except Exception as exc:
                msg = f"Failed to instantiate generator '{model_id}': {exc}"
                print(f"[Registry] ERROR: {msg}")
                self._errors[model_id] = msg

        if not self._generators:
            print("[Registry] WARNING: No extensions found.")
            return

        if self._active_id not in self._generators:
            fallback = next(iter(self._generators))
            print(
                f"[Registry] WARNING: SELECTED_MODEL_ID='{self._active_id}' is unknown. "
                f"Falling back to '{fallback}'."
            )
            self._active_id = fallback

        print(f"[Registry] Active model  : {self._active_id}")
        print(f"[Registry] All models    : {list(self._generators.keys())}")

    def canonical_model_dir(self, model_id: str) -> Path:
        return canonical_model_dir(MODELS_DIR, self.get_manifest(model_id))

    def resolve_active_model_dir(self, model_id: str) -> Path:
        return resolve_active_model_dir(MODELS_DIR, self.get_manifest(model_id))

    def _sync_generator_model_dir(self, model_id: str) -> BaseGenerator:
        gen = self._generators[model_id]
        gen.model_dir = self.resolve_active_model_dir(model_id)
        return gen

    def reload(self) -> None:
        """
        Re-scans extensions and updates the registry without restarting FastAPI.
        Unloads all current generators before reloading.
        """
        print("[Registry] Reloading extensions…")
        for gen in self._generators.values():
            try:
                gen.unload()
            except Exception:
                pass
        self._generators.clear()
        self._manifests.clear()
        self._errors.clear()
        self.initialize()
        print("[Registry] Reload complete.")

    def load_errors(self) -> Dict[str, str]:
        """Returns extension loading errors."""
        return dict(self._errors)

    # ------------------------------------------------------------------ #
    # Generator access
    # ------------------------------------------------------------------ #

    def get_active(self) -> BaseGenerator:
        """Returns the active generator. Downloads and loads if necessary."""
        gen = self._sync_generator_model_dir(self._active_id)
        if not gen.is_loaded():
            if not gen.is_downloaded():
                gen.model_dir = self.canonical_model_dir(self._active_id)
                if isinstance(gen, ExtensionProcess):
                    # Let the subprocess handle its own download logic during
                    # load() — some extensions (e.g. mv-adapter) need custom
                    # multi-repo downloads that the standard HF endpoint can't do.
                    pass
                else:
                    gen._auto_download()
            gen.load()
        return gen

    def get_generator(self, model_id: str) -> BaseGenerator:
        if model_id not in self._generators:
            raise ValueError(
                f"Unknown model ID: '{model_id}'. "
                f"Available: {list(self._generators.keys())}"
            )
        return self._sync_generator_model_dir(model_id)

    def get_manifest(self, model_id: str) -> dict:
        """Returns the manifest of an extension."""
        if model_id not in self._manifests:
            raise KeyError(f"No manifest for model ID: '{model_id}'")
        return self._manifests[model_id]

    def switch_model(self, model_id: str) -> None:
        """Switches the active model. Unloads the previous one if different."""
        if model_id not in self._generators:
            raise ValueError(
                f"Unknown model ID: '{model_id}'. "
                f"Available: {list(self._generators.keys())}"
            )
        if model_id != self._active_id:
            if self._active_id in self._generators:
                self._generators[self._active_id].unload()
            self._active_id = model_id

    # ------------------------------------------------------------------ #
    # Status
    # ------------------------------------------------------------------ #

    def active_status(self) -> dict:
        gen      = self._sync_generator_model_dir(self._active_id)
        manifest = self._manifests[self._active_id]
        return {
            "id":         self._active_id,
            "name":       manifest.get("name", gen.DISPLAY_NAME),
            "downloaded": gen.is_downloaded(),
            "loaded":     gen.is_loaded(),
        }

    def all_status(self) -> list:
        result = []
        for model_id, gen in self._generators.items():
            gen = self._sync_generator_model_dir(model_id)
            manifest = self._manifests[model_id]
            result.append({
                "id":          model_id,
                "name":        manifest.get("name", gen.DISPLAY_NAME),
                "description": manifest.get("description", ""),
                "version":     manifest.get("version", ""),
                "vram_gb":     manifest.get("vram_gb", gen.VRAM_GB),
                "hf_repo":     manifest.get("hf_repo", ""),
                "tags":        manifest.get("tags", []),
                "downloaded":  gen.is_downloaded(),
                "loaded":      gen.is_loaded(),
                "active":      model_id == self._active_id,
            })
        return result

    def runtime_readiness(self, model_ids: list[str]) -> dict:
        """Returns optional read-only runtime readiness for canonical model IDs."""
        readiness: dict[str, dict] = {}
        for model_id in model_ids:
            if model_id not in self._generators:
                continue
            readiness[model_id] = self._runtime_readiness_for_model(model_id)
        return readiness

    def _runtime_readiness_for_model(self, model_id: str) -> dict:
        now = time.monotonic()
        with self._runtime_readiness_lock:
            cached = self._runtime_readiness_cache.get(model_id)
            if cached and now - cached[0] < self._runtime_readiness_ttl_seconds:
                return dict(cached[1])

            future = self._runtime_readiness_inflight.get(model_id)
            if future is None:
                future = self._runtime_readiness_executor.submit(self._compute_runtime_readiness, model_id)
                self._runtime_readiness_inflight[model_id] = future

        try:
            status = future.result(timeout=self._runtime_readiness_timeout_seconds)
        except (FutureTimeoutError, Exception):
            return self._runtime_readiness_failure(model_id)
        finally:
            if future.done():
                with self._runtime_readiness_lock:
                    if self._runtime_readiness_inflight.get(model_id) is future:
                        self._runtime_readiness_inflight.pop(model_id, None)

        with self._runtime_readiness_lock:
            self._runtime_readiness_cache[model_id] = (time.monotonic(), status)
        return dict(status)

    def _compute_runtime_readiness(self, model_id: str) -> dict:
        gen = self._sync_generator_model_dir(model_id)
        readiness = getattr(gen, "readiness_status", None)
        if not callable(readiness):
            return _unsupported_runtime_readiness()

        status = readiness()
        return _sanitize_runtime_readiness(status)

    def _runtime_readiness_failure(self, model_id: str) -> dict:
        with self._runtime_readiness_lock:
            cached = self._runtime_readiness_cache.get(model_id)
        if cached:
            stale = dict(cached[1])
            stale["stale"] = True
            return stale
        return _checking_failed_runtime_readiness()

    def params_schema(self, model_id: Optional[str] = None) -> list:
        target_id = model_id or self._active_id
        if target_id not in self._generators:
            raise KeyError(target_id)
        return self._sync_generator_model_dir(target_id).params_schema()

    # ------------------------------------------------------------------ #
    # Paths update & shutdown
    # ------------------------------------------------------------------ #

    def update_paths(self, models_dir: Optional[Path], workspace_dir: Optional[Path]) -> None:
        global MODELS_DIR, WORKSPACE_DIR
        import services.generator_registry as _self_module

        if models_dir is not None:
            self.unload_all()
            models_dir.mkdir(parents=True, exist_ok=True)
            _self_module.MODELS_DIR = models_dir
            for model_id, gen in self._generators.items():
                gen.model_dir = resolve_active_model_dir(models_dir, self._manifests[model_id])

        if workspace_dir is not None:
            workspace_dir.mkdir(parents=True, exist_ok=True)
            _self_module.WORKSPACE_DIR = workspace_dir
            for gen in self._generators.values():
                gen.outputs_dir = workspace_dir

    def unload_all(self) -> None:
        for gen in self._generators.values():
            if isinstance(gen, ExtensionProcess):
                gen.stop()
            else:
                gen.unload()


_EVIDENCE_ALLOWLIST = {
    "source",
    "runtime_name",
    "runtime_version",
    "platform",
    "auth_state",
    "entitlement_state",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _unsupported_runtime_readiness() -> dict:
    return {
        "ok": False,
        "machine_code": "unsupported_contract",
        "label_hint": "Checking failed",
        "reason": "Model does not expose runtime readiness.",
        "checked_at": _now_iso(),
    }


def _checking_failed_runtime_readiness() -> dict:
    return {
        "ok": False,
        "machine_code": "check_failed",
        "label_hint": "Checking failed",
        "reason": "Runtime readiness check failed.",
        "checked_at": _now_iso(),
    }


def _sanitize_runtime_readiness(status: dict) -> dict:
    if not isinstance(status, dict):
        return _checking_failed_runtime_readiness()

    result: dict = {
        "ok": bool(status.get("ok", False)),
        "machine_code": str(status.get("machine_code") or "check_failed"),
        "checked_at": str(status.get("checked_at") or _now_iso()),
    }
    for key in ("label_hint", "reason"):
        value = status.get(key)
        if isinstance(value, str):
            result[key] = value
    evidence = status.get("evidence")
    if isinstance(evidence, dict):
        safe_evidence = {
            key: str(value)
            for key, value in evidence.items()
            if key in _EVIDENCE_ALLOWLIST and isinstance(value, (str, int, float, bool))
        }
        if safe_evidence:
            result["evidence"] = safe_evidence
    if status.get("stale") is True:
        result["stale"] = True
    return result


# Singleton
generator_registry = GeneratorRegistry()
