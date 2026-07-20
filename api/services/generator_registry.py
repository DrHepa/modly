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
import re
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional, Tuple
from urllib.parse import urlparse

from services.generators.base import BaseGenerator
from services.hf_download_assets import validate_hf_downloads
from services.https_download_assets import validate_https_downloads
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

# Runtime readiness may execute slow, read-only extension self-checks (for example
# cold managed import smoke) so the default must be longer than normal request
# timeouts while still remaining bounded.
_DEFAULT_RUNTIME_READINESS_TIMEOUT_SECONDS = 30.0
_MODEL_INPUT_KINDS = frozenset({
    "image",
    "text",
    "mesh",
    "scene",
    "audio",
    "video",
    "none",
})


def normalize_model_input(value):
    return value


def validate_model_input(value, context: str = "input") -> str:
    """Validate the invocation input declared by one model node."""
    value = normalize_model_input(value)
    if not isinstance(value, str) or value not in _MODEL_INPUT_KINDS:
        expected = ", ".join(sorted(_MODEL_INPUT_KINDS))
        raise ValueError(f"{context} must be one of: {expected}")
    return value


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
        # Dot-dirs are install machinery (staging/backup), never extensions
        if ext_dir.name.startswith("."):
            continue
        # Marker left by the installer while setup runs (or after a crash):
        # the folder is not ready to be loaded
        if (ext_dir / ".modly-incomplete").exists():
            print(f"[Registry] Skipping '{ext_dir.name}': install has not completed")
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
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

            # Process extensions run via Electron's process runner, not this
            # registry — skip them even when their entry file is generator.py.
            if manifest.get("type", "model") != "model":
                print(f"[Registry] Skipping '{ext_dir.name}': type "
                      f"'{manifest.get('type')}' is not handled by this registry")
                continue

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
                        "hf_downloads":       validate_hf_downloads(
                            node["hf_downloads"],
                            context="{}/{}.hf_downloads".format(ext_id, node["id"]),
                        ) if "hf_downloads" in node else [],
                        "https_downloads":  node.get("https_downloads", []),
                        "download_check":   node.get("download_check", ""),
                        "hf_skip_prefixes": node.get("hf_skip_prefixes", []),
                        "params_schema":    node.get("params_schema", []),
                        "input":            normalize_model_input(node.get("input", "image")),
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
        self._runtime_readiness_timeout_seconds = _DEFAULT_RUNTIME_READINESS_TIMEOUT_SECONDS
        self._runtime_readiness_cache: Dict[str, tuple[float, dict]] = {}
        self._runtime_readiness_inflight: Dict[str, Future] = {}
        self._runtime_readiness_lock = threading.Lock()
        self._runtime_readiness_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="runtime-readiness")

    def initialize(self) -> None:
        """Discovers and instantiates all extensions. Call at startup."""
        extensions = _discover_extensions()

        model_ids_by_owner: Dict[str, list[str]] = {}
        for discovered_model_id, (_, discovered_manifest, _) in extensions.items():
            bundle_id = (
                discovered_manifest.get("bundle_id")
                or discovered_model_id.split("/", 1)[0]
            )
            owner_id = (
                discovered_manifest.get("weight_owner_id")
                or discovered_manifest.get("id")
                or discovered_model_id
            )
            owner_key = f"{bundle_id}/{owner_id}"
            model_ids_by_owner.setdefault(owner_key, []).append(discovered_model_id)

        for model_id, entry in extensions.items():
            cls, manifest, ext_dir = entry
            try:
                manifest["input"] = validate_model_input(
                    manifest.get("input", "image"),
                    context=f"{model_id}.input",
                )

                raw_https_downloads = manifest.get("https_downloads", [])
                if raw_https_downloads:
                    bundle_id = (
                        manifest.get("bundle_id")
                        or model_id.split("/", 1)[0]
                    )
                    owner_id = manifest.get("weight_owner_id") or manifest.get("id")
                    owner_key = f"{bundle_id}/{owner_id}"
                    owner_model_ids = model_ids_by_owner.get(owner_key, [model_id])
                    if len(owner_model_ids) > 1:
                        raise ValueError(
                            "Model '{}' declares https_downloads but weight owner '{}' "
                            "is shared by multiple model IDs: {}. HTTPS readiness markers "
                            "embed the full model ID, so HTTPS plans require a node-specific "
                            "weight owner.".format(
                                model_id,
                                owner_id,
                                ", ".join(sorted(owner_model_ids)),
                            )
                        )
                    manifest["https_downloads"] = validate_https_downloads(
                        raw_https_downloads,
                        context=f"{model_id}.https_downloads",
                    )
                else:
                    manifest["https_downloads"] = []

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
                    gen.model_id         = model_id
                    gen.input            = manifest["input"]
                    gen.hf_repo          = manifest.get("hf_repo", "")
                    gen.hf_downloads      = manifest.get("hf_downloads", [])
                    gen.https_downloads   = manifest.get("https_downloads", [])
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
        self.shutdown_all()
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
                if getattr(gen, "https_downloads", []):
                    raise RuntimeError(
                        f"[{self._active_id}] Manifest-owned https_downloads "
                        "assets must be installed from the Models UI before "
                        "loading this model."
                    )
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

    def get_hf_download_plan(self, model_id: str) -> list[dict]:
        """Returns the validated manifest-owned asset plan for a canonical model ID."""
        manifest = self.get_manifest(model_id)
        plan = manifest.get("hf_downloads", [])
        return validate_hf_downloads(
            plan,
            context="{}.hf_downloads".format(model_id),
        ) if plan else []

    def get_https_download_plan(self, model_id: str) -> list[dict]:
        """Return the exact HTTPS asset plan owned by a canonical model ID."""
        manifest = self.get_manifest(model_id)
        plan = manifest.get("https_downloads", [])
        return validate_https_downloads(
            plan,
            context=f"{model_id}.https_downloads",
        ) if plan else []

    def get_model_input(self, model_id: str) -> str:
        """Return the validated invocation input for a canonical model ID."""
        manifest = self.get_manifest(model_id)
        return validate_model_input(
            manifest.get("input", "image"),
            context=f"{model_id}.input",
        )

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
            "input":      self.get_model_input(self._active_id),
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
                "input":       self.get_model_input(model_id),
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
        self.shutdown_all()

    def shutdown_all(self) -> None:
        for gen in self._generators.values():
            try:
                if isinstance(gen, ExtensionProcess):
                    gen.stop()
                else:
                    gen.unload()
            except Exception:
                pass

        with self._runtime_readiness_lock:
            self._runtime_readiness_cache.clear()
            self._runtime_readiness_inflight.clear()


