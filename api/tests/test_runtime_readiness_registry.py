import queue
import threading
import time
import os

from services.extension_process import ExtensionProcess
from services.generator_registry import GeneratorRegistry
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
    assert readiness["reason"] == "Model does not expose runtime readiness."


def test_extension_process_sends_runtime_readiness_action_with_bounded_timeout(monkeypatch):
    process = ExtensionProcess.__new__(ExtensionProcess)
    process.MODEL_ID = "runtime-ext/text-to-image"
    process._queue = queue.Queue()
    sent: list[dict] = []
    monkeypatch.setattr(process, "_ensure_started", lambda: None)
    monkeypatch.setattr(process, "_send", sent.append)
    monkeypatch.setattr(process, "_recv", lambda timeout: {"type": "runtime_readiness", "status": {"ok": True, "machine_code": "ready"}})

    status = process.readiness_status()

    assert sent == [{"action": "runtime_readiness"}]
    assert status == {"ok": True, "machine_code": "ready"}


def test_runner_returns_generator_readiness_or_unsupported_contract():
    class ReadyGenerator:
        def readiness_status(self):
            return {"ok": True, "machine_code": "ready"}

    class UnsupportedGenerator:
        pass

    assert runner.resolve_runtime_readiness(ReadyGenerator()) == {"ok": True, "machine_code": "ready"}
    assert runner.resolve_runtime_readiness(UnsupportedGenerator())["machine_code"] == "unsupported_contract"
