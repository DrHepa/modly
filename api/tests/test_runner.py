import unittest
import os
import io
import sys
import json
import tempfile
import importlib
import subprocess
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from services.video_input import validate_video_input, video_snapshot_to_dict


_tmp_ext_dir = tempfile.mkdtemp(prefix="modly-runner-test-")
Path(_tmp_ext_dir, "manifest.json").write_text("{}", encoding="utf-8")
os.environ.setdefault("EXTENSION_DIR", _tmp_ext_dir)

runner = importlib.import_module("runner")
_apply_manifest_metadata = runner._apply_manifest_metadata
_resolve_ready_schema = runner._resolve_ready_schema
_select_node = runner._select_node


class RunnerTests(unittest.TestCase):
    def test_select_node_uses_model_dir_override(self) -> None:
        manifest = {
            "nodes": [
                {"id": "fast", "params_schema": [{"id": "a"}]},
                {"id": "quality", "params_schema": [{"id": "b"}]},
            ]
        }

        node = _select_node(manifest, str(Path("/tmp/ext/quality")))

        self.assertEqual(node["id"], "quality")

    def test_ready_schema_falls_back_to_selected_node_schema(self) -> None:
        class Gen:
            def params_schema(self):
                raise RuntimeError("not available")

        manifest = {"params_schema": [{"id": "manifest"}]}
        node = {"params_schema": [{"id": "node"}]}

        schema = _resolve_ready_schema(Gen(), node, manifest)

        self.assertEqual(schema, [{"id": "node"}])

    def test_apply_manifest_metadata_prefers_node_specific_values(self) -> None:
        gen = type("Gen", (), {})()
        manifest = {
            "hf_repo": "top/repo",
            "hf_skip_prefixes": ["top/"],
            "hf_include_prefixes": ["top-include/"],
            "download_check": "top/file",
            "params_schema": [{"id": "top"}],
        }
        node = {
            "hf_repo": "node/repo",
            "hf_skip_prefixes": ["node/"],
            "hf_include_prefixes": ["node-include/"],
            "download_check": "node/file",
            "params_schema": [{"id": "node"}],
        }

        _apply_manifest_metadata(gen, manifest, node)

        self.assertEqual(gen.hf_repo, "node/repo")
        self.assertEqual(gen.hf_skip_prefixes, ["node/"])
        self.assertEqual(gen.hf_include_prefixes, ["node-include/"])
        self.assertEqual(gen.download_check, "node/file")
        self.assertEqual(gen._params_schema, [{"id": "node"}])

    def test_apply_manifest_metadata_falls_back_to_manifest_when_node_empty(self) -> None:
        gen = type("Gen", (), {})()
        manifest = {
            "hf_repo": "top/repo",
            "hf_skip_prefixes": ["top/"],
            "hf_include_prefixes": ["top-include/"],
            "download_check": "top/file",
            "params_schema": [{"id": "top"}],
        }

        _apply_manifest_metadata(gen, manifest, {})

        self.assertEqual(gen.hf_repo, "top/repo")
        self.assertEqual(gen.hf_skip_prefixes, ["top/"])
        self.assertEqual(gen.hf_include_prefixes, ["top-include/"])
        self.assertEqual(gen.download_check, "top/file")
        self.assertEqual(gen._params_schema, [{"id": "top"}])


class SelectNodeTests(unittest.TestCase):
    def test_returns_empty_dict_when_manifest_has_no_nodes(self) -> None:
        self.assertEqual(_select_node({}, ""), {})

    def test_falls_back_to_first_node_when_override_matches_nothing(self) -> None:
        manifest = {"nodes": [{"id": "a"}, {"id": "b"}]}
        self.assertEqual(_select_node(manifest, str(Path("/tmp/ext/zzz")))["id"], "a")

    def test_returns_first_node_when_no_override(self) -> None:
        manifest = {"nodes": [{"id": "a"}, {"id": "b"}]}
        self.assertEqual(_select_node(manifest, "")["id"], "a")


class ResolveReadySchemaTests(unittest.TestCase):
    def test_uses_generator_method_when_available(self) -> None:
        class Gen:
            def params_schema(self):
                return [{"id": "from-class"}]

        schema = _resolve_ready_schema(Gen(), {"params_schema": [{"id": "node"}]}, {})
        self.assertEqual(schema, [{"id": "from-class"}])

    def test_falls_back_to_manifest_when_node_has_no_schema(self) -> None:
        class Gen:
            def params_schema(self):
                raise RuntimeError("unavailable")

        schema = _resolve_ready_schema(Gen(), {}, {"params_schema": [{"id": "manifest"}]})
        self.assertEqual(schema, [{"id": "manifest"}])


