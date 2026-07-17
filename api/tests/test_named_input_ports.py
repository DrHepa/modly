import asyncio
import tempfile
import threading
import unittest
from collections import OrderedDict
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from routers import generation
from schemas.generation import JobStatus


class NamedInputPortValidationTests(unittest.TestCase):
    def test_normalizes_and_orders_by_manifest_declaration(self) -> None:
        manifest = {
            "io_contract": "named-v1",
            "input_ports": [
                {"name": "front", "type": "image", "required": True},
                {"name": "side", "type": "image", "required": True},
            ],
        }

        ports = generation._normalize_named_v1_input_ports(manifest)
        ordered = generation._order_named_images(
            ports,
            [("side", b"side-bytes"), ("front", b"front-bytes")],
        )

        self.assertEqual(list(ordered.keys()), ["front", "side"])
        self.assertEqual(list(ordered.values()), [b"front-bytes", b"side-bytes"])

    def test_rejects_duplicate_or_unknown_submission(self) -> None:
        ports = generation._normalize_named_v1_input_ports({
            "io_contract": "named-v1",
            "input_ports": [{"name": "front", "type": "image", "required": True}],
        })

        with self.assertRaises(HTTPException):
            generation._order_named_images(ports, [("front", b"1"), ("front", b"2")])

        with self.assertRaises(HTTPException):
            generation._order_named_images(ports, [("back", b"1")])

    def test_rejects_invalid_descriptor_shape(self) -> None:
        invalid_manifests = [
            {"io_contract": "named-v1", "input_ports": [{"name": "Front", "type": "image"}]},
            {"io_contract": "named-v1", "input_ports": [{"name": "front", "type": "mesh", "required": True}]},
            {"io_contract": "named-v1", "input_ports": [{"name": "front", "type": "image", "max": 2}]},
            {"io_contract": "named-v1", "input_ports": [{"name": "front", "type": "image"}]},
            {"io_contract": "named-v1", "input_ports": [{"name": "front", "type": "image", "required": "yes"}]},
            {"io_contract": "legacy", "input_ports": [{"name": "front", "type": "image"}]},
        ]

        for manifest in invalid_manifests:
            with self.subTest(manifest=manifest):
                with self.assertRaises(HTTPException):
                    generation._normalize_named_v1_input_ports(manifest)

    def test_rejects_missing_required_port(self) -> None:
        ports = generation._normalize_named_v1_input_ports({
            "io_contract": "named-v1",
            "input_ports": [
                {"name": "front", "type": "image", "required": True},
                {"name": "side", "type": "image", "required": True},
            ],
        })

        with self.assertRaises(HTTPException):
            generation._order_named_images(ports, [("front", b"1")])

    def test_rejects_single_non_primary_optional_submission(self) -> None:
        ports = generation._normalize_named_v1_input_ports({
            "io_contract": "named-v1",
            "input_ports": [
                {"name": "front", "type": "image", "required": False},
                {"name": "side", "type": "image", "required": False},
            ],
        })

        with self.assertRaises(HTTPException):
            generation._order_named_images(ports, [("side", b"1")])


class _FakeRegistry:
    def __init__(self, gen, manifest: dict | None = None) -> None:
        self.gen = gen
        self.manifest = manifest or {}

    def active_status(self) -> dict:
        return {"id": "demo/node", "name": "Demo", "downloaded": True, "loaded": True}

    def get_active(self):
        return self.gen

    def get_generator(self, model_id: str):
        return self.gen

    def get_manifest(self, model_id: str) -> dict:
        return self.manifest

    def switch_model(self, model_id: str) -> None:
        self.switched_model_id = model_id


class GenerationDispatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self._registry = generation.generator_registry
        self._workspace = generation.WORKSPACE_DIR
        self._run_generation = generation._run_generation
        self.tmp = tempfile.TemporaryDirectory()
        generation.WORKSPACE_DIR = Path(self.tmp.name)
        generation._jobs.clear()
        generation._cancel_events.clear()
        generation._cancelled.clear()
        generation._completed_at.clear()

    def tearDown(self) -> None:
        generation.generator_registry = self._registry
        generation.WORKSPACE_DIR = self._workspace
        generation._run_generation = self._run_generation
        self.tmp.cleanup()

    def test_single_named_image_uses_legacy_generate(self) -> None:
        class Gen:
            outputs_dir = None

            def is_loaded(self):
                return True

            def generate(self, image_bytes, params, progress_cb, cancel_event=None):
                self.seen = (image_bytes, params, cancel_event is not None)
                out = Path(self.outputs_dir) / "one.glb"
                out.write_bytes(b"glb")
                return out

        gen = Gen()
        generation.generator_registry = _FakeRegistry(gen)
        job_id = "job-single"
        generation._jobs[job_id] = JobStatus(job_id=job_id, status="pending", progress=0)
        generation._cancel_events[job_id] = threading.Event()

        asyncio.run(generation._run_generation(
            job_id,
            OrderedDict([("front", b"front")]),
            {"quality": "draft"},
            "Default",
        ))

        self.assertEqual(generation._jobs[job_id].status, "done")
        self.assertEqual(gen.seen[0], b"front")
        self.assertEqual(gen.seen[1], {"quality": "draft"})

    def test_multiple_named_images_require_generate_v2(self) -> None:
        class Gen:
            outputs_dir = None

            def is_loaded(self):
                return True

            def generate(self, image_bytes, params, progress_cb, cancel_event=None):
                raise AssertionError("legacy generate must not run")

        generation.generator_registry = _FakeRegistry(Gen())
        job_id = "job-missing-v2"
        generation._jobs[job_id] = JobStatus(job_id=job_id, status="pending", progress=0)
        generation._cancel_events[job_id] = threading.Event()

        asyncio.run(generation._run_generation(
            job_id,
            OrderedDict([("front", b"front"), ("side", b"side")]),
            {},
            "Default",
        ))

        self.assertEqual(generation._jobs[job_id].status, "error")
        self.assertIn("generate_v2", generation._jobs[job_id].error)

    def test_from_images_multipart_repeated_fields_schedule_canonical_order(self) -> None:
        manifest = {
            "io_contract": "named-v1",
            "input_ports": [
                {"name": "front", "type": "image", "required": True},
                {"name": "side", "type": "image", "required": True},
            ],
        }
        generation.generator_registry = _FakeRegistry(object(), manifest)
        scheduled = []

        async def fake_run_generation(job_id, image_bytes, params, collection):
            scheduled.append((job_id, list(image_bytes.items()), params, collection))

        generation._run_generation = fake_run_generation

        app = FastAPI()
        app.include_router(generation.router, prefix="/generate")
        client = TestClient(app)

        response = client.post(
            "/generate/from-images",
            data={
                "model_id": "demo/node",
                "collection": "Review",
                "params": "{\"quality\":\"draft\"}",
            },
            files=[
                ("images", ("side.png", b"side-bytes", "image/png")),
                ("images", ("front.png", b"front-bytes", "image/png")),
                ("image_names", (None, "side")),
                ("image_names", (None, "front")),
            ],
        )

        self.assertEqual(response.status_code, 200)
        job_id = response.json()["job_id"]
        self.assertEqual(generation._jobs[job_id].input_ports, ["front", "side"])
        self.assertEqual(len(scheduled), 1)
        self.assertEqual(scheduled[0][0], job_id)
        self.assertEqual(scheduled[0][1], [("front", b"front-bytes"), ("side", b"side-bytes")])
        self.assertEqual(scheduled[0][2]["quality"], "draft")
        self.assertEqual(scheduled[0][3], "Review")

    def test_from_image_rejects_malformed_named_v1_manifest(self) -> None:
        manifest = {
            "io_contract": "named-v1",
            "input_ports": [{"name": "front", "type": "image"}],
        }
        generation.generator_registry = _FakeRegistry(object(), manifest)
        scheduled = []

        async def fake_run_generation(*args):
            scheduled.append(args)

        generation._run_generation = fake_run_generation

        app = FastAPI()
        app.include_router(generation.router, prefix="/generate")
        client = TestClient(app)

        response = client.post(
            "/generate/from-image",
            data={"model_id": "demo/node"},
            files={"image": ("front.png", b"front-bytes", "image/png")},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("required must be present and boolean", response.text)
        self.assertEqual(scheduled, [])

    def test_from_image_rejects_named_v1_missing_required_non_primary(self) -> None:
        manifest = {
            "io_contract": "named-v1",
            "input_ports": [
                {"name": "front", "type": "image", "required": True},
                {"name": "side", "type": "image", "required": True},
            ],
        }
        generation.generator_registry = _FakeRegistry(object(), manifest)
        scheduled = []

        async def fake_run_generation(*args):
            scheduled.append(args)

        generation._run_generation = fake_run_generation

        app = FastAPI()
        app.include_router(generation.router, prefix="/generate")
        client = TestClient(app)

        response = client.post(
            "/generate/from-image",
            data={"model_id": "demo/node"},
            files={"image": ("front.png", b"front-bytes", "image/png")},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("side", response.text)
        self.assertEqual(scheduled, [])

    def test_from_image_named_v1_primary_stays_on_legacy_payload(self) -> None:
        manifest = {
            "io_contract": "named-v1",
            "input_ports": [
                {"name": "reference", "type": "image", "required": False},
                {"name": "subject", "type": "image", "required": True},
            ],
        }
        generation.generator_registry = _FakeRegistry(object(), manifest)
        scheduled = []

        async def fake_run_generation(job_id, image_bytes, params, collection):
            scheduled.append((job_id, image_bytes, params, collection))

        generation._run_generation = fake_run_generation

        app = FastAPI()
        app.include_router(generation.router, prefix="/generate")
        client = TestClient(app)

        response = client.post(
            "/generate/from-image",
            data={
                "model_id": "demo/node",
                "collection": "Review",
                "params": "{\"quality\":\"draft\"}",
            },
            files={"image": ("subject.png", b"subject-bytes", "image/png")},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(scheduled), 1)
        self.assertEqual(scheduled[0][1], b"subject-bytes")
        self.assertEqual(scheduled[0][2]["quality"], "draft")
        self.assertEqual(scheduled[0][3], "Review")
