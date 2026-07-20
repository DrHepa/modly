import queue
import threading
import time
import os

from services.extension_process import ExtensionProcess
from services.generator_registry import (
    GeneratorRegistry,
    _DEFAULT_RUNTIME_READINESS_TIMEOUT_SECONDS,
)
os.environ.setdefault("EXTENSION_DIR", "/tmp/modly-test-extension")
import runner


class CountingReadinessGenerator:
    DISPLAY_NAME = "Counting"
    VRAM_GB = 0

    def __init__(self, statuses: list[dict] | None = None):
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

    def readiness_status(self) -> dict:
        self.calls += 1
        self.release.wait(timeout=1)
        status = self.statuses[min(self.calls - 1, len(self.statuses) - 1)]
        if isinstance(status, Exception):
            raise status
        return status


class LegacyGenerator:
    DISPLAY_NAME = "Legacy"
    VRAM_GB = 0


class RecordingExtensionProcess(ExtensionProcess):
    def __init__(self, model_id: str):
        self.MODEL_ID = model_id
        self.model_id = model_id
        self.stop_calls = 0
        self.unload_calls = 0
        self.load_calls = 0
        self.readiness_calls = 0

    def stop(self) -> None:
        self.stop_calls += 1

    def unload(self) -> None:
        self.unload_calls += 1

    def load(self) -> None:
        self.load_calls += 1

    def readiness_status(self) -> dict:
        self.readiness_calls += 1
        return {"ok": True, "machine_code": "ready"}


class RecordingDirectGenerator:
    DISPLAY_NAME = "Direct"
    VRAM_GB = 0

    def __init__(self):
        self.unload_calls = 0

    def unload(self) -> None:
        self.unload_calls += 1


def _registry(model_id: str, generator) -> GeneratorRegistry:
    registry = GeneratorRegistry()
    registry._generators = {model_id: generator}
    registry._manifests = {model_id: {"id": model_id, "name": "Runtime"}}
    registry._active_id = model_id
    return registry


def _ready_status_with_actions() -> dict:
    return {
        "ok": False,
        "machine_code": "preflight/runtime_missing",
        "label_hint": "Setup Codex",
        "checked_at": "2026-04-24T00:00:00Z",
        "actions": [
            {
                "id": "setup.codex",
                "kind": "show_guidance",
                "label": "Setup Codex",
                "guidance": "Install the user-managed runtime using the official guide, then refresh readiness.",
                "safety": "manual",
                "refresh_after": "never",
            },
            {
                "id": "codex.docs",
                "kind": "open_external_url",
                "label": "Open Codex setup docs",
                "docs_url": "https://developers.openai.com/codex/cli",
                "safety": "non_destructive",
            },
            {
                "id": "refresh",
                "kind": "refresh_readiness",
                "label": "Refresh",
                "safety": "non_destructive",
            },
        ],
        "details": {
            "title": "Codex runtime setup",
            "summary": "Runtime is not ready yet.",
            "guidance": "Complete setup outside Modly and refresh.",
            "diagnostics": {
                "runtime_source": "missing",
                "runtime_name": "codex",
                "runtime_version": "unknown",
                "runtime_version_supported": "false",
                "supported_versions": "0.122.0",
                "platform_supported": "true",
                "platform_key": "linux-x64",
                "auth_state": "unknown",
                "entitlement_state": "unknown",
                "extension_setup_state": "ok",
                "extension_import_state": "ok",
                "codex_app_server_state": "unknown",
                "readiness_source": "extension",
                "diagnostic_status": "complete",
                "last_checked_at": "2026-04-24T00:00:00Z",
            },
        },
    }


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


def test_registry_passes_through_bounded_generic_actions_and_details_when_safe():
    generator = CountingReadinessGenerator(statuses=[_ready_status_with_actions()])
    registry = _registry("runtime-ext/text-to-image", generator)

    readiness = registry.runtime_readiness(["runtime-ext/text-to-image"])["runtime-ext/text-to-image"]

    assert readiness["actions"] == _ready_status_with_actions()["actions"]
    assert readiness["details"] == _ready_status_with_actions()["details"]
    assert readiness["machine_code"] == "preflight/runtime_missing"


