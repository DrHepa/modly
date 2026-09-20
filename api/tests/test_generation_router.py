import asyncio
import json
import sys
import tempfile
import threading
import time
import unittest
import warnings
from pathlib import Path

from fastapi import BackgroundTasks
from pydantic import ValidationError

import services.generator_registry as registry
import services.extension_process as extension_process
import routers.generation as generation
from schemas.generation import JobStatus


class JobStatusProgressTests(unittest.TestCase):
    def test_fractional_progress_serializes_without_warnings_and_is_bounded(self) -> None:
        job = JobStatus(job_id="fractional", status="running", progress=0)
        # Runtime callbacks update the already-created pending JobStatus instance.
        job.progress = 0.3
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            payload = job.model_dump(mode="json")

        self.assertEqual(payload["progress"], 0.3)
        integer = JobStatus(job_id="integer", status="running", progress=25).progress
        self.assertEqual(integer, 25.0)
        self.assertIsInstance(integer, float)
        self.assertEqual(caught, [])
        for invalid in (-0.1, 100.1):
            with self.subTest(progress=invalid), self.assertRaises(ValidationError):
                JobStatus(job_id="invalid", status="running", progress=invalid)
        with self.assertRaises(ValidationError):
            job.progress = 100.1


class CancelJobProcessTreeTests(unittest.TestCase):
    def _clear_state(self) -> None:
        for store in (
            generation._jobs, generation._cancel_events, generation._completed_at,
            generation._job_execution_tokens, generation._job_reservations,
            generation._job_execution_targets,
        ):
            store.clear()
        generation._cancelled.clear()

    def test_cancel_uses_generator_tree_stop(self) -> None:
        job_id = "tree-job"
        generation._jobs[job_id] = JobStatus(job_id=job_id, status="running")
        generation._cancel_events[job_id] = threading.Event()
        stopped = []
        generator = type("Generator", (), {
            "_proc": type("Proc", (), {"poll": lambda self: None})(),
            "_loaded": True,
            "stop": lambda self: stopped.append(True),
        })()
        fake_registry = type("Registry", (), {
            "_active_id": "active",
            "_generators": {"active": generator},
        })()
        previous = generation.generator_registry
        generation.generator_registry = fake_registry
        generation._register_job_execution(job_id)
        async def scenario():
            reservation = await generation._reserve_execution(job_id)
            try:
                self.assertIs(generation._owned_generator(job_id), generator)
                return await generation.cancel_job(job_id)
            finally:
                generation._release_execution(reservation)
        try:
            self.assertEqual(asyncio.run(scenario()), {"cancelled": True})
        finally:
            generation.generator_registry = previous
            self._clear_state()
        self.assertEqual(stopped, [True])

    def test_two_runs_share_process_exclusively_and_old_cancel_does_not_kill_new(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python = extension_process._venv_python(root)
            python.parent.mkdir(parents=True)
            python.symlink_to(sys.executable)
            manifest = {
                "id": "execution-race", "name": "Execution race", "generator_class": "Fixture",
                "nodes": [{"id": "generate"}],
            }
            (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            (root / "generator.py").write_text(
                "import time\nfrom pathlib import Path\n"
                "class Fixture:\n"
                " def __init__(self,*args): self.loaded=False\n"
                " @classmethod\n def params_schema(cls): return []\n"
                " def is_loaded(self): return self.loaded\n"
                " def load(self): self.loaded=True\n"
                " def generate(self,image,params,progress_cb,cancel_event):\n"
                "  progress_cb(1,'started')\n"
                "  time.sleep(params.get('sleep',0.1))\n"
                "  out=Path(self.outputs_dir)/(params.get('name','model')+'.glb')\n"
                "  out.write_bytes(b'glb')\n"
                "  return out\n"
                " def unload(self): self.loaded=False\n",
                encoding="utf-8",
            )
            process = extension_process.ExtensionProcess(root, manifest)
            fake_registry = type("Registry", (), {})()
            fake_registry._active_id = "execution-race/generate"
            fake_registry._generators = {fake_registry._active_id: process}
            fake_registry.active_status = lambda: {
                "loaded": process.is_loaded(), "downloaded": True, "name": "Fixture",
            }
            fake_registry.get_active = lambda: (process.load() or process) if not process.is_loaded() else process
            previous = generation.generator_registry
            previous_workspace = registry.WORKSPACE_DIR
            generation.generator_registry = fake_registry
            registry.WORKSPACE_DIR = root
            for job_id in ("old", "new"):
                generation._jobs[job_id] = JobStatus(job_id=job_id, status="pending")
                generation._cancel_events[job_id] = threading.Event()
                generation._register_job_execution(job_id)

            async def scenario():
                old = asyncio.create_task(generation._run_generation("old", b"img", {"sleep": 5, "name": "old"}, "Workflows"))
                deadline = asyncio.get_running_loop().time() + 3
                while generation._jobs["old"].progress < 1:
                    if asyncio.get_running_loop().time() > deadline:
                        raise TimeoutError("old run did not start")
                    await asyncio.sleep(0.01)
                new = asyncio.create_task(generation._run_generation("new", b"img", {"sleep": 0.1, "name": "new"}, "Workflows"))
                await asyncio.sleep(0.05)
                self.assertIsNone(generation._owned_generator("new"))
                await generation.cancel_job("old")
                await asyncio.wait_for(asyncio.gather(old, new), 4)

            try:
                asyncio.run(scenario())
                self.assertEqual(generation._jobs["old"].status, "cancelled")
                self.assertEqual(generation._jobs["new"].status, "done")
                self.assertFalse(generation._cancel_events["new"].is_set())
                self.assertTrue((root / "Workflows" / "new.glb").is_file())
            finally:
                process.stop()
                generation.generator_registry = previous
                registry.WORKSPACE_DIR = previous_workspace
                self._clear_state()

    def test_cancel_during_loading_stops_reserved_process_and_completes_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python = extension_process._venv_python(root)
            python.parent.mkdir(parents=True)
            python.symlink_to(sys.executable)
            manifest = {
                "id": "loading-cancel", "name": "Loading cancel", "generator_class": "Fixture",
                "nodes": [{"id": "generate"}],
            }
            (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            (root / "generator.py").write_text(
                "import os,time\nfrom pathlib import Path\n"
                "class Fixture:\n"
                " def __init__(self,*args): self.loaded=False\n"
                " @classmethod\n def params_schema(cls): return []\n"
                " def is_loaded(self): return self.loaded\n"
                " def load(self):\n"
                "  Path(os.environ['EXTENSION_DIR'],'load-started').write_text('started')\n"
                "  time.sleep(5)\n"
                "  self.loaded=True\n"
                " def generate(self,*args): return Path('/tmp/not-used')\n"
                " def unload(self): self.loaded=False\n",
                encoding="utf-8",
            )
            process = extension_process.ExtensionProcess(root, manifest)
            fake_registry = type("Registry", (), {})()
            fake_registry._active_id = "loading-cancel/generate"
            fake_registry._generators = {fake_registry._active_id: process}
            fake_registry.active_status = lambda: {
                "loaded": process.is_loaded(), "downloaded": True, "name": "Fixture",
            }
            fake_registry.get_active = lambda: (process.load() or process)
            previous = generation.generator_registry
            previous_workspace = registry.WORKSPACE_DIR
            generation.generator_registry = fake_registry
            registry.WORKSPACE_DIR = root
            job_id = "loading"
            generation._jobs[job_id] = JobStatus(job_id=job_id, status="pending")
            generation._cancel_events[job_id] = threading.Event()
            generation._register_job_execution(job_id)

            async def scenario():
                started = time.monotonic()
                task = asyncio.create_task(generation._run_generation(job_id, b"img", {}, "Workflows"))
                deadline = asyncio.get_running_loop().time() + 3
                while not (root / "load-started").is_file():
                    if asyncio.get_running_loop().time() > deadline:
                        raise TimeoutError("generator load did not start")
                    await asyncio.sleep(0.01)
                raw = process._proc
                await generation.cancel_job(job_id)
                await asyncio.wait_for(task, 2)
                self.assertIsNotNone(raw.poll())
                self.assertLess(time.monotonic() - started, 2)

            try:
                asyncio.run(scenario())
                self.assertEqual(generation._jobs[job_id].status, "cancelled")
            finally:
                process.stop()
                generation.generator_registry = previous
                registry.WORKSPACE_DIR = previous_workspace
                self._clear_state()

    def test_cancel_before_process_spawn_remains_pending_until_runner_is_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python = extension_process._venv_python(root)
            python.parent.mkdir(parents=True)
            python.symlink_to(sys.executable)
            manifest = {
                "id": "pre-spawn-cancel", "name": "Pre-spawn cancel", "generator_class": "Fixture",
                "nodes": [{"id": "generate"}],
            }
            (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            (root / "generator.py").write_text(
                "from pathlib import Path\n"
                "class Fixture:\n"
                " def __init__(self,*args): self.loaded=False\n"
                " @classmethod\n def params_schema(cls): return []\n"
                " def is_loaded(self): return self.loaded\n"
                " def load(self): self.loaded=True\n"
                " def generate(self,*args): return Path('/tmp/not-used')\n"
                " def unload(self): self.loaded=False\n",
                encoding="utf-8",
            )
            process = extension_process.ExtensionProcess(root, manifest)
            ready = threading.Event()
            allow = threading.Event()
            original_load = process.load

            def gated_load() -> None:
                ready.set()
                allow.wait(2)
                original_load()

            process.load = gated_load
            fake_registry = type("Registry", (), {
                "_active_id": "pre-spawn-cancel/generate",
                "_generators": {"pre-spawn-cancel/generate": process},
            })()
            previous = generation.generator_registry
            previous_workspace = registry.WORKSPACE_DIR
            generation.generator_registry = fake_registry
            registry.WORKSPACE_DIR = root
            job_id = "pre-spawn"
            generation._jobs[job_id] = JobStatus(job_id=job_id, status="pending")
            generation._cancel_events[job_id] = threading.Event()
            generation._register_job_execution(job_id)

            async def scenario() -> None:
                task = asyncio.create_task(generation._run_generation(job_id, b"img", {}, "Workflows"))
                deadline = asyncio.get_running_loop().time() + 2
                while not ready.is_set():
                    if asyncio.get_running_loop().time() > deadline:
                        raise TimeoutError("load gate was not reached")
                    await asyncio.sleep(0.01)
                self.assertIsNone(process._proc)
                await generation.cancel_job(job_id)
                self.assertFalse(generation._job_reservations[job_id].stop_requested)
                self.assertNotIn(job_id, generation._completed_at)
                allow.set()
                await asyncio.wait_for(task, 3)
                self.assertFalse(process._proc and process._proc.poll() is None)

            try:
                asyncio.run(scenario())
                self.assertEqual(generation._jobs[job_id].status, "cancelled")
                self.assertIn(job_id, generation._completed_at)
            finally:
                allow.set()
                process.stop()
                generation.generator_registry = previous
                registry.WORKSPACE_DIR = previous_workspace
                self._clear_state()

    def test_cancelled_async_task_keeps_reservation_until_blocking_worker_exits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python = extension_process._venv_python(root)
            python.parent.mkdir(parents=True)
            python.symlink_to(sys.executable)
            manifest = {
                "id": "retiring-task", "name": "Retiring task", "generator_class": "Fixture",
                "nodes": [{"id": "generate"}],
            }
            (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            (root / "generator.py").write_text(
                "import time\nfrom pathlib import Path\n"
                "class Fixture:\n"
                " def __init__(self,*args): self.loaded=False\n"
                " @classmethod\n def params_schema(cls): return []\n"
                " def is_loaded(self): return self.loaded\n"
                " def load(self): self.loaded=True\n"
                " def generate(self,image,params,progress_cb,cancel_event):\n"
                "  progress_cb(1,'started')\n"
                "  time.sleep(params.get('sleep',0.1))\n"
                "  out=Path(self.outputs_dir)/(params.get('name','model')+'.glb')\n"
                "  out.write_bytes(b'glb')\n"
                "  return out\n"
                " def unload(self): self.loaded=False\n",
                encoding="utf-8",
            )
            process = extension_process.ExtensionProcess(root, manifest)
            fake_registry = type("Registry", (), {
                "_active_id": "retiring-task/generate",
                "_generators": {"retiring-task/generate": process},
            })()
            previous = generation.generator_registry
            previous_workspace = registry.WORKSPACE_DIR
            generation.generator_registry = fake_registry
            registry.WORKSPACE_DIR = root
            for job_id in ("old", "new"):
                generation._jobs[job_id] = JobStatus(job_id=job_id, status="pending")
                generation._cancel_events[job_id] = threading.Event()
                generation._register_job_execution(job_id)

            async def scenario() -> None:
                old = asyncio.create_task(generation._run_generation(
                    "old", b"img", {"sleep": 1, "name": "old"}, "Workflows"
                ))
                deadline = asyncio.get_running_loop().time() + 2
                while generation._jobs["old"].progress < 1:
                    if asyncio.get_running_loop().time() > deadline:
                        raise TimeoutError("old run did not start")
                    await asyncio.sleep(0.01)
                old_process = process._proc
                old.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(old, 3)
                self.assertEqual(generation._jobs["old"].status, "cancelled")
                self.assertIsNotNone(old_process.poll())
                self.assertIsNone(generation._owned_generator("old"))

                new = asyncio.create_task(generation._run_generation(
                    "new", b"img", {"sleep": 0.1, "name": "new"}, "Workflows"
                ))
                await generation.cancel_job("old")
                await asyncio.wait_for(new, 3)

            try:
                asyncio.run(scenario())
                self.assertEqual(generation._jobs["new"].status, "done")
                self.assertEqual(generation._jobs["new"].output_url, "/workspace/Workflows/new.glb")
                self.assertTrue((root / "Workflows" / "new.glb").is_file())
                self.assertFalse((root / "Workflows" / "old.glb").exists())
                self.assertFalse(generation._cancel_events["new"].is_set())
            finally:
                process.stop()
                generation.generator_registry = previous
                registry.WORKSPACE_DIR = previous_workspace
                self._clear_state()


class FrozenGeneratorTargetTests(unittest.TestCase):
    def tearDown(self) -> None:
        generation.generation_lifecycle.clear()
        for store in (generation._jobs, generation._cancel_events, generation._completed_at):
            store.clear()
        generation._cancelled.clear()

    def test_queued_a_never_reselects_b_after_registry_switch(self) -> None:
        class Gen:
            DISPLAY_NAME = "fixture"

            def __init__(self, name: str) -> None:
                self.name = name
                self.calls: list[str] = []
                self.entered = threading.Event()
                self.allow = threading.Event()
                self.outputs_dir: Path | None = None

            def is_loaded(self) -> bool: return True
            def is_downloaded(self) -> bool: return True
            def unload(self) -> None: pass

            def generate(self, image, params, progress_cb=None, cancel_event=None):
                self.calls.append(params["name"])
                self.entered.set()
                if params["name"] == "first-a":
                    self.allow.wait(3)
                output = Path(self.outputs_dir) / f"{params['name']}-{self.name}.glb"
                output.write_bytes(b"fixture")
                return output

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            a, b = Gen("a"), Gen("b")
            real_registry = object.__new__(registry.GeneratorRegistry)
            real_registry._active_id = "a"
            real_registry._generators = {"a": a, "b": b}
            real_registry._manifests = {"a": {}, "b": {}}
            previous = generation.generator_registry
            previous_workspace = registry.WORKSPACE_DIR
            generation.generator_registry = real_registry
            registry.WORKSPACE_DIR = root
            for job_id in ("first-a", "queued-a"):
                generation._jobs[job_id] = JobStatus(job_id=job_id, status="pending")
                generation._cancel_events[job_id] = threading.Event()
                generation._register_job_execution(job_id, "a", a)

            async def scenario() -> None:
                first = asyncio.create_task(generation._run_generation("first-a", b"a", {"name": "first-a"}))
                while not a.entered.is_set():
                    await asyncio.sleep(0.01)
                queued = asyncio.create_task(generation._run_generation("queued-a", b"a", {"name": "queued-a"}))
                await asyncio.sleep(0.02)
                with self.assertRaisesRegex(RuntimeError, "while 'a' is executing"):
                    real_registry.switch_model("b")
                a.allow.set()
                await asyncio.wait_for(asyncio.gather(first, queued), 3)

            try:
                asyncio.run(scenario())
                self.assertEqual(a.calls, ["first-a", "queued-a"])
                self.assertEqual(b.calls, [])
                self.assertEqual(generation._jobs["queued-a"].status, "done")
            finally:
                a.allow.set()
                generation.generator_registry = previous
                registry.WORKSPACE_DIR = previous_workspace


class _FakeGenerator:
    """Writes its output into whatever directory generation assigns it."""

    def __init__(self) -> None:
        self.outputs_dir: Path | None = None

    def generate(self, image_bytes, params, progress_cb, cancel_event=None) -> Path:
        out = Path(self.outputs_dir) / "model.glb"
        out.write_bytes(b"glb")
        return out


class _FakeUpload:
    """Minimal UploadFile stand-in: an image content-type and readable bytes."""

    def __init__(self, content_type: str = "image/png", data: bytes = b"\x89PNG\r\n") -> None:
        self.content_type = content_type
        self._data = data

    async def read(self) -> bytes:
        return self._data


class _FakeRegistry:
    def __init__(self, gen: _FakeGenerator) -> None:
        self._gen = gen

    def active_status(self) -> dict:
        # Report loaded so _run_generation skips the download/load thread.
        return {"loaded": True, "name": "fake", "downloaded": True}

    def get_active(self) -> _FakeGenerator:
        return self._gen

    # generate_from_image looks the model up and switches to it before filing the job.
    def get_generator(self, model_id: str) -> _FakeGenerator:
        return self._gen

    def switch_model(self, model_id: str) -> None:
        pass


class RunGenerationWorkspaceTests(unittest.TestCase):
    """A generation started after the workspace path is relocated at runtime
    (POST /settings/paths) must file its output under the *current* workspace,
    not the one captured when the module was imported."""

    def setUp(self) -> None:
        self._prev_registry = generation.generator_registry
        self._prev_ws = registry.WORKSPACE_DIR
        self._tmp = tempfile.TemporaryDirectory()
        # The user relocated the workspace: the registry global now points here.
        registry.WORKSPACE_DIR = Path(self._tmp.name) / "new_workspace"
        # Keep the test hermetic against the module's import-time binding: if the
        # stale name still exists (before the fix) redirect it into the temp tree
        # so the assertion — not a stray write to the real workspace — is what
        # catches the bug.
        self._had_stale = hasattr(generation, "WORKSPACE_DIR")
        if self._had_stale:
            generation.WORKSPACE_DIR = Path(self._tmp.name) / "old_workspace"

    def tearDown(self) -> None:
        generation.generator_registry = self._prev_registry
        registry.WORKSPACE_DIR = self._prev_ws
        if self._had_stale:
            generation.WORKSPACE_DIR = self._prev_ws
        for store in (
            generation._jobs,
            generation._cancel_events,
            generation._cancelled,
            generation._completed_at,
            generation._job_execution_tokens,
            generation._job_reservations,
            generation._job_execution_targets,
        ):
            store.clear()
        self._tmp.cleanup()

    def _run(self, collection: str) -> tuple[_FakeGenerator, JobStatus]:
        gen = _FakeGenerator()
        generation.generator_registry = _FakeRegistry(gen)
        job_id = "job-test"
        generation._jobs[job_id] = JobStatus(job_id=job_id, status="pending", progress=0)
        generation._cancel_events[job_id] = threading.Event()
        asyncio.run(generation._run_generation(job_id, b"img", {}, collection))
        return gen, generation._jobs[job_id]

    def test_output_lands_under_the_current_workspace(self) -> None:
        gen, job = self._run("MyColl")
        self.assertEqual(Path(gen.outputs_dir), registry.WORKSPACE_DIR / "MyColl")
        self.assertEqual(job.status, "done")
        self.assertEqual(job.output_url, "/workspace/MyColl/model.glb")


class GenerateFromImageWorkspaceTests(unittest.TestCase):
    """The request path must survive the relocation too, not just the worker:
    sanitize_collection() checks the name's containment against the workspace
    root before the job is filed, so it has to read the same live binding -- a
    stale (or missing) module-level name there fails every POST
    /generate/from-image, whatever _run_generation does afterwards."""

    def setUp(self) -> None:
        self._prev_registry = generation.generator_registry
        self._prev_ws = registry.WORKSPACE_DIR
        self._tmp = tempfile.TemporaryDirectory()
        registry.WORKSPACE_DIR = Path(self._tmp.name) / "new_workspace"
        generation.generator_registry = _FakeRegistry(_FakeGenerator())

    def tearDown(self) -> None:
        generation.generator_registry = self._prev_registry
        registry.WORKSPACE_DIR = self._prev_ws
        for store in (
            generation._jobs,
            generation._cancel_events,
            generation._cancelled,
            generation._completed_at,
            generation._job_execution_tokens,
            generation._job_reservations,
            generation._job_execution_targets,
        ):
            store.clear()
        self._tmp.cleanup()

    def test_request_is_filed_after_the_workspace_moves(self) -> None:
        background = BackgroundTasks()
        response = asyncio.run(
            generation.generate_from_image(
                background,
                image=_FakeUpload(),
                model_id="sf3d",
                collection="MyColl",
                remesh="quad",
                enable_texture=False,
                texture_resolution=1024,
                params="{}",
            )
        )
        self.assertIn(response["job_id"], generation._jobs)
        # add_task(_run_generation, job_id, image_bytes, full_params, collection)
        self.assertEqual(background.tasks[0].args[3], "MyColl")


if __name__ == "__main__":
    unittest.main()