class MainTests(unittest.TestCase):
    def test_runner_emits_ready_without_host_third_party_packages(self) -> None:
        with tempfile.TemporaryDirectory(prefix="modly-isolated-runner-") as tmp:
            root = Path(tmp)
            extension_dir = root / "extension"
            model_dir = root / "models" / "isolated" / "ready"
            workspace_dir = root / "workspace"
            extension_dir.mkdir()
            model_dir.mkdir(parents=True)
            workspace_dir.mkdir()

            manifest = {
                "id": "isolated",
                "generator_class": "MinimalGenerator",
                "nodes": [
                    {
                        "id": "ready",
                        "input": "image",
                        "output": "mesh",
                        "params_schema": [],
                    }
                ],
            }
            (extension_dir / "manifest.json").write_text(
                json.dumps(manifest),
                encoding="utf-8",
            )
            (extension_dir / "generator.py").write_text(
                "\n".join(
                    [
                        "from services.generators.base import BaseGenerator",
                        "",
                        "class MinimalGenerator(BaseGenerator):",
                        "    def load(self):",
                        "        self._model = object()",
                        "",
                        "    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None):",
                        "        return self.outputs_dir / 'unused.glb'",
                        "",
                    ]
                ),
                encoding="utf-8",
            )

            env = os.environ.copy()
            env.pop("PYTHONHOME", None)
            env.pop("PYTHONPATH", None)
            env.update(
                {
                    "EXTENSION_DIR": str(extension_dir),
                    "MODEL_ID": "isolated/ready",
                    "MODEL_DIR": str(model_dir),
                    "MODELS_DIR": str(root / "models"),
                    "WORKSPACE_DIR": str(workspace_dir),
                    "MODLY_API_DIR": str(Path(runner.__file__).resolve().parent),
                    "PYTHONNOUSERSITE": "1",
                }
            )
            completed = subprocess.run(
                [sys.executable, "-S", str(Path(runner.__file__).resolve())],
                input="",
                text=True,
                capture_output=True,
                cwd=extension_dir,
                env=env,
                timeout=10,
                check=False,
            )

            messages = [
                json.loads(line)
                for line in completed.stdout.splitlines()
                if line.strip()
            ]
            self.assertTrue(
                messages,
                msg=f"runner emitted no protocol messages; stderr={completed.stderr!r}",
            )
            self.assertEqual(
                messages[0],
                {"type": "ready", "params_schema": []},
                msg=f"stderr={completed.stderr!r}",
            )
            self.assertEqual(completed.returncode, 0, msg=completed.stderr)

    def test_main_emits_ready_before_reading_actions(self) -> None:
        manifest = {
            "id": "bundle/node-a",
            "generator_class": "FakeGenerator",
            "nodes": [{"id": "node-a", "params_schema": [{"id": "node-schema"}]}],
        }
        sent: list[dict] = []

        class FakeGenerator:
            def __init__(self, model_dir, outputs_dir):
                self.model_dir = model_dir
                self.outputs_dir = outputs_dir
                self.load_calls = 0

            def params_schema(self):
                return [{"id": "runtime-schema"}]

            def load(self):
                self.load_calls += 1

            def unload(self):
                pass

        with mock.patch.object(runner, "load_generator", return_value=FakeGenerator), \
             mock.patch.object(runner, "send", side_effect=sent.append), \
             mock.patch.object(runner, "recv", return_value=iter(())), \
             mock.patch.object(
                 Path,
                 "read_text",
                 return_value=json.dumps(manifest),
             ):
            runner.main()

        self.assertEqual(sent, [{"type": "ready", "params_schema": [{"id": "runtime-schema"}]}])

    def test_main_ready_emission_does_not_call_load(self) -> None:
        manifest = {
            "id": "bundle/node-a",
            "generator_class": "FakeGenerator",
            "nodes": [{"id": "node-a", "params_schema": [{"id": "node-schema"}]}],
        }
        sent: list[dict] = []
        fake_generator = None

        class FakeGenerator:
            def __init__(self, model_dir, outputs_dir):
                nonlocal fake_generator
                fake_generator = self
                self.model_dir = model_dir
                self.outputs_dir = outputs_dir
                self.load_calls = 0

            def params_schema(self):
                return [{"id": "runtime-schema"}]

            def load(self):
                self.load_calls += 1

            def unload(self):
                pass

        with mock.patch.object(runner, "load_generator", return_value=FakeGenerator), \
             mock.patch.object(runner, "send", side_effect=sent.append), \
             mock.patch.object(runner, "recv", return_value=iter(())), \
             mock.patch.object(
                 Path,
                 "read_text",
                 return_value=json.dumps(manifest),
             ):
            runner.main()

        self.assertIsNotNone(fake_generator)
        self.assertEqual(fake_generator.load_calls, 0)
        self.assertEqual(sent[0]["type"], "ready")