def test_registry_strips_unsafe_actions_details_and_unsupported_fields():
    unsafe_status = _ready_status_with_actions()
    unsafe_status["actions"] = [
        {
            "id": "valid-guidance",
            "kind": "show_guidance",
            "label": "Safe guidance",
            "guidance": "Use official docs and refresh after finishing.",
            "safety": "manual",
            "secret": "unsupported field must not survive",
        },
        {"id": "bad-kind", "kind": "preflight/install", "label": "Install", "safety": "confirm"},
        {
            "id": "bad-url",
            "kind": "open_external_url",
            "label": "Open unsafe docs",
            "docs_url": "file:///private/token.txt",
            "safety": "non_destructive",
        },
        {"id": "bad path", "kind": "show_details", "label": "Bad id", "safety": "manual"},
        {"id": "a1", "kind": "show_details", "label": "One", "safety": "manual"},
        {"id": "a2", "kind": "show_details", "label": "Two", "safety": "manual"},
        {"id": "a3", "kind": "show_details", "label": "Three", "safety": "manual"},
        {"id": "a4", "kind": "show_details", "label": "Four", "safety": "manual"},
        {"id": "a5", "kind": "show_details", "label": "Five", "safety": "manual"},
        {"id": "a6", "kind": "show_details", "label": "Six", "safety": "manual"},
    ]
    unsafe_status["details"] = {
        "title": "Diagnostics",
        "summary": "No raw command output is preserved.",
        "diagnostics": {
            "runtime_name": "codex",
            "auth_state": "missing",
            "token": "sk-secret-token",
            "raw_output": "Traceback with command output and HOME=/private/user",
            "runtime_source": "/private/user/bin/codex",
            "platform_key": "../../etc/passwd",
        },
        "unsupported": "field must not survive",
    }
    unsafe_status["extra"] = {"must": "drop"}
    generator = CountingReadinessGenerator(statuses=[unsafe_status])
    registry = _registry("runtime-ext/text-to-image", generator)

    readiness = registry.runtime_readiness(["runtime-ext/text-to-image"])["runtime-ext/text-to-image"]

    assert readiness["actions"] == [
        {
            "id": "valid-guidance",
            "kind": "show_guidance",
            "label": "Safe guidance",
            "guidance": "Use official docs and refresh after finishing.",
            "safety": "manual",
        },
        {"id": "a1", "kind": "show_details", "label": "One", "safety": "manual"},
        {"id": "a2", "kind": "show_details", "label": "Two", "safety": "manual"},
        {"id": "a3", "kind": "show_details", "label": "Three", "safety": "manual"},
        {"id": "a4", "kind": "show_details", "label": "Four", "safety": "manual"},
    ]
    assert readiness["details"] == {
        "title": "Diagnostics",
        "summary": "No raw command output is preserved.",
        "diagnostics": {"runtime_name": "codex", "auth_state": "missing"},
    }
    assert "extra" not in readiness
    assert "secret" not in str(readiness)
    assert "private" not in str(readiness)
    assert "Traceback" not in str(readiness)
    assert ".." not in str(readiness)


def test_registry_strips_repair_extension_from_runtime_readiness_actions():
    status = _ready_status_with_actions()
    status["actions"] = [
        {
            "id": "repair-extension",
            "kind": "repair_extension",
            "label": "Repair extension",
            "safety": "confirm",
            "requires_confirmation": True,
            "confirmation": {
                "title": "Repair extension",
                "body": "Run existing extension repair setup.",
                "confirm_label": "Repair",
            },
        },
        {"id": "refresh", "kind": "refresh_readiness", "label": "Refresh", "safety": "non_destructive"},
    ]
    generator = CountingReadinessGenerator(statuses=[status])
    registry = _registry("runtime-ext/text-to-image", generator)

    readiness = registry.runtime_readiness(["runtime-ext/text-to-image"])["runtime-ext/text-to-image"]

    assert readiness["actions"] == [
        {"id": "refresh", "kind": "refresh_readiness", "label": "Refresh", "safety": "non_destructive"}
    ]
    assert "repair_extension" not in str(readiness)


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


def test_registry_uses_bounded_longer_default_runtime_readiness_timeout():
    registry = GeneratorRegistry()

    assert registry._runtime_readiness_timeout_seconds == _DEFAULT_RUNTIME_READINESS_TIMEOUT_SECONDS
    assert 5.0 < registry._runtime_readiness_timeout_seconds <= 45.0


