import os
import asyncio
import subprocess
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]


def test_main_import_succeeds_in_fresh_python_process():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import main; assert main.app is not None; print('ok')",
        ],
        cwd=API_DIR,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().endswith("ok")


def test_lifespan_uses_explicit_registry_shutdown(monkeypatch):
    import main

    calls: list[str] = []

    class FakeRegistry:
        def initialize(self):
            calls.append("initialize")

        def shutdown_all(self):
            calls.append("shutdown_all")

    monkeypatch.setattr("services.generator_registry.generator_registry", FakeRegistry())

    async def exercise() -> None:
        async with main.lifespan(object()):
            assert calls == ["initialize"]

    asyncio.run(exercise())

    assert calls == ["initialize", "shutdown_all"]