_EVIDENCE_ALLOWLIST = {
    "source",
    "runtime_name",
    "runtime_version",
    "platform",
    "auth_state",
    "entitlement_state",
}

_DETAIL_DIAGNOSTIC_ALLOWLIST = {
    "runtime_source",
    "runtime_name",
    "runtime_version",
    "runtime_version_supported",
    "supported_versions",
    "platform_supported",
    "platform_key",
    "auth_state",
    "entitlement_state",
    "extension_setup_state",
    "extension_import_state",
    "codex_app_server_state",
    "readiness_source",
    "diagnostic_status",
    "last_checked_at",
}

_ACTION_KINDS = {
    "show_guidance",
    "show_details",
    "open_external_url",
    "refresh_readiness",
}
_ACTION_SAFETY = {"manual", "non_destructive", "confirm"}
_ACTION_REFRESH_AFTER = {"always", "success", "never"}
_ACTION_ID_RE = re.compile(r"^[a-z0-9._:-]{1,80}$")
_MAX_RUNTIME_ACTIONS = 5
_MAX_SHORT_TEXT = 200
_MAX_GUIDANCE_TEXT = 2000
_MAX_DIAGNOSTIC_VALUE = 160


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_text(value, *, max_length: int = _MAX_SHORT_TEXT) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped or len(stripped) > max_length or _looks_sensitive(stripped):
        return None
    return stripped


def _looks_sensitive(value: str) -> bool:
    lowered = value.lower()
    sensitive_markers = (
        "token",
        "secret",
        "password",
        "api_key",
        "apikey",
        "authorization",
        "bearer ",
        "traceback",
        "raw output",
        "home=",
        "env=",
        "sk-",
    )
    if any(marker in lowered for marker in sensitive_markers):
        return True
    if ".." in value or "~/" in value or "\\" in value:
        return True
    if re.search(r"(^|\s)/(?:home|users|private|tmp|var|etc|opt|usr|root)(?:/|\s|$)", value):
        return True
    return False