def test_registry_marks_models_without_readiness_as_unsupported_contract():
    registry = _registry("legacy-ext/image-to-mesh", LegacyGenerator())

    readiness = registry.runtime_readiness(["legacy-ext/image-to-mesh"])["legacy-ext/image-to-mesh"]

    assert readiness["ok"] is False
    assert readiness["machine_code"] == "unsupported_contract"
    assert readiness["reason"] == "Model does not expose runtime readiness."


def test_extension_process_sends_runtime_readiness_action_with_bounded_timeout(monkeypatch):
    process = ExtensionProcess.__new__(ExtensionProcess)
    process.MODEL_ID = "runtime-ext/text-to-image"
    process.model_id = "runtime-ext/text-to-image"
    process.model_dir = None
    process.hf_downloads = []
    process.https_downloads = []
    process._queue = queue.Queue()
    sent: list[dict] = []
    recv_timeouts: list[float | None] = []
    monkeypatch.setattr(process, "_ensure_started", lambda: None)
    monkeypatch.setattr(process, "_send", sent.append)

    def fake_recv(timeout):
        recv_timeouts.append(timeout)
        return {"type": "runtime_readiness", "status": {"ok": True, "machine_code": "ready"}}

    monkeypatch.setattr(process, "_recv", fake_recv)

    status = process.readiness_status()

    assert sent == [{"action": "runtime_readiness"}]
    assert status == {"ok": True, "machine_code": "ready"}
    assert len(recv_timeouts) == 1
    assert _DEFAULT_RUNTIME_READINESS_TIMEOUT_SECONDS - 0.5 <= recv_timeouts[0] <= _DEFAULT_RUNTIME_READINESS_TIMEOUT_SECONDS


def test_runner_returns_generator_readiness_or_unsupported_contract():
    class ReadyGenerator:
        def readiness_status(self):
            return {"ok": True, "machine_code": "ready"}

    class UnsupportedGenerator:
        pass

    assert runner.resolve_runtime_readiness(ReadyGenerator()) == {"ok": True, "machine_code": "ready"}
    assert runner.resolve_runtime_readiness(UnsupportedGenerator())["machine_code"] == "unsupported_contract"


def test_registry_reload_stops_old_extension_process_before_rebuilding(monkeypatch):
    old_process = RecordingExtensionProcess("runtime-ext/text-to-image")
    registry = GeneratorRegistry()
    registry._generators = {"runtime-ext/text-to-image": old_process}
    registry._manifests = {"runtime-ext/text-to-image": {"id": "runtime-ext/text-to-image", "name": "Runtime"}}
    registry._errors = {"runtime-ext/text-to-image": "old error"}

    initialized = []
    monkeypatch.setattr(registry, "initialize", lambda: initialized.append(True))

    registry.reload()

    assert old_process.stop_calls == 1
    assert old_process.unload_calls == 0
    assert initialized == [True]


def test_registry_shutdown_stops_model_runners_and_unloads_direct_generators():
    extension_process = RecordingExtensionProcess("runtime-ext/text-to-image")
    direct_generator = RecordingDirectGenerator()
    registry = GeneratorRegistry()
    registry._generators = {
        "runtime-ext/text-to-image": extension_process,
        "legacy-ext/image-to-mesh": direct_generator,
    }
    registry._runtime_readiness_cache = {"runtime-ext/text-to-image": (time.monotonic(), {"ok": True})}
    registry._runtime_readiness_inflight = {"runtime-ext/text-to-image": object()}

    registry.shutdown_all()

    assert extension_process.stop_calls == 1
    assert extension_process.unload_calls == 0
    assert direct_generator.unload_calls == 1
    assert registry._runtime_readiness_cache == {}
    assert registry._runtime_readiness_inflight == {}


def test_runtime_readiness_startup_path_starts_pid_without_loading_weights(monkeypatch):
    process = RecordingExtensionProcess("runtime-ext/text-to-image")
    registry = GeneratorRegistry()
    registry._generators = {"runtime-ext/text-to-image": process}
    registry._manifests = {"runtime-ext/text-to-image": {"id": "runtime-ext/text-to-image", "name": "Runtime"}}

    monkeypatch.setattr(registry, "_sync_generator_model_dir", lambda model_id: process)

    readiness = registry.runtime_readiness(["runtime-ext/text-to-image"])

    assert readiness["runtime-ext/text-to-image"]["machine_code"] == "ready"
    assert process.readiness_calls == 1
    assert process.load_calls == 0
