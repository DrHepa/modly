import json
import os
import tempfile
import unittest
from pathlib import Path

from services.scene_input import validate_scene_input, revalidate_scene_manifest, validate_scene_model_inputs
os.environ.setdefault("EXTENSION_DIR", tempfile.gettempdir())
import runner
from unittest.mock import patch
from services.extension_process import ExtensionProcess


class SceneInputTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tmp.name) / "workspace"
        self.scene = self.workspace / "Worlds" / "room"
        self.scene.mkdir(parents=True)
        (self.scene / "model.glb").write_bytes(b"mesh")
        self.manifest = self.scene / "scene-manifest.json"
        self.manifest.write_text(json.dumps({
            "schema": "modly.scene-manifest.v1",
            "sceneRoot": "Worlds/room",
            "assets": [{"path": "model.glb"}],
        }))

    def tearDown(self):
        self.tmp.cleanup()

    def test_directory_and_manifest_are_canonical_paths(self):
        expected = self.manifest.resolve()
        self.assertEqual(validate_scene_input(self.workspace, "Worlds/room"), expected)
        self.assertEqual(validate_scene_input(self.workspace, "Worlds/room/scene-manifest.json"), expected)
        self.assertEqual(revalidate_scene_manifest(self.workspace, expected), expected)

    def test_rejects_escape_and_non_manifest_json(self):
        for path in ("../outside", "/etc/passwd", "C:/outside", "Worlds/room/../room", "Worlds/room/other.json", "Worlds/%2e%2e"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                validate_scene_input(self.workspace, path)

    def test_rejects_symlink_escape_in_manifest_and_assets(self):
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        (outside / "scene-manifest.json").write_text(self.manifest.read_text())
        (self.workspace / "Worlds" / "link").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            validate_scene_input(self.workspace, "Worlds/link")
        (self.scene / "escape.glb").symlink_to(outside / "scene-manifest.json")
        data = json.loads(self.manifest.read_text())
        data["assets"].append({"path": "escape.glb"})
        self.manifest.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            validate_scene_input(self.workspace, "Worlds/room")

    def test_rejects_every_present_asset_reference_and_malformed_types(self):
        (self.workspace / "safe.glb").write_bytes(b"mesh")
        original = json.loads(self.manifest.read_text())
        for asset in (
            {"workspacePath": "safe.glb", "path": "../outside.glb"},
            {"workspacePath": "safe.glb", "path": 42},
            {"workspacePath": [], "path": "model.glb"},
        ):
            with self.subTest(asset=asset):
                self.manifest.write_text(json.dumps({**original, "assets": [asset]}))
                with self.assertRaises(ValueError):
                    validate_scene_input(self.workspace, "Worlds/room")
        self.manifest.write_text(json.dumps({**original, "assets": [{"workspacePath": "safe.glb", "path": "model.glb"}]}))
        self.assertEqual(validate_scene_input(self.workspace, "Worlds/room"), self.manifest.resolve())

    def test_rejects_symlink_inside_workspace_and_bad_preview(self):
        (self.scene / "alias.glb").symlink_to(self.scene / "model.glb")
        original = json.loads(self.manifest.read_text())
        for patch in (
            {"assets": [{"path": "alias.glb"}]},
            {"preview": {"image": None}},
            {"preview": {"video": "../outside.mp4"}},
        ):
            with self.subTest(patch=patch):
                self.manifest.write_text(json.dumps({**original, **patch}))
                with self.assertRaises(ValueError):
                    validate_scene_input(self.workspace, "Worlds/room")

    def test_rejects_scene_root_escape(self):
        data = json.loads(self.manifest.read_text())
        data["sceneRoot"] = "../outside"
        self.manifest.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            validate_scene_input(self.workspace, "Worlds/room")

    def test_scene_root_and_assets_do_not_change_with_unrelated_workspace_paths(self):
        data = json.loads(self.manifest.read_text())
        data["sceneRoot"] = "."
        self.manifest.write_text(json.dumps(data))
        self.assertEqual(validate_scene_input(self.workspace, "Worlds/room"), self.manifest.resolve())
        (self.workspace / "model.glb").write_bytes(b"unrelated")
        self.assertEqual(validate_scene_input(self.workspace, "Worlds/room"), self.manifest.resolve())
        (self.scene / "model.glb").unlink()
        with self.assertRaises(ValueError):
            validate_scene_input(self.workspace, "Worlds/room")

    def test_workspace_relative_scene_root_does_not_fall_back_to_manifest_directory(self):
        data = json.loads(self.manifest.read_text())
        data["sceneRoot"] = "subdir"
        (self.scene / "subdir").mkdir()
        (self.scene / "subdir" / "model.glb").write_bytes(b"mesh")
        self.manifest.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            validate_scene_input(self.workspace, "Worlds/room")
        (self.workspace / "subdir").mkdir()
        (self.workspace / "subdir" / "model.glb").write_bytes(b"mesh")
        self.assertEqual(validate_scene_input(self.workspace, "Worlds/room"), self.manifest.resolve())

    def test_runner_typed_scene_and_legacy_image(self):
        with patch.object(runner, "MODLY_WORKSPACE_DIR", self.workspace):
            self.assertEqual(runner._resolve_generation_input({
                "input": {"kind": "scene", "path": str(self.manifest)}
            }, declared_input="scene"), self.manifest.resolve())
            with self.assertRaises(ValueError):
                runner._resolve_generation_input(
                    {"input": {"kind": "scene", "path": "/etc/passwd"}},
                    declared_input="scene",
                )
            self.assertEqual(runner._resolve_generation_input(
                {"image_b64": "aW1hZ2U="}, declared_input="image"
            ), b"image")

    def test_extension_process_sends_typed_scene_without_image_b64(self):
        proc = ExtensionProcess(Path(self.tmp.name), {"id": "demo", "name": "Demo"})
        proc._loaded = True
        proc.input = "scene"
        sent = []
        proc._send = sent.append
        proc._recv = lambda timeout=None: {
            "type": "done",
            "id": sent[-1]["id"],
            "output_path": str(self.scene / "model.glb"),
        }
        with patch.object(proc, "_ensure_started"), patch("services.generator_registry.WORKSPACE_DIR", self.workspace):
            output = proc.generate(self.manifest.resolve(), {"quality": "high"})
        self.assertEqual(output, self.scene / "model.glb")
        self.assertEqual(sent[0]["input"], {"kind": "scene", "path": str(self.manifest.resolve())})
        self.assertNotIn("image_b64", sent[0])


class SceneModelManifestTests(unittest.TestCase):
    def test_scene_and_optional_text_are_supported(self):
        for node in (
            {"id": "scene", "input": "scene"},
            {"id": "scene", "input": "scene", "inputs": ["scene", "text"]},
            {"id": "scene", "input": "scene", "inputs": ["text", "scene"]},
        ):
            with self.subTest(node=node):
                validate_scene_model_inputs(node)

    def test_scene_with_other_artifacts_or_duplicate_ports_is_rejected(self):
        for inputs in (["scene", "image"], ["scene", "mesh"], ["scene", "scene"], ["scene", "text", "text"]):
            with self.subTest(inputs=inputs):
                with self.assertRaisesRegex(ValueError, "one scene and an optional text prompt"):
                    validate_scene_model_inputs({"id": "bad", "input": "scene", "inputs": inputs})
        with self.assertRaisesRegex(ValueError, "one scene and an optional text prompt"):
            validate_scene_model_inputs({"id": "bad", "input": "scene", "inputs": ["image"]})
        with self.assertRaisesRegex(ValueError, "one scene and an optional text prompt"):
            validate_scene_model_inputs({"id": "bad", "inputs": ["scene", "text"]})