class GenerationInputProtocolTests(unittest.TestCase):
    def test_legacy_image_payload_decodes_to_bytes(self) -> None:
        import base64

        payload = base64.b64encode(b"legacy-image").decode()

        result = runner._resolve_generation_input(
            {"image_b64": payload},
            declared_input="image",
        )

        self.assertEqual(result, b"legacy-image")

    def test_typed_video_kind_must_match_declared_input(self) -> None:
        with self.assertRaisesRegex(ValueError, "does not match"):
            runner._resolve_generation_input(
                {"input": {"kind": "video", "path": "/tmp/clip.mp4", "snapshot": {}}},
                declared_input="image",
            )

    def test_main_preserves_validated_video_envelope_to_generator(self) -> None:
        workspace_dir = Path(tempfile.mkdtemp(prefix="modly-runner-workspace-"))
        video_path = workspace_dir / "Workflows" / "clip.mp4"
        video_path.parent.mkdir(parents=True)
        video_path.write_bytes(b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2")
        manifest = {
            "id": "bundle/video-node",
            "generator_class": "FakeGenerator",
            "input": "video",
        }
        received: list[tuple[object, dict]] = []
        sent: list[dict] = []

        class FakeGenerator:
            def __init__(self, model_dir, outputs_dir):
                self.model_dir = model_dir
                self.outputs_dir = outputs_dir

            def params_schema(self):
                return []

            def generate(self, generation_input, params, progress_cb, cancel_event):
                self_input_kind = getattr(generation_input, "kind", None)
                self_input_path = getattr(generation_input, "path", None)
                if self_input_kind != "video" or self_input_path != video_path.resolve():
                    raise AssertionError("Scene video input must be a typed video envelope")
                received.append((generation_input, params))
                return workspace_dir / "output.glb"

            def unload(self):
                pass

        _, snapshot = validate_video_input(workspace_dir, "Workflows/clip.mp4")
        messages = iter([
            {
                "action": "generate",
                "id": "video-request",
                "input": {
                    "kind": "video",
                    "path": str(video_path),
                    "snapshot": video_snapshot_to_dict(snapshot),
                },
                "params": {"quality": "draft"},
            },
            {"action": "shutdown", "id": None},
        ])

        with mock.patch.object(runner, "load_generator", return_value=FakeGenerator), \
             mock.patch.object(runner, "send", side_effect=sent.append), \
             mock.patch.object(runner, "recv", return_value=messages), \
             mock.patch.object(runner, "MODLY_WORKSPACE_DIR", workspace_dir, create=True), \
             mock.patch.object(
                 Path,
                 "read_text",
                 return_value=json.dumps(manifest),
             ):
            runner.main()

        self.assertEqual(len(received), 1)
        self.assertEqual(getattr(received[0][0], "kind", None), "video")
        self.assertEqual(getattr(received[0][0], "path", None), video_path.resolve())
        self.assertIsNone(getattr(received[0][0], "snapshot", None))
        self.assertEqual(received[0][1], {"quality": "draft"})
        self.assertTrue(any(
            message == {
                "type": "done",
                "id": "video-request",
                "output_path": str(workspace_dir / "output.glb"),
            }
            for message in sent
        ))


class ProtocolTests(unittest.TestCase):
    """recv()/send() implement the newline-delimited JSON wire protocol."""

    def setUp(self) -> None:
        self._stdin = sys.stdin

    def tearDown(self) -> None:
        sys.stdin = self._stdin

    def test_recv_parses_lines_and_skips_blank_lines(self) -> None:
        sys.stdin = io.StringIO('{"a": 1}\n\n   \n{"b": 2}\n')
        self.assertEqual(list(runner.recv()), [{"a": 1}, {"b": 2}])

    def test_recv_skips_invalid_json_without_crashing_and_logs_error(self) -> None:
        sys.stdin = io.StringIO('not json\n{"ok": 1}\n')
        out = io.StringIO()
        with redirect_stdout(out):
            messages = list(runner.recv())

        self.assertEqual(messages, [{"ok": 1}])
        logged = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
        self.assertTrue(any(
            entry.get("level") == "error" and "invalid JSON" in entry.get("message", "")
            for entry in logged
        ))

    def test_send_writes_single_json_line(self) -> None:
        out = io.StringIO()
        with redirect_stdout(out):
            runner.send({"type": "ready", "params_schema": []})

        written = out.getvalue()
        self.assertTrue(written.endswith("\n"))
        self.assertEqual(written.count("\n"), 1)
        self.assertEqual(json.loads(written), {"type": "ready", "params_schema": []})


if __name__ == "__main__":
    unittest.main()
