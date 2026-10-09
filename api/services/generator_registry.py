"""
GeneratorRegistry — manages the lifecycle of all model adapters.
Dynamically loads extensions from the extensions/ folder.

To add a new model: create a folder in extensions/ with
  - manifest.json  (metadata + hf_repo + pip_requirements...)
  - generator.py   (class extending BaseGenerator)
No other file needs to be modified.
"""
import importlib
import importlib.util
import hmac
import json
import os
import re
import secrets
import stat
import sys
import threading
from contextlib import contextmanager
from functools import wraps
import time
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Dict, Iterator, List, Optional, Set, Tuple
from urllib.parse import urlparse

from services.generators.base import BaseGenerator
from services.extension_process import ExtensionProcess, RuntimeReadinessUnavailable, _venv_python
from services.model_sources import (
    missing_weight_variant,
    model_sources_are_downloaded,
    normalize_model_sources,
    normalize_weight_group_references,
    normalize_weight_groups,
    normalize_weight_variants,
    validate_model_node_ids,
    resolve_weight_group_root,
    safe_source_id,
    weight_group_sources_are_downloaded,
)
from services.hf_download_assets import validate_hf_downloads, hf_download_assets_ready
from services.https_download_assets import validate_https_downloads, https_download_assets_ready

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
_REGISTRATION_PENDING_PREFIX = ".modly-registration-pending-"
_EXTENSION_ID = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_REGISTRATION_PENDING_NAME = re.compile(
    rf"^{re.escape(_REGISTRATION_PENDING_PREFIX)}"
    r"(?P<extension_id>[a-z0-9][a-z0-9._-]*)-(?P<suffix>\d+)$"
)
_REGISTRATION_CAPABILITY_LOCK = threading.Lock()

print(f"[Registry] MODELS_DIR     = {MODELS_DIR}")
print(f"[Registry] WORKSPACE_DIR  = {WORKSPACE_DIR}")
print(f"[Registry] EXTENSIONS_DIR = {EXTENSIONS_DIR or '(not set)'}")

# Optional read-only diagnostics have a bounded budget independent of model load.
_DEFAULT_RUNTIME_READINESS_TIMEOUT_SECONDS = 30.0


