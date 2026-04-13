import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR"
    b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00"
    b"\x90wS\xde"
    b"\x00\x00\x00\x0cIDATx\x9cc``\x00\x00\x00\x04\x00\x01"
    b"\x0b\xe7\x02\x9d"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)

VALID_MODEL_ID = "demo/fake"


class FakeGenerator:
    DISPLAY_NAME = "Fake Generator"
    VRAM_GB = 0

    def __init__(self, outputs_dir: Path):
        self.outputs_dir = outputs_dir
        self._loaded = False
        self.fail_with: Exception | None = None

    def is_loaded(self) -> bool:
        return self._loaded

    def is_downloaded(self) -> bool:
        return True

    def load(self) -> None:
        self._loaded = True

    def unload(self) -> None:
        self._loaded = False

    def generate(self, image_bytes: bytes, params: dict, progress_cb=None, cancel_event=None) -> Path:
        if self.fail_with is not None:
            raise self.fail_with

        if progress_cb:
            progress_cb(40, "Preparing mesh")
            progress_cb(85, "Writing mesh")

        filename = params.get("filename", "mesh.glb")
        output_path = self.outputs_dir / filename
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(image_bytes or b"glb")
        return output_path


@pytest.fixture
def api_modules(monkeypatch, tmp_path):
    pytest.importorskip("fastapi")

    import services.generation_jobs as generation_jobs
    import services.generator_registry as registry_module
    from services.generator_registry import generator_registry

    workspace_dir = tmp_path / "workspace"
    workspace_dir.mkdir()

    fake_generator = FakeGenerator(workspace_dir)

    monkeypatch.setattr(registry_module, "WORKSPACE_DIR", workspace_dir)
    monkeypatch.setattr(generation_jobs, "WORKSPACE_DIR", workspace_dir)
    monkeypatch.setattr(generator_registry, "_generators", {VALID_MODEL_ID: fake_generator}, raising=False)
    monkeypatch.setattr(generator_registry, "_manifests", {VALID_MODEL_ID: {"name": "Fake Generator"}}, raising=False)
    monkeypatch.setattr(generator_registry, "_errors", {}, raising=False)
    monkeypatch.setattr(generator_registry, "_active_id", VALID_MODEL_ID, raising=False)

    generation_jobs._jobs.clear()
    generation_jobs._cancelled.clear()
    generation_jobs._cancel_events.clear()

    yield {
        "fake_generator": fake_generator,
        "generation_jobs": generation_jobs,
        "workspace_dir": workspace_dir,
        "valid_model_id": VALID_MODEL_ID,
    }

    generation_jobs._jobs.clear()
    generation_jobs._cancelled.clear()
    generation_jobs._cancel_events.clear()


@pytest.fixture
def client(api_modules):
    pytest.importorskip("fastapi")

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import generation, status, workflow_runs

    app = FastAPI()
    app.include_router(status.router)
    app.include_router(generation.router, prefix="/generate")
    app.include_router(workflow_runs.router, prefix="/workflow-runs")

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def image_upload():
    return ("input.png", PNG_BYTES, "image/png")