def _safe_url(value) -> str | None:
    if not isinstance(value, str) or len(value) > 500 or _looks_sensitive(value):
        return None
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc:
        return None
    return value


def _sanitize_runtime_actions(actions) -> list[dict]:
    if not isinstance(actions, list):
        return []

    safe_actions: list[dict] = []
    for action in actions:
        if len(safe_actions) >= _MAX_RUNTIME_ACTIONS:
            break
        if not isinstance(action, dict):
            continue

        action_id = _safe_text(action.get("id"), max_length=80)
        kind = action.get("kind")
        label = _safe_text(action.get("label"), max_length=80)
        safety = action.get("safety")
        if not action_id or not _ACTION_ID_RE.fullmatch(action_id):
            continue
        if kind not in _ACTION_KINDS or safety not in _ACTION_SAFETY or not label:
            continue

        safe_action = {
            "id": action_id,
            "kind": kind,
            "label": label,
            "safety": safety,
        }

        for key in ("reason",):
            value = _safe_text(action.get(key), max_length=_MAX_SHORT_TEXT)
            if value:
                safe_action[key] = value

        guidance = _safe_text(action.get("guidance"), max_length=_MAX_GUIDANCE_TEXT)
        if guidance:
            safe_action["guidance"] = guidance

        docs_url = _safe_url(action.get("docs_url"))
        if docs_url:
            safe_action["docs_url"] = docs_url
        elif kind == "open_external_url":
            continue

        if isinstance(action.get("disabled"), bool):
            safe_action["disabled"] = action["disabled"]
        if isinstance(action.get("requires_confirmation"), bool):
            safe_action["requires_confirmation"] = action["requires_confirmation"]
        if action.get("refresh_after") in _ACTION_REFRESH_AFTER:
            safe_action["refresh_after"] = action["refresh_after"]

        confirmation = _sanitize_confirmation(action.get("confirmation"))
        if confirmation:
            safe_action["confirmation"] = confirmation

        safe_actions.append(safe_action)

    return safe_actions


def _sanitize_confirmation(confirmation) -> dict | None:
    if not isinstance(confirmation, dict):
        return None
    safe_confirmation = {}
    for key in ("title", "body", "confirm_label"):
        value = _safe_text(confirmation.get(key), max_length=_MAX_SHORT_TEXT)
        if value:
            safe_confirmation[key] = value
    return safe_confirmation or None


def _sanitize_string_map(values, allowlist: set[str]) -> dict:
    if not isinstance(values, dict):
        return {}
    safe_values = {}
    for key, value in values.items():
        if key not in allowlist or not isinstance(value, (str, int, float, bool)):
            continue
        safe_value = _safe_text(str(value), max_length=_MAX_DIAGNOSTIC_VALUE)
        if safe_value is not None:
            safe_values[key] = safe_value
    return safe_values


def _sanitize_runtime_details(details) -> dict:
    if not isinstance(details, dict):
        return {}
    safe_details = {}
    for key in ("title", "summary"):
        value = _safe_text(details.get(key), max_length=_MAX_SHORT_TEXT)
        if value:
            safe_details[key] = value
    guidance = _safe_text(details.get("guidance"), max_length=_MAX_GUIDANCE_TEXT)
    if guidance:
        safe_details["guidance"] = guidance
    for key in ("evidence", "diagnostics"):
        safe_values = _sanitize_string_map(details.get(key), _DETAIL_DIAGNOSTIC_ALLOWLIST)
        if safe_values:
            safe_details[key] = safe_values
    return safe_details


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
        safe_evidence = _sanitize_string_map(evidence, _EVIDENCE_ALLOWLIST)
        if safe_evidence:
            result["evidence"] = safe_evidence
    actions = _sanitize_runtime_actions(status.get("actions"))
    if actions:
        result["actions"] = actions
    details = _sanitize_runtime_details(status.get("details"))
    if details:
        result["details"] = details
    if status.get("stale") is True:
        result["stale"] = True
    return result


# Singleton
generator_registry = GeneratorRegistry()
