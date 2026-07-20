import asyncio
import importlib
import json
import sys
import threading
from pathlib import Path
from types import ModuleType

import pytest


def _install_fake_huggingface_hub(monkeypatch, *, files: list[str]):
    module = ModuleType("huggingface_hub")
    module.list_repo_files = lambda repo_id, token=None: list(files)
    module.hf_hub_url = lambda repo_id, filename: f"https://hf.example/{repo_id}/{filename}"
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)


@pytest.fixture(autouse=True)
def _isolate_model_router_module():
    sys.modules.pop("routers.model", None)
    yield
    sys.modules.pop("routers.model", None)


def _load_model_router_module():
    return importlib.import_module("routers.model")


async def _collect_stream_events(response) -> list[dict]:
    payload = ""
    async for chunk in response.body_iterator:
        payload += chunk.decode() if isinstance(chunk, bytes) else chunk
    return [
        json.loads(frame.removeprefix("data: "))
        for frame in payload.split("\n\n")
        if frame
    ]


def test_hf_download_route_streams_progress_and_done(monkeypatch, tmp_path: Path):
    model_router = _load_model_router_module()

    model_id = "demo/generate"
    dest_dir = tmp_path / model_id
    calls = []

    _install_fake_huggingface_hub(monkeypatch, files=["weights.bin"])
    monkeypatch.setattr(
        model_router.generator_registry,
        "canonical_model_dir",
        lambda resolved_model_id: tmp_path / resolved_model_id,
    )
    monkeypatch.setattr(
        model_router.generator_registry,
        "get_manifest",
        lambda resolved_model_id: {},
    )

    def fake_download_file_streamed(**kwargs):
        calls.append(kwargs)
        target = Path(kwargs["dest_dir"]) / kwargs["filename"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"mesh")
        kwargs["progress_cb"]({
            "percent": kwargs["base_percent"],
            "file": kwargs["filename"],
            "fileIndex": kwargs["file_index"],
            "totalFiles": kwargs["total_files"],
            "status": "Downloading... 100%",
            "bytesDownloaded": 4,
            "totalBytes": 4,
            "stalledSeconds": 0,
        })
        return 4

    monkeypatch.setattr(model_router, "_download_file_streamed", fake_download_file_streamed)

    async def run_test() -> list[dict]:
        response = await model_router.hf_download(
            repo_id="owner/model",
            model_id=model_id,
            token="private-token",
        )
        return await _collect_stream_events(response)

    events = asyncio.run(run_test())

    assert calls and calls[0]["token"] == "private-token"
    assert calls[0]["dest_dir"] == str(dest_dir)
    assert events[0] == {"percent": 0, "status": "Listing repository files..."}
    assert any(event.get("status") == "Downloading... 100%" for event in events)
    assert events[-1] == {"percent": 100, "status": "done"}
    assert (dest_dir / "weights.bin").read_bytes() == b"mesh"


def test_hf_download_cancel_cleans_partial_files_and_preserves_completed_files(
    monkeypatch,
    tmp_path: Path,
):
    model_router = _load_model_router_module()

    model_id = "demo/generate"
    dest_dir = tmp_path / model_id
    finished = dest_dir / "keep.bin"
    finished.parent.mkdir(parents=True, exist_ok=True)
    finished.write_bytes(b"keep")
    started = threading.Event()

    _install_fake_huggingface_hub(monkeypatch, files=["weights.bin"])
    monkeypatch.setattr(
        model_router.generator_registry,
        "canonical_model_dir",
        lambda resolved_model_id: tmp_path / resolved_model_id,
    )
    monkeypatch.setattr(
        model_router.generator_registry,
        "get_manifest",
        lambda resolved_model_id: {},
    )

    def fake_download_file_streamed(**kwargs):
        part = Path(kwargs["dest_dir"]) / f"{kwargs['filename']}.part"
        part.parent.mkdir(parents=True, exist_ok=True)
        part.write_bytes(b"partial")
        kwargs["progress_cb"]({
            "percent": kwargs["base_percent"],
            "file": kwargs["filename"],
            "fileIndex": kwargs["file_index"],
            "totalFiles": kwargs["total_files"],
            "status": "Downloading...",
            "bytesDownloaded": 7,
            "totalBytes": 10,
            "stalledSeconds": 0,
        })
        started.set()
        while not kwargs["control"]["cancel"].wait(0.01):
            pass
        raise model_router.DownloadCancelled()

    monkeypatch.setattr(model_router, "_download_file_streamed", fake_download_file_streamed)

    async def run_test() -> list[dict]:
        response = await model_router.hf_download(
            repo_id="owner/model",
            model_id=model_id,
        )
        collect_task = asyncio.create_task(_collect_stream_events(response))
        await asyncio.to_thread(started.wait, 1.0)
        await model_router.cancel_hf_download(model_id)
        return await collect_task

    events = asyncio.run(run_test())

    assert any(event.get("cancelled") is True for event in events)
    assert not (dest_dir / "weights.bin.part").exists()
    assert finished.read_bytes() == b"keep"
    assert model_id not in model_router._download_controls


