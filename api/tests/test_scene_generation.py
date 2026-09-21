import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

import routers.generation as generation
import services.generator_registry as registry
from schemas.generation import GenerateFromArtifactRequest


class _Registry:
    def __init__(self):
        self.switched = False
    def get_generator(self, model_id): return object()
    def get_manifest(self, model_id): return {"input": "scene"}
    def switch_model(self, model_id): self.switched = True


class SceneGenerationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tmp.name) / "workspace"
        self.scene = self.workspace / "Workflows" / "room"
        self.scene.mkdir(parents=True)
        self.manifest = self.scene / "scene-manifest.json"
        self.manifest.write_text(json.dumps({"schema": "modly.scene-manifest.v1", "sceneRoot": ".", "assets": []}))
        self.registry = _Registry()
        self.patches = [patch.object(generation, "generator_registry", self.registry), patch.object(registry, "WORKSPACE_DIR", self.workspace)]
        for item in self.patches: item.start()

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        generation._jobs.clear(); generation._cancel_events.clear(); generation._cancelled.clear(); generation._completed_at.clear()
        self.tmp.cleanup()

    def test_generic_route_queues_typed_scene_and_strips_reserved_params(self):
        tasks = BackgroundTasks()
        result = asyncio.run(generation.generate_from_artifact(GenerateFromArtifactRequest(
            input_kind="scene", input_path="Workflows/room", model_id="demo/scene",
            params={"artifact_path": "/etc/passwd", "input_kind": "image", "quality": "high"},
        ), tasks))
        queued = tasks.tasks[0]
        self.assertEqual(queued.args[1].kind, "scene")
        self.assertEqual(queued.args[1].path, self.manifest.resolve())
        self.assertEqual(queued.args[2]["scene_manifest_path"], str(self.manifest.resolve()))
        self.assertNotIn("artifact_path", queued.args[2])
        self.assertNotIn("input_kind", queued.args[2])
        self.assertEqual(queued.args[5], "demo/scene")
        self.assertEqual(result["job_id"], queued.args[0])

    def test_generic_route_rejects_unsupported_kind_and_model_mismatch(self):
        for kind in ("video", "capture", "image"):
            with self.subTest(kind=kind), self.assertRaises(ValidationError):
                GenerateFromArtifactRequest(
                    input_kind=kind, input_path="Workflows/room", model_id="demo/scene")
        self.registry.get_manifest = lambda _model_id: {"input": "image"}
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(generation.generate_from_artifact(GenerateFromArtifactRequest(
                input_kind="scene", input_path="Workflows/room", model_id="demo/image"), BackgroundTasks()))
        self.assertEqual(caught.exception.status_code, 400)

    def test_rejects_traversal_before_switch_or_queue(self):
        with self.assertRaises(HTTPException):
            asyncio.run(generation.generate_from_artifact(GenerateFromArtifactRequest(
                input_kind="scene", input_path="../outside", model_id="demo/scene"), BackgroundTasks()))
        self.assertFalse(self.registry.switched)

    def test_queued_scene_job_is_pinned_to_requested_model(self):
        calls = []

        class Generator:
            outputs_dir = None
            def is_loaded(self): return True
            def generate_artifact(self, kind, path, params, progress_cb, cancel_event=None):
                calls.append(("model-a", kind, path))
                output = Path(self.outputs_dir) / "result.glb"
                output.write_bytes(b"glb")
                return output

        generator = Generator()
        registry_stub = type("Registry", (), {
            "get_ready_generator": lambda self, model_id: generator if model_id == "demo/a" else (_ for _ in ()).throw(ValueError(f"Unknown model ID: {model_id}")),
            "get_active": lambda self: (_ for _ in ()).throw(AssertionError("mutable active model must not be used")),
        })()
        job_id = "pinned-scene"
        generation._jobs[job_id] = generation.JobStatus(job_id=job_id, status="pending", progress=0)
        generation._cancel_events[job_id] = __import__("threading").Event()
        with patch.object(generation, "generator_registry", registry_stub):
            asyncio.run(generation._run_generation(
                job_id, generation.TypedArtifactInput("scene", self.manifest.resolve()), {},
                "Workflows", "mesh", "demo/a",
            ))
        self.assertEqual(calls[0][0], "model-a")
        self.assertEqual(generation._jobs[job_id].status, "done")

    def test_missing_pinned_model_fails_actionably(self):
        registry_stub = type("Registry", (), {
            "get_ready_generator": lambda self, model_id: (_ for _ in ()).throw(ValueError(f"Unknown model ID: {model_id}")),
            "get_active": lambda self: (_ for _ in ()).throw(AssertionError("must not use active model")),
        })()
        job_id = "missing-scene"
        generation._jobs[job_id] = generation.JobStatus(job_id=job_id, status="pending", progress=0)
        generation._cancel_events[job_id] = __import__("threading").Event()
        with patch.object(generation, "generator_registry", registry_stub):
            asyncio.run(generation._run_generation(
                job_id, generation.TypedArtifactInput("scene", self.manifest.resolve()), {},
                "Workflows", "mesh", "demo/missing",
            ))
        self.assertEqual(generation._jobs[job_id].status, "error")
        self.assertIn("Unknown model ID: demo/missing", generation._jobs[job_id].error)
