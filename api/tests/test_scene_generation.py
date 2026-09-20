import asyncio
import json
import tempfile
import unittest
import struct
import zlib
from pathlib import Path
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException

import routers.generation as generation
import services.generator_registry as registry
from schemas.generation import GenerateFromArtifactRequest, GenerateFromSceneRequest
from services.capture_input import TypedModelInput


class _SceneRegistry:
    def __init__(self):
        self.switched = False
        self.generator = object()

    def get_generator(self, model_id):
        return self.generator

    def get_manifest(self, model_id):
        return {"input": "capture" if model_id.endswith("capture") else "scene"}

    def switch_model(self, model_id):
        self.switched = True


class SceneGenerationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tmp.name) / "workspace"
        self.scene = self.workspace / "Scenes" / "room"
        self.scene.mkdir(parents=True)
        self.manifest = self.scene / "scene-manifest.json"
        self.manifest.write_text(json.dumps({
            "schema": "modly.scene-manifest.v1", "sceneRoot": ".", "assets": []
        }))
        self.registry = _SceneRegistry()
        self.registry_patch = patch.object(generation, "generator_registry", self.registry)
        self.workspace_patch = patch.object(registry, "WORKSPACE_DIR", self.workspace)
        self.registry_patch.start()
        self.workspace_patch.start()

    def tearDown(self):
        self.workspace_patch.stop()
        self.registry_patch.stop()
        for store in (
            generation._jobs, generation._cancel_events, generation._cancelled,
            generation._completed_at, generation._job_execution_tokens,
            generation._job_execution_targets, generation._job_reservations,
        ):
            store.clear()
        self.tmp.cleanup()

    def test_scene_request_queues_path_without_fake_image_and_overwrites_reserved_params(self):
        tasks = BackgroundTasks()
        result = asyncio.run(generation.generate_from_scene(GenerateFromSceneRequest(
            scene_path="Scenes/room", model_id="demo/scene",
            params={"scene_manifest_path": "/etc/passwd", "scene_path": "../../bad", "quality": "high"},
        ), tasks))
        self.assertTrue(self.registry.switched)
        self.assertEqual(result["job_id"], generation._jobs[result["job_id"]].job_id)
        self.assertEqual(len(tasks.tasks), 1)
        queued = tasks.tasks[0]
        self.assertEqual(queued.args[1], self.manifest.resolve())
        self.assertIsInstance(queued.args[1], Path)
        self.assertEqual(queued.args[2]["scene_manifest_path"], str(self.manifest.resolve()))
        self.assertNotIn("scene_path", queued.args[2])

    def test_rejects_traversal_before_switch(self):
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(generation.generate_from_scene(GenerateFromSceneRequest(
                scene_path="../outside", model_id="demo/scene"), BackgroundTasks()))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertFalse(self.registry.switched)

    def test_unavailable_model_switch_is_client_error_before_queue(self):
        with patch.object(self.registry, "switch_model", side_effect=ValueError("Model is quarantined")):
            tasks = BackgroundTasks()
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(generation.generate_from_scene(GenerateFromSceneRequest(
                    scene_path="Scenes/room", model_id="demo/scene"), tasks))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("quarantined", caught.exception.detail)
        self.assertFalse(generation._jobs)
        self.assertFalse(tasks.tasks)

    def test_generic_typed_route_queues_validated_capture_without_reserved_param_override(self):
        capture = self.workspace / "Captures" / "room"
        frames = capture / "frames"
        frames.mkdir(parents=True)
        image = frames / "0000.png"
        def chunk(name, payload):
            return struct.pack(">I", len(payload)) + name + payload + struct.pack(">I", zlib.crc32(name + payload) & 0xFFFFFFFF)
        raw = b"".join(b"\x00" + bytes((255, 0, 0)) * 8 for _ in range(6))
        image.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 6, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
        manifest = capture / "capture-manifest.json"
        manifest.write_text(json.dumps({
            "schema": "modly.capture-manifest.v1", "captureRoot": ".", "kind": "frames",
            "frames": [{"index": 0, "path": "frames/0000.png", "width": 8, "height": 6, "byteSize": image.stat().st_size}],
            "provenance": {"source": "test", "ordering": "manifest-index"},
        }))
        tasks = BackgroundTasks()
        result = asyncio.run(generation.generate_from_artifact(GenerateFromArtifactRequest(
            input_kind="capture", input_path="Captures/room", model_id="demo/capture",
            params={"capture_manifest_path": "/etc/passwd", "quality": "high"},
        ), tasks))
        queued = tasks.tasks[0]
        self.assertEqual(queued.args[1], TypedModelInput("capture", manifest.resolve()))
        self.assertEqual(queued.args[2]["capture_manifest_path"], str(manifest.resolve()))
        self.assertEqual(result["job_id"], queued.args[0])

    def test_generic_typed_route_rejects_kind_not_declared_by_node(self):
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(generation.generate_from_artifact(GenerateFromArtifactRequest(
                input_kind="capture", input_path="Scenes/room", model_id="demo/scene",
            ), BackgroundTasks()))
        self.assertEqual(caught.exception.status_code, 400)