def validate_model_input(value, context: str = "input") -> str:
    """Validate flexible primary-input metadata without rewriting its modality."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{context} must be a non-empty string")
    return value


def is_within_workspace(resolved_path: Path) -> bool:
    """True when an already-resolved path is the current workspace or inside it.

    Compares ancestry, not string prefixes: ``startswith`` would also accept a
    sibling folder such as ``<workspace>-other``. Reads WORKSPACE_DIR at call
    time, since moving the workspace rebinds it.
    """
    workspace = WORKSPACE_DIR.resolve()
    return resolved_path == workspace or workspace in resolved_path.parents


# ------------------------------------------------------------------ #
# Extension loader
# ------------------------------------------------------------------ #

def _path_belongs_to(path: object, root: Path) -> bool:
    if not isinstance(path, (str, os.PathLike)):
        return False
    try:
        Path(path).resolve().relative_to(root)
        return True
    except (OSError, ValueError):
        return False


class _LegacyImportContext:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.modules: Dict[str, ModuleType] = {}
        self.local_names: Set[str] = set()
        for child in self.root.iterdir():
            if child.is_file() and child.suffix == ".py" and child.stem != "__init__":
                self.local_names.add(child.stem)
            elif child.is_dir() and (child / "__init__.py").is_file():
                self.local_names.add(child.name)


class _LegacyImportManager:
    """Isolates plain sibling imports used by legacy direct extensions."""

    def __init__(self) -> None:
        self._contexts: Dict[Path, _LegacyImportContext] = {}
        self._lock = threading.RLock()

    def register(self, root: Path) -> _LegacyImportContext:
        resolved = root.resolve()
        context = self._contexts.get(resolved)
        if context is None:
            context = _LegacyImportContext(resolved)
            self._contexts[resolved] = context
        return context

    def _owner(self, module: ModuleType) -> Optional[_LegacyImportContext]:
        module_file = getattr(module, "__file__", None)
        for context in self._contexts.values():
            if _path_belongs_to(module_file, context.root):
                return context
        return None

    def _capture_and_evict_owned_modules(self) -> None:
        for name, module in list(sys.modules.items()):
            if not isinstance(module, ModuleType):
                continue
            owner = self._owner(module)
            if owner is None:
                continue
            owner.modules[name] = module
            sys.modules.pop(name, None)

    @staticmethod
    def _matches_local_name(module_name: str, local_names: Set[str]) -> bool:
        return any(
            module_name == local_name or module_name.startswith(f"{local_name}.")
            for local_name in local_names
        )

    @contextmanager
    def activate(self, context: _LegacyImportContext) -> Iterator[None]:
        # sys.path and sys.modules are process-global. Serializing direct legacy
        # calls prevents concurrent generators from observing each other's
        # same-named sibling modules.
        with self._lock:
            original_path = list(sys.path)
            shadowed: Dict[str, ModuleType] = {}
            self._capture_and_evict_owned_modules()

            for name, module in list(sys.modules.items()):
                if self._matches_local_name(name, context.local_names) and isinstance(module, ModuleType):
                    shadowed[name] = module
                    sys.modules.pop(name, None)

            sys.modules.update(context.modules)
            managed_roots = {str(item.root) for item in self._contexts.values()}
            sys.path[:] = [str(context.root)] + [
                entry for entry in original_path if entry not in managed_roots
            ]
            importlib.invalidate_caches()

            try:
                yield
            finally:
                self._capture_and_evict_owned_modules()
                for name in list(sys.modules):
                    if self._matches_local_name(name, context.local_names):
                        sys.modules.pop(name, None)
                sys.modules.update(shadowed)
                sys.path[:] = original_path
                importlib.invalidate_caches()

    def clear(self) -> None:
        with self._lock:
            self._capture_and_evict_owned_modules()
            for context in self._contexts.values():
                for module in context.modules.values():
                    cached = getattr(module, "__cached__", None)
                    if _path_belongs_to(cached, context.root):
                        try:
                            Path(cached).unlink(missing_ok=True)
                        except OSError:
                            pass
                context.modules.clear()
            self._contexts.clear()
            importlib.invalidate_caches()


class _LegacyGeneratorProxy:
    def __init__(
        self,
        target: BaseGenerator,
        manager: _LegacyImportManager,
        context: _LegacyImportContext,
    ) -> None:
        object.__setattr__(self, "_target", target)
        object.__setattr__(self, "_manager", manager)
        object.__setattr__(self, "_context", context)

    def __getattr__(self, name: str):
        manager = object.__getattribute__(self, "_manager")
        context = object.__getattribute__(self, "_context")
        target = object.__getattribute__(self, "_target")
        with manager.activate(context):
            value = getattr(target, name)
        if not callable(value):
            return value

        @wraps(value)
        def call_in_context(*args, **kwargs):
            with manager.activate(context):
                return value(*args, **kwargs)

        return call_in_context

    def prepare_path_replacement(
        self, model_dir: Path, outputs_dir: Path, shared_model_dirs: Dict[str, Path]
    ) -> BaseGenerator:
        """Run fallible extension code without replacing the current target."""
        manager = object.__getattribute__(self, "_manager")
        context = object.__getattribute__(self, "_context")
        target = object.__getattribute__(self, "_target")
        with manager.activate(context):
            replacement = type(target)(model_dir, outputs_dir)
            for name in (
                "hf_repo", "hf_skip_prefixes", "download_check", "_params_schema",
                "MODEL_ID", "MODEL_NODE_ID",
                "model_id", "input", "hf_downloads", "https_downloads",
            ):
                setattr(replacement, name, getattr(target, name))
            replacement.shared_model_dirs = shared_model_dirs
            return replacement

    def rebind_unloaded_model_dir(self, model_dir: Path) -> None:
        """Recreate constructor-cached paths after the registry confirmed unload."""
        replacement = self.prepare_path_replacement(
            model_dir, self.outputs_dir, self.shared_model_dirs
        )
        object.__setattr__(self, "_target", replacement)

    def __setattr__(self, name: str, value: object) -> None:
        manager = object.__getattribute__(self, "_manager")
        context = object.__getattribute__(self, "_context")
        target = object.__getattribute__(self, "_target")
        with manager.activate(context):
            setattr(target, name, value)


def _manifest_model_ids(manifest: dict, fallback_id: str) -> List[str]:
    """Returns the registry keys a readable model manifest is expected to add."""
    ext_id = manifest.get("id")
    if not isinstance(ext_id, str) or not ext_id:
        return [fallback_id]

    raw_nodes = manifest.get("nodes", [])
    if not isinstance(raw_nodes, list):
        raw_nodes = []
    nodes = [
        node for node in raw_nodes
        if isinstance(node, dict) and isinstance(node.get("id"), str) and node["id"]
    ]
    return [f"{ext_id}/{node['id']}" for node in nodes] or [ext_id]


def _record_discovery_error(
    errors: Dict[str, str],
    message: str,
    *,
    manifest: Optional[dict] = None,
    fallback_id: str,
) -> None:
    keys = _manifest_model_ids(manifest, fallback_id) if manifest is not None else [fallback_id]
    for key in keys:
        errors[key] = message


def _registration_pending(extension_id: str) -> bool:
    if EXTENSIONS_DIR is None:
        return False
    prefix = f"{_REGISTRATION_PENDING_PREFIX}{extension_id}-"
    try:
        return any(
            child.name.startswith(prefix)
            and child.name[len(prefix):].isdigit()
            for child in EXTENSIONS_DIR.iterdir()
        )
    except OSError:
        return False


RegistrationValidationAuthorization = Tuple[str, Path, Path]


def _consume_registration_validation_capability(
    capability: object,
) -> Optional[RegistrationValidationAuthorization]:
    """Validates and atomically consumes one exact root-sidecar capability."""
    if EXTENSIONS_DIR is None or not isinstance(capability, dict):
        return None

    extension_id = capability.get("extensionId")
    destination_name = capability.get("destinationName")
    state_name = capability.get("stateName")
    token = capability.get("token")
    if not all(isinstance(value, str) and value for value in (
        extension_id,
        destination_name,
        state_name,
        token,
    )):
        return None
    if len(token) < 32:
        return None
    if (
        _EXTENSION_ID.fullmatch(extension_id) is None
        or destination_name != extension_id
    ):
        return None

    name_match = _REGISTRATION_PENDING_NAME.fullmatch(state_name)
    if name_match is None or name_match.group("extension_id") != extension_id:
        return None

    with _REGISTRATION_CAPABILITY_LOCK:
        try:
            root = EXTENSIONS_DIR.resolve()
            state_path = EXTENSIONS_DIR / state_name
            if state_path.parent.resolve() != root:
                return None
            destination_path = Path(os.path.abspath(root / destination_name))
            if destination_path.parent != root:
                return None
            matching_state_names = sorted(
                child.name
                for child in root.iterdir()
                if (
                    (match := _REGISTRATION_PENDING_NAME.fullmatch(child.name))
                    is not None
                    and match.group("extension_id") == extension_id
                )
            )
            if matching_state_names != [state_name]:
                return None
            state_stat = state_path.lstat()
            if (
                stat.S_ISLNK(state_stat.st_mode)
                or not stat.S_ISREG(state_stat.st_mode)
                or state_stat.st_nlink != 1
            ):
                return None
            if (
                os.name != "nt"
                and (
                    stat.S_IMODE(state_stat.st_mode) & 0o077
                    or (
                        hasattr(os, "getuid")
                        and state_stat.st_uid != os.getuid()
                    )
                )
            ):
                return None

            state = json.loads(state_path.read_text(encoding="utf-8"))
            if (
                not isinstance(state, dict)
                or state.get("version") != 1
                or state.get("extensionId") != extension_id
                or state.get("destinationName") != destination_name
                or state.get("consumed") is not False
                or not isinstance(state.get("token"), str)
                or not hmac.compare_digest(state["token"], token)
            ):
                return None

            # Replace the exact sidecar atomically while retaining its pending
            # filename. Normal reloads therefore keep quarantining the
            # extension, while this capability cannot be replayed.
            consumed_state = {
                "version": 1,
                "extensionId": extension_id,
                "destinationName": destination_name,
                "consumed": True,
            }
            temporary_path = root / (
                f".modly-registration-capability-{secrets.token_hex(16)}"
            )
            try:
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                descriptor = os.open(temporary_path, flags, 0o600)
                try:
                    if os.name != "nt":
                        os.fchmod(descriptor, 0o600)
                    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                        descriptor = -1
                        json.dump(consumed_state, stream)
                        stream.flush()
                        os.fsync(stream.fileno())
                finally:
                    if descriptor >= 0:
                        os.close(descriptor)
                os.replace(temporary_path, state_path)
            finally:
                try:
                    temporary_path.unlink()
                except FileNotFoundError:
                    pass
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return None

    return extension_id, state_path, destination_path


def _discover_extensions(
    legacy_imports: _LegacyImportManager,
    registration_authorization: Tuple[RegistrationValidationAuthorization, ...] = (),
) -> Tuple[
    Dict[str, Tuple[type, dict, Path, Optional[_LegacyImportContext]]],
    Dict[str, str],
]:
    """
    Scans EXTENSIONS_DIR to find valid extensions.
    Each extension must have manifest.json + generator.py.
    Returns ({full_id: (GeneratorClass, node_manifest, ext_dir)}, errors)
    where full_id is "ext_id/node_id".
    """
    result: Dict[str, Tuple[type, dict, Path, Optional[_LegacyImportContext]]] = {}
    errors: Dict[str, str] = {}

    if EXTENSIONS_DIR is None or not EXTENSIONS_DIR.exists():
        print(f"[Registry] WARNING: EXTENSIONS_DIR not set or not found: {EXTENSIONS_DIR}")
        return result, errors

    for ext_dir in sorted(EXTENSIONS_DIR.iterdir()):
        if not ext_dir.is_dir():
            continue
        # Dot-dirs are install machinery (staging/backup), never extensions
        if ext_dir.name.startswith("."):
            continue
        manifest_path  = ext_dir / "manifest.json"
        generator_path = ext_dir / "generator.py"

        if not manifest_path.exists():
            message = f"Extension '{ext_dir.name}' is missing manifest.json."
            print(f"[Registry] ERROR: {message}")
            _record_discovery_error(errors, message, fallback_id=ext_dir.name)
            continue

        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:
            message = f"Extension '{ext_dir.name}' has an invalid manifest.json: {exc}"
            print(f"[Registry] ERROR: {message}")
            _record_discovery_error(errors, message, fallback_id=ext_dir.name)
            continue
        if not isinstance(manifest, dict):
            message = f"Extension '{ext_dir.name}' has an invalid manifest.json: expected an object."
            print(f"[Registry] ERROR: {message}")
            _record_discovery_error(errors, message, fallback_id=ext_dir.name)
            continue

        try:
            # Process extensions run via Electron's process runner, not this
            # registry — skip them even when their entry file is generator.py.
            if manifest.get("type", "model") != "model":
                print(f"[Registry] Skipping '{ext_dir.name}': type "
                      f"'{manifest.get('type')}' is not handled by this registry")
                continue

            ext_id     = manifest["id"]
            class_name = manifest["generator_class"]

            if "model_sources" in manifest:
                raise ValueError("model_sources must be declared on a model node")

            weight_groups = normalize_weight_groups(manifest)

            if ext_id != ext_dir.name:
                message = (
                    f"Extension folder '{ext_dir.name}' declares mismatched "
                    f"manifest id '{ext_id}'. Folder and manifest IDs must match."
                )
                print(f"[Registry] ERROR: {message}")
                _record_discovery_error(
                    errors,
                    message,
                    fallback_id=ext_dir.name,
                )
                continue

            raw_nodes = manifest.get("nodes", [])
            if not isinstance(raw_nodes, list):
                raw_nodes = []
            nodes = [
                node for node in raw_nodes
                if isinstance(node, dict) and node.get("id")
            ]
            group_by_id = {group["id"]: group for group in weight_groups or []}
            uses_shared_weights = weight_groups is not None or any(
                "weight_groups" in node for node in nodes
            )
            if uses_shared_weights or any("model_sources" in node for node in nodes):
                validate_model_node_ids(raw_nodes)
            if uses_shared_weights:
                for node in nodes:
                    raw_node_id = node.get("id")
                    if (
                        weight_groups is not None
                        and isinstance(raw_node_id, str)
                        and raw_node_id.casefold() == "_shared"
                    ):
                        raise ValueError('model node id "_shared" is reserved')
                    node_id = safe_source_id(raw_node_id, "model node id")
                    normalize_weight_group_references(
                        node,
                        weight_groups,
                        field_name=f"nodes[{node_id}].weight_groups",
                    )
                    if "weight_groups" in node and "weight_variants" in node:
                        raise ValueError(
                            f'model node "{node_id}": weight_variants cannot be combined '
                            "with weight_groups"
                        )
                    if "weight_groups" in node and "hf_repo" in node:
                        raise ValueError(
                            f'model node "{node_id}" must use model_sources for private '
                            "weights when weight_groups are declared"
                        )
            for node in nodes:
                declared_inputs = node.get("inputs")
                uses_scene_input = (
                    node.get("input", "image") == "scene"
                    or (isinstance(declared_inputs, list) and "scene" in declared_inputs)
                )
                if uses_scene_input and (
                    "inputs" in node or node.get("input", "image") != "scene"
                ):
                    raise ValueError(
                        f'model node "{node.get("id", "unknown")}" must declare scene '
                        'as its single input field'
                    )

            # Markers left while setup or runtime registration is unfinished:
            # the folder is not ready to be loaded. The readable manifest lets
            # the UI attach this error to each expected model node even when
            # startup could not immediately restore a locked backup.
            install_interrupted = (
                (ext_dir / ".modly-incomplete").exists()
                or (ext_dir / ".modly-registration-pending").exists()
                or (
                    _registration_pending(ext_id)
                    and not (
                        any(authorization[0] == ext_id
                        and authorization[1].exists()
                        # Normalize like the capability's destination (resolved
                        # root + name): EXTENSIONS_DIR may be a Windows 8.3 short
                        # path. The extension folder itself is not resolved.
                        and authorization[2]
                        == Path(os.path.abspath(ext_dir.parent.resolve() / ext_dir.name))
                        for authorization in registration_authorization)
                    )
                )
            )
            if install_interrupted:
                message = (
                    f"Extension '{ext_id}' has an incomplete installation "
                    "or interrupted runtime registration. "
                    "Restart Modly to recover it, or click 'Repair' on the Models page."
                )
                print(f"[Registry] ERROR: {message}")
                _record_discovery_error(
                    errors,
                    message,
                    manifest=manifest,
                    fallback_id=ext_dir.name,
                )
                continue

            if not generator_path.exists():
                message = f"Extension '{ext_id}' is missing generator.py."
                print(f"[Registry] ERROR: {message}")
                _record_discovery_error(
                    errors,
                    message,
                    manifest=manifest,
                    fallback_id=ext_dir.name,
                )
                continue

            # --- Subprocess mode (new): venv present → use ExtensionProcess ---
            # Also force subprocess mode for extensions that ship a build_vendor.py
            # but whose vendor/ directory hasn't been built yet: this surfaces a
            # loadError in the UI (Repair button) so the user can run setup.py.
            has_venv         = _venv_python(ext_dir).is_file()
            has_setup        = (ext_dir / "setup.py").is_file()
            has_build_vendor = (ext_dir / "build_vendor.py").exists()
            vendor_built     = (ext_dir / "vendor").exists()
            needs_setup      = (has_setup and not has_venv) or (has_build_vendor and not vendor_built)
            subprocess_mode  = has_venv or needs_setup

            cls_or_None = None
            legacy_context = None
            if not subprocess_mode:
                # --- Direct mode (legacy): no venv → load generator.py directly ---
                # Plain sibling imports are exposed only inside the serialized
                # import context. Never leave extension roots on host sys.path.
                legacy_context = legacy_imports.register(ext_dir)
                with legacy_imports.activate(legacy_context):
                    module_name = f"extensions.{ext_id}.generator"
                    spec   = importlib.util.spec_from_file_location(module_name, generator_path)
                    if spec is None or spec.loader is None:
                        raise ImportError(f"Could not create an import spec for {generator_path}")
                    module = importlib.util.module_from_spec(spec)
                    sys.modules[module_name] = module
                    spec.loader.exec_module(module)
                    cls_or_None = getattr(module, class_name)

            legacy_paths_by_owner: Dict[str, list[str]] = {}
            for node in nodes:
                owner_id = node.get("weight_owner_id", node["id"])
                if "weight_owner_id" in node:
                    owner_id = safe_source_id(owner_id, "weight_owner_id")
                weight_owner_id = f"{ext_id}/{owner_id}"
                legacy_paths_by_owner.setdefault(weight_owner_id, []).append(f"{ext_id}/{node['id']}")

            # Existing node/source IDs are ASCII. Use the same portable identity
            # for canonical roots and every alias as the Electron planner does;
            # never lowercase paths on disk or merge differently-spelled roots.
            roots: Dict[str, Tuple[str, str]] = {}
            for owner, legacy_paths in legacy_paths_by_owner.items():
                for spelling in [owner, *legacy_paths]:
                    key = spelling.lower()
                    previous = roots.get(key)
                    if previous and previous[0] != spelling:
                        raise ValueError(
                            f"weight roots {previous[0]!r} and {spelling!r} are not portable-unique"
                        )
                    if previous and previous[1] != owner:
                        raise ValueError(f"weight owner {owner!r} overlaps another owner's legacy path")
                    roots[key] = (spelling, owner)

            if nodes:
                for node in nodes:
                    weight_owner_id = f"{ext_id}/{node.get('weight_owner_id', node['id'])}"
                    legacy_paths = list(legacy_paths_by_owner[weight_owner_id])
                    model_sources = normalize_model_sources(node)
                    group_ids = normalize_weight_group_references(
                        node,
                        weight_groups,
                        field_name=f"nodes[{node['id']}].weight_groups",
                    ) or []
                    weight_variants = normalize_weight_variants(
                        node, node.get("params_schema", manifest.get("params_schema", []))
                    )
                    node_manifest = {
                        **manifest,
                        "id":               f"{ext_id}/{node['id']}",
                        "capability_id":    f"{ext_id}/{node['id']}",
                        "bundle_id":        ext_id,
                        "weight_owner_id":  weight_owner_id,
                        "shared_owner":     len(legacy_paths) > 1,
                        "legacy_paths":     legacy_paths,
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
                        "hf_include_prefixes": node.get("hf_include_prefixes", []),
                        "params_schema":    node.get("params_schema", manifest.get("params_schema", [])),
                        "input":            node.get("input", "image"),
                        "inputs":           node.get("inputs"),
                        "output":           node.get("output", "mesh"),
                        "weight_groups":    [group_by_id[group_id] for group_id in group_ids],
                    }
                    if model_sources is not None:
                        node_manifest["model_sources"] = model_sources
                    if weight_variants is not None:
                        node_manifest["weight_variants"] = weight_variants
                    full_id = f"{ext_id}/{node['id']}"
                    result[full_id] = (cls_or_None, node_manifest, ext_dir, legacy_context)
                    if subprocess_mode:
                        if has_venv:
                            print(f"[Registry] Loaded subprocess node: {full_id}")
                        else:
                            print(f"[Registry] Node '{full_id}' needs setup (venv missing)")
                    else:
                        print(f"[Registry] Loaded node: {full_id} ({class_name})")
            else:
                # No nodes defined — register by ext_id as fallback
                result[ext_id] = (cls_or_None, manifest, ext_dir, legacy_context)
                if subprocess_mode:
                    if has_venv:
                        print(f"[Registry] Loaded subprocess extension: {ext_id}")
                    else:
                        print(f"[Registry] Extension '{ext_id}' needs setup (venv missing)")
                else:
                    print(f"[Registry] Loaded extension: {ext_id} ({class_name})")

        except Exception as exc:
            message = f"Failed to discover extension '{ext_dir.name}': {exc}"
            print(f"[Registry] ERROR: {message}")
            _record_discovery_error(
                errors,
                message,
                manifest=manifest,
                fallback_id=ext_dir.name,
            )

    return result, errors


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
        # Serializes everything that changes which generators exist or are
        # loaded (switch/load, unload, reload, path changes). Read-only status
        # calls deliberately skip it: a load can hold it for minutes (first-run
        # downloads happen inside load()), and status must stay responsive.
        self._lifecycle_lock = threading.RLock()
        # Lock order: lifecycle -> publication. Readers take only publication,
        # release it before import isolation/extension hooks/IO, and never wait
        # for lifecycle while holding it. Publication contains host writes only.
        self._path_publication_lock = threading.Lock()
        self._legacy_imports = _LegacyImportManager()
        self._active_id:  str = os.environ.get("SELECTED_MODEL_ID", "sf3d")
        self._runtime_readiness_ttl_seconds = 30.0
        self._runtime_readiness_timeout_seconds = _DEFAULT_RUNTIME_READINESS_TIMEOUT_SECONDS
        self._runtime_readiness_epoch = 0
        self._runtime_readiness_cache: Dict[tuple, tuple[float, dict]] = {}
        self._runtime_readiness_inflight: Dict[tuple, Future] = {}
        self._runtime_readiness_lock = threading.Lock()
        self._runtime_readiness_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="runtime-readiness")

    def initialize(
        self,
        registration_authorization: Tuple[RegistrationValidationAuthorization, ...] = (),
    ) -> None:
        """Discovers and instantiates all extensions. Call at startup."""
        extensions, discovery_errors = _discover_extensions(
            self._legacy_imports,
            registration_authorization,
        )
        self._errors.update(discovery_errors)

        model_ids_by_owner: Dict[str, list[str]] = {}
        for discovered_model_id, (_, discovered_manifest, _, _) in extensions.items():
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
            cls, manifest, ext_dir, legacy_context = entry
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
                    if not _venv_python(ext_dir).is_file():
                        raise RuntimeError(
                            "venv not found — extension needs setup. "
                            "Click 'Repair' on the Models page to run setup.py."
                        )
                    # Subprocess mode: wrap in ExtensionProcess
                    gen = ExtensionProcess(ext_dir, manifest)
                    # Pin the subprocess envelope to the exact registry key;
                    # multi-node workers must never fall back to an extension ID.
                    gen.MODEL_ID    = model_id
                    gen.model_dir   = resolve_active_model_dir(MODELS_DIR, manifest)
                    gen.outputs_dir = WORKSPACE_DIR
                else:
                    # Legacy direct mode
                    if legacy_context is None:
                        raise RuntimeError("legacy import context is missing")
                    with self._legacy_imports.activate(legacy_context):
                        direct_gen = cls(resolve_active_model_dir(MODELS_DIR, manifest), WORKSPACE_DIR)
                    gen = _LegacyGeneratorProxy(
                        direct_gen,
                        self._legacy_imports,
                        legacy_context,
                    )
                    gen.model_id = model_id
                    gen.input = manifest["input"]
                    gen.hf_repo          = manifest.get("hf_repo", "")
                    gen.hf_downloads      = manifest.get("hf_downloads", [])
                    gen.https_downloads   = manifest.get("https_downloads", [])
                    gen.hf_skip_prefixes = manifest.get("hf_skip_prefixes", [])
                    gen.download_check   = manifest.get("download_check", "")
                    gen._params_schema   = manifest.get("params_schema", [])

                gen.MODEL_ID = model_id
                gen.MODEL_NODE_ID = manifest.get("node_id", "")
                gen.shared_model_dirs = {
                    group["id"]: resolve_weight_group_root(
                        MODELS_DIR, manifest.get("ext_id", model_id.split("/", 1)[0]), group["id"]
                    )
                    for group in manifest.get("weight_groups", [])
                }

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
        return canonical_model_dir(MODELS_DIR, {"id": model_id, **self.get_manifest(model_id)})

    def resolve_active_model_dir(self, model_id: str) -> Path:
        return resolve_active_model_dir(MODELS_DIR, {"id": model_id, **self.get_manifest(model_id)})

    def _rebind_unloaded_model_dir(self, model_id: str, gen: BaseGenerator) -> None:
        """Called only under the lifecycle lock after confirmed runtime teardown.

        A root is pinned for the runtime lifetime, even after cooperative unload:
        the runner (and direct adapters) may cache paths in their constructor.
        Status/getters never retarget a live runtime. Free Memory, scoped unload,
        registry reload and path updates provide explicit adoption boundaries.
        """
        if model_id not in self._manifests:
            return
        model_dir = self.resolve_active_model_dir(model_id)
        if gen.model_dir == model_dir:
            return
        if isinstance(gen, _LegacyGeneratorProxy):
            gen.rebind_unloaded_model_dir(model_dir)
        else:
            gen.model_dir = model_dir

    def reload(self, validation_capability: object = None) -> None:
        """
        Re-scans extensions and updates the registry without restarting FastAPI.
        Unloads all current generators before reloading.
        """
        # Each child still needs its own exact, single-use host capability.
        # Invalid/replayed siblings never inherit another child's authorization.
        capabilities = validation_capability if isinstance(validation_capability, list) else [validation_capability]
        registration_authorization = tuple(
            authorization for capability in capabilities
            if (authorization := _consume_registration_validation_capability(capability)) is not None
        )
        with self._lifecycle_lock:
            print("[Registry] Reloading extensions...")
            self._invalidate_runtime_readiness()
            for gen in self._generators.values():
                if isinstance(gen, ExtensionProcess):
                    gen.stop()
                    if gen._proc is not None:
                        raise RuntimeError(
                            "Extension subprocess remained attached after stop()"
                        )
                else:
                    try:
                        gen.unload()
                    except Exception:
                        pass
            self._generators.clear()
            self._manifests.clear()
            self._errors.clear()
            self._remove_legacy_paths()
            self.initialize(registration_authorization)
            print("[Registry] Reload complete.")

    def load_errors(self) -> Dict[str, str]:
        """Returns extension loading errors."""
        return dict(self._errors)

    def _remove_legacy_paths(self) -> None:
        """Clears direct-extension import state owned by this registry."""
        self._legacy_imports.clear()

    # ------------------------------------------------------------------ #
    # Generator access
    # ------------------------------------------------------------------ #

    @staticmethod
    def _assert_not_quarantined(model_id: str) -> None:
        extension_id = model_id.split("/", 1)[0]
        if _registration_pending(extension_id):
            raise ValueError(
                f"Model ID '{model_id}' belongs to an extension with pending "
                "runtime registration. Repair or reload the extension first."
            )

    def get_active(self) -> BaseGenerator:
        """Returns the active generator. Downloads and loads if necessary."""
        with self._lifecycle_lock:
            return self.get_ready_generator(self._active_id)

    def get_ready_generator(self, model_id: str) -> BaseGenerator:
        """Load and return exactly ``model_id`` without consulting active state."""
        with self._lifecycle_lock:
            gen = self.get_generator(model_id)
            downloaded = self._is_downloaded(model_id, gen)
            manifest = self._manifests[model_id]
            if (
                "model_sources" in manifest or manifest.get("weight_groups")
            ) and not downloaded:
                raise RuntimeError(
                    "Model sources are incomplete. Download this node's shared and private weights "
                    "from the Modly Models page before generation."
                )
            if not gen.is_loaded():
                self._invalidate_runtime_readiness(model_id)
                if not downloaded:
                    if getattr(gen, "https_downloads", []):
                        raise RuntimeError(
                            f"[{model_id}] Manifest-owned https_downloads "
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

    def activate_ready_generator(self, model_id: str) -> BaseGenerator:
        """Atomically make ``model_id`` active and return it ready for inference."""
        with self._lifecycle_lock:
            self.switch_model(model_id)
            return self.get_ready_generator(model_id)

    def model_status(self, model_id: str) -> dict:
        gen = self.get_generator(model_id)
        manifest = self._manifests[model_id]
        return {
            "id": model_id,
            "name": manifest.get("name", gen.DISPLAY_NAME),
            "input": self.get_model_input(model_id),
            "downloaded": self._is_downloaded(model_id, gen),
            "loaded": gen.is_loaded(),
        }

    def assert_weight_variant_installed(
        self, params: dict, model_id: Optional[str] = None
    ) -> None:
        """Refuse generation when the weight variant selected by params is not installed.

        ``model_id`` is the job's model. Pinned jobs only switch to it once they
        run, so the active model is not a reliable stand-in before that.
        """
        target_id = model_id or self._active_id
        manifest = self._manifests.get(target_id, {})
        variants = manifest.get("weight_variants")
        if variants is None:
            return
        # Check the bound execution root, not a newly appeared preferred folder.
        gen = self.get_generator(target_id)
        models_dir, model_dir = self._snapshot_model_paths(gen)
        option = missing_weight_variant(
            models_dir, model_dir.relative_to(models_dir).as_posix(), variants, params
        )
        if option is not None:
            raise RuntimeError(
                f'{option["label"]} weights for {target_id} are not installed. '
                "Install them from the Extensions page, or select an installed variant."
            )

    def get_generator(self, model_id: str) -> BaseGenerator:
        self._assert_not_quarantined(model_id)
        if model_id not in self._generators:
            raise ValueError(
                f"Unknown model ID: '{model_id}'. "
                f"Available: {list(self._generators.keys())}"
            )
        return self._generators[model_id]

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
        with self._lifecycle_lock:
            self._assert_not_quarantined(model_id)
            if model_id not in self._generators:
                raise ValueError(
                    f"Unknown model ID: '{model_id}'. "
                    f"Available: {list(self._generators.keys())}"
                )
            # 3D generation owns the GPU: evict the chat LLMs before anything is
            # about to allocate on it. The trigger is "the target model is not
            # resident", not "the target model changed" — the common case is the
            # default generator, which is already `_active_id` at boot and still
            # has to load its weights. Gating on the id alone let a full LLM pool
            # (2 slots, ~11.6 GB of 12) sit through an entire generation.
            target = self._generators[model_id]
            if model_id != self._active_id or not target.is_loaded():
                from services.llm_server import llama_pool
                llama_pool.unload_all()

            if model_id != self._active_id:
                if self._active_id in self._generators:
                    self._invalidate_runtime_readiness(self._active_id)
                    self._generators[self._active_id].unload()
                self._active_id = model_id

    # ------------------------------------------------------------------ #
    # Status
    # ------------------------------------------------------------------ #

    def _snapshot_model_paths(self, gen: BaseGenerator) -> Tuple[Path, Path]:
        """Capture a matching root/target without waiting on model lifecycle."""
        with self._path_publication_lock:
            models_dir = MODELS_DIR
            if isinstance(gen, _LegacyGeneratorProxy):
                target = object.__getattribute__(gen, "_target")
            else:
                # ExtensionProcess is host-owned; this is a plain path field.
                return models_dir, gen.model_dir
        # The target stays stable even if its proxy is replaced after capture.
        # Never acquire import isolation (or call extension code) under the
        # publication lock: a constructor may itself query registry status.
        manager = object.__getattribute__(gen, "_manager")
        context = object.__getattribute__(gen, "_context")
        with manager.activate(context):
            return models_dir, target.model_dir

    def _is_downloaded(self, model_id: str, gen: BaseGenerator) -> bool:
        manifest = self._manifests[model_id]
        if "model_sources" not in manifest and not manifest.get("weight_groups"):
            return gen.is_downloaded()
        private_ready = True
        models_dir, model_dir = self._snapshot_model_paths(gen)
        if "model_sources" in manifest:
            private_ready = model_sources_are_downloaded(
                models_dir, model_dir.relative_to(models_dir).as_posix(), manifest["model_sources"]
            )
        shared_ready = all(
            weight_group_sources_are_downloaded(
                models_dir,
                manifest.get("ext_id", model_id.split("/", 1)[0]),
                group,
            )
            for group in manifest.get("weight_groups", [])
        )
        if "model_sources" in manifest or manifest.get("weight_groups"):
            hf_plan = manifest.get("hf_downloads", [])
            https_plan = manifest.get("https_downloads", [])
            structured_ready = (
                (not hf_plan or hf_download_assets_ready(model_dir, hf_plan))
                and (not https_plan or https_download_assets_ready(model_dir, model_id, https_plan))
            )
            return private_ready and shared_ready and structured_ready
        return gen.is_downloaded()

    def active_status(self) -> dict:
        return self.model_status(self._active_id)

    def all_status(self) -> list:
        result = []
        active_id = self._active_id
        # Snapshot: a concurrent reload() may clear the dicts mid-iteration.
        for model_id, gen in list(self._generators.items()):
            manifest = self._manifests.get(model_id)
            if manifest is None:
                continue
            result.append({
                "id":          model_id,
                "name":        manifest.get("name", gen.DISPLAY_NAME),
                "description": manifest.get("description", ""),
                "version":     manifest.get("version", ""),
                "vram_gb":     manifest.get("vram_gb", gen.VRAM_GB),
                "hf_repo":     manifest.get("hf_repo", ""),
                "tags":        manifest.get("tags", []),
                "input":       self.get_model_input(model_id),
                "downloaded":  self._is_downloaded(model_id, gen),
                "loaded":      gen.is_loaded(),
                "active":      model_id == active_id,
            })
        return result

    def _invalidate_runtime_readiness(self, model_id: Optional[str] = None) -> None:
        with self._runtime_readiness_lock:
            self._runtime_readiness_epoch += 1
            self._runtime_readiness_cache.clear()
            # Running hooks cannot be cancelled in Python. They keep their old
            # identity and cannot publish into the new lifecycle epoch.
            for future in self._runtime_readiness_inflight.values():
                future.cancel()
            self._runtime_readiness_inflight.clear()

    def _runtime_identity(self, model_id: str) -> tuple:
        # Snapshot host fields only. No extension getters/import lock under the
        # publication lock (same order as the existing root publication owner).
        with self._path_publication_lock:
            gen = self._generators.get(model_id)
            if gen is None:
                return ()
            target = (object.__getattribute__(gen, "_target")
                      if isinstance(gen, _LegacyGeneratorProxy) else gen)
            fields = vars(target)
            worker = fields.get("_proc")
            return (model_id, gen, target, worker,
                    fields.get("_runtime_revision", 0),
                    str(MODELS_DIR), str(WORKSPACE_DIR),
                    str(fields.get("model_dir")),
                    tuple(sorted((key, str(value)) for key, value in
                                 fields.get("shared_model_dirs", {}).items())),
                    self._runtime_readiness_epoch)

    def runtime_readiness(self, model_ids: list[str]) -> dict:
        """Bounded optional diagnostics; never select, load or download a model."""
        deadline = time.monotonic() + self._runtime_readiness_timeout_seconds
        readiness: dict[str, dict] = {}
        for model_id in dict.fromkeys(model_ids):
            if model_id in self._generators:
                readiness[model_id] = self._runtime_readiness_for_model(model_id, deadline)
        return readiness

    def _runtime_readiness_for_model(self, model_id: str, deadline: float) -> dict:
        identity = self._runtime_identity(model_id)
        now = time.monotonic()
        with self._runtime_readiness_lock:
            for key in list(self._runtime_readiness_cache):
                if key[0] == model_id and key != identity:
                    self._runtime_readiness_cache.pop(key, None)
            for key, completed in list(self._runtime_readiness_inflight.items()):
                if key != identity and completed.done():
                    self._runtime_readiness_inflight.pop(key, None)
            cached = self._runtime_readiness_cache.get(identity)
            if cached and now - cached[0] < self._runtime_readiness_ttl_seconds:
                return dict(cached[1])
            future = self._runtime_readiness_inflight.get(identity)
            if future is None and now < deadline:
                future = self._runtime_readiness_executor.submit(
                    self._compute_runtime_readiness, model_id, identity, deadline
                )
                self._runtime_readiness_inflight[identity] = future
        try:
            if future is None:
                raise TimeoutError()
            status = future.result(timeout=max(0, deadline - time.monotonic()))
            if self._runtime_identity(model_id) != identity:
                return _checking_failed_runtime_readiness()
            with self._runtime_readiness_lock:
                if self._runtime_readiness_epoch != identity[-1]:
                    return _checking_failed_runtime_readiness()
                self._runtime_readiness_cache[identity] = (time.monotonic(), status)
            return dict(status)
        except RuntimeReadinessUnavailable as exc:
            return {"ok": False, "machine_code": exc.machine_code,
                    "label_hint": "Checking failed", "reason": exc.reason,
                    "checked_at": _now_iso()}
        except Exception:
            # A late completion is not fresh evidence. Cancel queued probes and
            # retain running ones for deduplication until they settle.
            if future is not None:
                future.cancel()
            return self._runtime_readiness_failure(model_id, identity)
        finally:
            if future is not None and future.done():
                with self._runtime_readiness_lock:
                    if self._runtime_readiness_inflight.get(identity) is future:
                        self._runtime_readiness_inflight.pop(identity, None)

    def _compute_runtime_readiness(self, model_id: str, identity: tuple, deadline: float) -> dict:
        # Never queue behind a long model load or retain the global lifecycle
        # lock while executing an extension hook.
        if not self._lifecycle_lock.acquire(blocking=False):
            raise RuntimeReadinessUnavailable("runtime_busy", "Model lifecycle is busy.")
        try:
            if time.monotonic() >= deadline or self._runtime_identity(model_id) != identity:
                raise RuntimeError("Runtime readiness identity expired")
            gen = self.get_generator(model_id)
            if not isinstance(gen, ExtensionProcess):
                # A thread deadline cannot cancel extension code or release its
                # shared import-isolation lock. Decline this diagnostic only;
                # normal direct model loading/generation stays unchanged.
                return _unsupported_runtime_readiness(
                    "Runtime readiness requires an isolated worker; direct model use is unchanged."
                )
        finally:
            self._lifecycle_lock.release()
        if time.monotonic() >= deadline or self._runtime_identity(model_id) != identity:
            raise TimeoutError("Runtime readiness check expired")
        status = gen.readiness_status()
        if time.monotonic() >= deadline:
            raise TimeoutError("Runtime readiness check expired")
        return _sanitize_runtime_readiness(status)

    def _runtime_readiness_failure(self, model_id: str, identity: tuple) -> dict:
        if self._runtime_identity(model_id) != identity:
            return _checking_failed_runtime_readiness()
        with self._runtime_readiness_lock:
            cached = self._runtime_readiness_cache.get(identity)
        if cached:
            return {**cached[1], "stale": True}
        return _checking_failed_runtime_readiness()

    def params_schema(self, model_id: Optional[str] = None) -> list:
        target_id = model_id or self._active_id
        gen = self._generators.get(target_id)
        if gen is None:
            raise KeyError(target_id)
        return gen.params_schema()

    # ------------------------------------------------------------------ #
    # Paths update & shutdown
    # ------------------------------------------------------------------ #

    def update_paths(self, models_dir: Optional[Path], workspace_dir: Optional[Path]) -> None:
        global MODELS_DIR, WORKSPACE_DIR

        with self._lifecycle_lock:
            if models_dir is None:
                # Preserve the existing workspace-only update contract.
                if workspace_dir is not None:
                    self._invalidate_runtime_readiness()
                    workspace_dir.mkdir(parents=True, exist_ok=True)
                    WORKSPACE_DIR = workspace_dir
                    for gen in self._generators.values():
                        gen.outputs_dir = workspace_dir
                return

            models_dir.mkdir(parents=True, exist_ok=True)
            next_workspace = workspace_dir if workspace_dir is not None else WORKSPACE_DIR
            if workspace_dir is not None:
                workspace_dir.mkdir(parents=True, exist_ok=True)

            # Release runtimes, but do not adopt even an old-root alias yet.
            # Preparation may fail after earlier adapters succeeded; all old
            # targets and path metadata must then remain usable (unloaded).
            self.unload_all(rebind_paths=False)
            prepared = []
            # Retain old targets through the critical section so even an
            # extension finalizer cannot run as a side effect of pointer swaps.
            retired_targets = []
            for model_id, gen in self._generators.items():
                manifest = self._manifests[model_id]
                model_dir = resolve_active_model_dir(models_dir, {"id": model_id, **manifest})
                shared_dirs = {
                    group["id"]: resolve_weight_group_root(
                        models_dir,
                        manifest.get("ext_id", model_id.split("/", 1)[0]),
                        group["id"],
                    )
                    for group in manifest.get("weight_groups", [])
                }
                if isinstance(gen, _LegacyGeneratorProxy):
                    retired_targets.append(object.__getattribute__(gen, "_target"))
                    replacement = gen.prepare_path_replacement(
                        model_dir, next_workspace, shared_dirs
                    )
                    prepared.append((gen, replacement))
                elif isinstance(gen, ExtensionProcess):
                    prepared.append((gen, {
                        "model_dir": model_dir,
                        "outputs_dir": next_workspace,
                        "shared_model_dirs": shared_dirs,
                    }))
                else:
                    raise TypeError("Unsupported unwrapped generator during path update")

            # No constructors, extension setters, imports, filesystem work or
            # fallible path resolution after publication starts. Stable proxies
            # are preserved; stopped subprocess wrappers receive plain fields.
            with self._path_publication_lock:
                for gen, replacement in prepared:
                    if isinstance(gen, _LegacyGeneratorProxy):
                        object.__setattr__(gen, "_target", replacement)
                    else:
                        gen.__dict__.update(replacement)
                MODELS_DIR = models_dir
                WORKSPACE_DIR = next_workspace

    def _unload_generator(
        self, model_id: str, gen: BaseGenerator, *, rebind_paths: bool = True
    ) -> bool:
        self._invalidate_runtime_readiness(model_id)
        if isinstance(gen, ExtensionProcess):
            # Cooperative unload leaves the constructor and MODEL_DIR alive.
            gen.stop()
        else:
            gen.unload()
            if gen.is_loaded():
                return False
        if rebind_paths:
            self._rebind_unloaded_model_dir(model_id, gen)
        return True

    def unload_model(self, model_id: str) -> bool:
        """Confirm scoped release and adopt preferred storage at this boundary."""
        with self._lifecycle_lock:
            return self._unload_generator(model_id, self.get_generator(model_id))

    def unload_all(self, *, rebind_paths: bool = True) -> None:
        with self._lifecycle_lock:
            still_loaded = []
            for model_id, gen in self._generators.items():
                if not self._unload_generator(model_id, gen, rebind_paths=rebind_paths):
                    still_loaded.append(model_id)
            if still_loaded:
                raise RuntimeError(
                    "Models are still loaded; weights were preserved: "
                    + ", ".join(still_loaded)
                )


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
    if re.search(r"\b[A-Za-z]:[\\/]", value):
        return True
    if re.search(r"(^|\s)/(?:home|users|private|tmp|var|etc|opt|usr|root)(?:/|\s|$)", value):
        return True
    return False


def _safe_url(value) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 500 or "\\" in value:
        return None
    if any(ord(c) <= 32 or ord(c) == 127 or c.isspace() for c in value):
        return None
    try:
        parsed = urlparse(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            return None
        parsed.port  # Reject malformed ports rather than forwarding them.
    except ValueError:
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
        if not isinstance(kind, str) or not isinstance(safety, str):
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
        if isinstance(action.get("refresh_after"), str) and action["refresh_after"] in _ACTION_REFRESH_AFTER:
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


def _unsupported_runtime_readiness(reason: str = "Model does not expose runtime readiness.") -> dict:
    return {
        "ok": False,
        "machine_code": "unsupported_contract",
        "label_hint": "Checking failed",
        "reason": reason,
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
        "ok": status.get("ok") is True,
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