def test_hf_download_pause_preserves_partial_file_and_next_session_starts_fresh(
    monkeypatch,
    tmp_path: Path,
):
    model_router = _load_model_router_module()

    model_id = "demo/generate"
    dest_dir = tmp_path / model_id
    started = threading.Event()
    first_run = True

    _install_fake_huggingface_hub(monkeypatch, files=["weights.bin"])
    monkeypatch.setattr(
        model_router.generator_registry,
        "canonical_model_dir",
        lambda resolved_model_id: tmp_path / resolved_model_id,
    )
    monkeypatch.setattr(
        model_router.generator_registry,
        "get_manifest",
        lambda resolved_model_id: {},
    )

    def fake_download_file_streamed(**kwargs):
        nonlocal first_run
        assert not kwargs["control"]["cancel"].is_set()
        part = Path(kwargs["dest_dir"]) / f"{kwargs['filename']}.part"
        part.parent.mkdir(parents=True, exist_ok=True)

        if first_run:
            first_run = False
            part.write_bytes(b"partial")
            kwargs["progress_cb"]({
                "percent": kwargs["base_percent"],
                "file": kwargs["filename"],
                "fileIndex": kwargs["file_index"],
                "totalFiles": kwargs["total_files"],
                "status": "Downloading...",
                "bytesDownloaded": 7,
                "totalBytes": 10,
                "stalledSeconds": 0,
            })
            started.set()
            while not kwargs["control"]["pause"].wait(0.01):
                pass
            raise model_router.DownloadPaused()

        assert not kwargs["control"]["pause"].is_set()
        final = Path(kwargs["dest_dir"]) / kwargs["filename"]
        final.write_bytes(part.read_bytes() + b"-done")
        part.unlink(missing_ok=True)
        kwargs["progress_cb"]({
            "percent": kwargs["base_percent"],
            "file": kwargs["filename"],
            "fileIndex": kwargs["file_index"],
            "totalFiles": kwargs["total_files"],
            "status": "Resuming... 100%",
            "bytesDownloaded": 12,
            "totalBytes": 12,
            "stalledSeconds": 0,
        })
        return 12

    monkeypatch.setattr(model_router, "_download_file_streamed", fake_download_file_streamed)

    async def run_test() -> tuple[list[dict], bytes, list[dict]]:
        first_response = await model_router.hf_download(
            repo_id="owner/model",
            model_id=model_id,
        )
        first_task = asyncio.create_task(_collect_stream_events(first_response))
        await asyncio.to_thread(started.wait, 1.0)
        await model_router.pause_hf_download(model_id)
        first_events = await first_task
        paused_partial = (dest_dir / "weights.bin.part").read_bytes()

        second_response = await model_router.hf_download(
            repo_id="owner/model",
            model_id=model_id,
        )
        second_events = await _collect_stream_events(second_response)
        return first_events, paused_partial, second_events

    first_events, paused_partial, second_events = asyncio.run(run_test())

    assert any(event.get("paused") is True for event in first_events)
    assert paused_partial == b"partial"
    assert second_events[-1] == {"percent": 100, "status": "done"}
    assert any(event.get("status") == "Resuming... 100%" for event in second_events)
    assert (dest_dir / "weights.bin").read_bytes() == b"partial-done"
    assert model_id not in model_router._download_controls
