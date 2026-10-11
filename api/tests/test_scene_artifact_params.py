import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_tmp_ext_dir = tempfile.mkdtemp(prefix="modly-scene-runner-test-")
Path(_tmp_ext_dir, "manifest.json").write_text("{}", encoding="utf-8")
os.environ.setdefault("EXTENSION_DIR", _tmp_ext_dir)

import runner


class SceneArtifactParamTests(unittest.TestCase):
    def test_api_from_artifact_scene_injects_all_canonical_scene_params(self) -> None:
        from fastapi import BackgroundTasks
        from routers import generation
        from schemas.generation import GenerateFromArtifactRequest
        import services.generator_registry as registry_module
        from services.generator_registry import generator_registry

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "workspace"
            scene_dir = workspace / "Worlds" / "hero"
            scene_dir.mkdir(parents=True)
            manifest = scene_dir / "scene-manifest.json"
            manifest.write_text(json.dumps({
                "schema": "modly.scene-manifest.v1",
                "sceneRoot": ".",
                "assets": [],
            }), encoding="utf-8")
            captured = {}

            def fake_create_job(background_tasks, model_input, params, collection="Default", output_kind="mesh", model_id=None):
                captured.update({
                    "input_kind": model_input.kind,
                    "artifact_path": model_input.path,
                    "params": dict(params),
                    "collection": collection,
                    "artifact_snapshot": model_input.snapshot,
                    "model_id": model_id,
                })
                return type("Job", (), {"job_id": "scene-job"})()

            with mock.patch.object(registry_module, "WORKSPACE_DIR", workspace), \
                 mock.patch.object(generator_registry, "_generators", {"demo/scene": type("FakeGen", (), {"model_dir": Path("/")})()}, create=True), \
                 mock.patch.object(generator_registry, "_manifests", {"demo/scene": {
                     "id": "demo/scene",
                     "input": "scene",
                     "params_schema": [{"id": "quality", "type": "string"}],
                 }}, create=True), \
                 mock.patch.object(generator_registry, "switch_model", lambda model_id: None), \
                 mock.patch.object(generation, "create_generation_job", fake_create_job):
                result = asyncio.run(generation.generate_from_artifact(GenerateFromArtifactRequest(
                    input_kind="scene",
                    input_path="Worlds/hero",
                    model_id="demo/scene",
                    collection="SceneRuns",
                    params={"quality": "draft"},
                ), BackgroundTasks()))

            self.assertEqual(result, {"job_id": "scene-job"})
            self.assertEqual(captured["input_kind"], "scene")
            self.assertEqual(captured["artifact_path"], manifest.resolve())
            self.assertEqual(captured["collection"], "SceneRuns")
            self.assertEqual(captured["model_id"], "demo/scene")
            self.assertIsNone(captured["artifact_snapshot"])
            self.assertEqual(captured["params"], {
                "quality": "draft",
                "remesh": "none",
                "enable_texture": False,
                "texture_resolution": 1024,
                "scene_manifest_path": str(manifest.resolve()),
            })
            self.assertNotIn("scene_path", captured["params"])
            self.assertNotIn("input_scene_path", captured["params"])


    def test_artifact_jobs_use_queued_model_id_not_later_active_model(self) -> None:
        from services.artifact_input import TypedArtifactInput
        from services.generator_registry import generator_registry
        from services import generation_jobs

        workspace = Path(tempfile.mkdtemp(prefix="modly-artifact-pin-"))
        scene_dir = workspace / "Worlds" / "race"
        scene_dir.mkdir(parents=True)
        manifest = scene_dir / "scene-manifest.json"
        manifest.write_text(json.dumps({
            "schema": "modly.scene-manifest.v1",
            "sceneRoot": ".",
            "assets": [],
        }), encoding="utf-8")
        calls: list[str] = []

        class RaceGenerator:
            DISPLAY_NAME = "Race Generator"

            def __init__(self, name: str) -> None:
                self.name = name
                self.outputs_dir = workspace
                self._loaded = True

            def is_loaded(self) -> bool:
                return self._loaded

            def is_downloaded(self) -> bool:
                return True

            def load(self) -> None:
                self._loaded = True

            def unload(self) -> None:
                self._loaded = False

            def generate_artifact(self, kind, path, params, progress_cb=None, cancel_event=None):
                if kind != "scene" or path != manifest.resolve():
                    raise AssertionError("queued scene input changed before generation")
                calls.append(self.name)
                output = self.outputs_dir / params["filename"]
                output.write_bytes(b"glb")
                return output

        generation_jobs._jobs.clear()
        generation_jobs._cancelled.clear()
        generation_jobs._cancel_events.clear()
        gen_a = RaceGenerator("race/a")
        gen_b = RaceGenerator("race/b")
        with mock.patch("services.generator_registry.WORKSPACE_DIR", workspace), \
             mock.patch.object(generator_registry, "_generators", {"race/a": gen_a, "race/b": gen_b}, create=True), \
             mock.patch.object(generator_registry, "_manifests", {
                 "race/a": {"id": "race/a", "name": "Race A", "input": "scene"},
                 "race/b": {"id": "race/b", "name": "Race B", "input": "scene"},
             }, create=True), \
             mock.patch.object(generator_registry, "_active_id", "race/b", create=True):
            job_a = generation_jobs.create_job()
            job_b = generation_jobs.create_job()

            async def run_both() -> None:
                await asyncio.gather(
                    generation_jobs._run_generation(
                        job_a.job_id,
                        model_input=TypedArtifactInput("scene", manifest.resolve()),
                        params={"filename": "a.glb"},
                        collection="Race",
                        model_id="race/a",
                    ),
                    generation_jobs._run_generation(
                        job_b.job_id,
                        model_input=TypedArtifactInput("scene", manifest.resolve()),
                        params={"filename": "b.glb"},
                        collection="Race",
                        model_id="race/b",
                    ),
                )

            asyncio.run(run_both())

        self.assertEqual(calls.count("race/a"), 1)
        self.assertEqual(calls.count("race/b"), 1)
        self.assertEqual(generation_jobs.get_job_status(job_a.job_id).status, "done")
        self.assertEqual(generation_jobs.get_job_status(job_b.job_id).status, "done")

    def test_runner_scene_envelope_reinjects_all_scene_params(self) -> None:
        workspace = Path(tempfile.mkdtemp(prefix="modly-runner-scene-"))
        scene_dir = workspace / "Worlds" / "hero"
        scene_dir.mkdir(parents=True)
        manifest = scene_dir / "scene-manifest.json"
        manifest.write_text(json.dumps({
            "schema": "modly.scene-manifest.v1",
            "sceneRoot": ".",
            "assets": [],
        }), encoding="utf-8")
        received: list[tuple[object, dict]] = []
        sent: list[dict] = []

        class FakeGenerator:
            def __init__(self, model_dir, outputs_dir):
                self.model_dir = model_dir
                self.outputs_dir = outputs_dir
                self._loaded = False

            def is_loaded(self):
                return self._loaded

            def load(self):
                self._loaded = True

            def params_schema(self):
                return []

            def generate_artifact(self, kind, path, params, progress_cb, cancel_event):
                if kind != "scene":
                    raise AssertionError("scene envelope lost its typed kind")
                received.append((path, params))
                output = workspace / "output.glb"
                output.write_bytes(b"glb")
                return output

            def unload(self):
                pass

        messages = iter([
            {
                "action": "generate",
                "id": "scene-request",
                "input": {"kind": "scene", "path": str(manifest)},
                "params": {
                    "quality": "draft",
                    "scene_manifest_path": "/forged/outside.json",
                    "scene_path": "Forged/outside.json",
                    "input_scene_path": "Forged/input.json",
                },
            },
            {"action": "shutdown", "id": None},
        ])
        ext_dir = Path(tempfile.mkdtemp(prefix="modly-runner-ext-"))
        (ext_dir / "manifest.json").write_text(
            json.dumps({"id": "bundle/scene-node", "generator_class": "FakeGenerator", "input": "scene"}),
            encoding="utf-8",
        )

        with mock.patch.object(runner, "EXT_DIR", ext_dir), \
             mock.patch.object(runner, "load_generator", return_value=FakeGenerator), \
             mock.patch.object(runner, "send", side_effect=sent.append), \
             mock.patch.object(runner, "recv", return_value=messages), \
             mock.patch.object(runner, "WORKSPACE_DIR", workspace):
            runner.main()

        # Only scene_manifest_path is authoritative. The runner's open params
        # retain this undeclared legacy-looking key without promoting it to a path.
        self.assertEqual(received, [(manifest.resolve(), {
            "quality": "draft",
            "scene_manifest_path": str(manifest.resolve()),
            "input_scene_path": "Forged/input.json",
        })])
        self.assertTrue(any(message.get("type") == "done" and message.get("id") == "scene-request" for message in sent))
