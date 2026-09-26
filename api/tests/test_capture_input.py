import json
import os
import tempfile
import unittest
import struct
import zlib
from pathlib import Path

from services.capture_input import (
    TypedModelInput,
    revalidate_typed_model_input,
    validate_capture_input,
    validate_typed_model_node_inputs,
)


class CaptureInputTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tmp.name) / "workspace"
        self.capture = self.workspace / "Captures" / "room"
        self.capture.mkdir(parents=True)
        self.frames = self.capture / "frames"
        self.frames.mkdir()
        for index, color in enumerate(("red", "green")):
            self.write_png(self.frames / f"{index:04d}.png", 64, 48, (255, 0, 0) if color == "red" else (0, 255, 0))
        self.manifest = self.capture / "capture-manifest.json"
        self.write_manifest()

    @staticmethod
    def write_png(path: Path, width: int, height: int, color: tuple[int, int, int]):
        def chunk(name: bytes, payload: bytes) -> bytes:
            return struct.pack(">I", len(payload)) + name + payload + struct.pack(">I", zlib.crc32(name + payload) & 0xFFFFFFFF)
        scanline = bytes(color) * width
        raw = b"".join(b"\x00" + scanline for _ in range(height))
        path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

    def tearDown(self):
        self.tmp.cleanup()

    def write_manifest(self, **patch):
        frames = []
        for index in range(2):
            path = self.frames / f"{index:04d}.png"
            frames.append({
                "index": index,
                "path": f"frames/{index:04d}.png",
                "width": 64,
                "height": 48,
                "byteSize": path.stat().st_size,
            })
        payload = {
            "schema": "modly.capture-manifest.v1",
            "captureRoot": ".",
            "kind": "frames",
            "frames": frames,
            "provenance": {"source": "unit-test", "ordering": "manifest-index"},
            **patch,
        }
        self.manifest.write_text(json.dumps(payload), encoding="utf-8")

    def test_valid_ordered_frames_are_canonical(self):
        self.assertEqual(validate_capture_input(self.workspace, "Captures/room"), self.manifest.resolve())
        self.assertEqual(validate_capture_input(self.workspace, "Captures/room/capture-manifest.json"), self.manifest.resolve())

    def test_rejects_nondeterministic_or_duplicate_frame_order(self):
        data = json.loads(self.manifest.read_text())
        for frames in (
            list(reversed(data["frames"])),
            [data["frames"][0], dict(data["frames"][1], index=0)],
            [data["frames"][0], dict(data["frames"][1], path=data["frames"][0]["path"])],
        ):
            with self.subTest(frames=frames):
                self.write_manifest(frames=frames)
                with self.assertRaises(ValueError):
                    validate_capture_input(self.workspace, "Captures/room")

    def test_rejects_dimension_size_and_containment_drift(self):
        original = json.loads(self.manifest.read_text())
        patches = (
            {"frames": [dict(original["frames"][0], width=63), original["frames"][1]]},
            {"frames": [dict(original["frames"][0], byteSize=1), original["frames"][1]]},
            {"frames": [dict(original["frames"][0], path="../escape.png"), original["frames"][1]]},
        )
        for patch in patches:
            with self.subTest(patch=patch):
                self.write_manifest(**patch)
                with self.assertRaises(ValueError):
                    validate_capture_input(self.workspace, "Captures/room")

    def test_video_requires_declared_dimensions_size_and_provenance(self):
        video = self.capture / "clip.mp4"
        video.write_bytes(b"not-decoded-by-contract-test")
        self.write_manifest(
            kind="video",
            frames=None,
            video={"path": "clip.mp4", "width": 1920, "height": 1080, "frameCount": 24, "byteSize": video.stat().st_size},
            provenance={"source": "unit-test", "ordering": "decode-index"},
        )
        self.assertEqual(validate_capture_input(self.workspace, "Captures/room"), self.manifest.resolve())
        self.write_manifest(kind="video", frames=None, video={"path": "clip.mp4", "width": 0, "height": 1080, "frameCount": 24, "byteSize": video.stat().st_size}, provenance={"source": "unit-test", "ordering": "decode-index"})
        with self.assertRaises(ValueError):
            validate_capture_input(self.workspace, "Captures/room")
        self.write_manifest(provenance={})
        with self.assertRaises(ValueError):
            validate_capture_input(self.workspace, "Captures/room")

    def test_typed_input_revalidates_capture_and_scene(self):
        typed = TypedModelInput("capture", self.manifest.resolve())
        self.assertEqual(revalidate_typed_model_input(self.workspace, typed), typed)
        with self.assertRaises(ValueError):
            revalidate_typed_model_input(self.workspace, TypedModelInput("capture", Path("/etc/passwd")))


class TypedModelManifestTests(unittest.TestCase):
    def test_capture_or_scene_plus_optional_text_are_supported(self):
        for kind in ("capture", "scene"):
            validate_typed_model_node_inputs({"id": kind, "input": kind})
            validate_typed_model_node_inputs({"id": kind, "input": kind, "inputs": [kind, "text"]})

    def test_mixed_typed_artifacts_are_rejected(self):
        for node in (
            {"id": "bad", "input": "capture", "inputs": ["capture", "scene"]},
            {"id": "bad", "input": "capture", "inputs": ["capture", "image"]},
            {"id": "bad", "input": "scene", "inputs": ["scene", "capture"]},
            {"id": "bad-video-object", "input": "video", "inputs": [{"name": "clip", "type": "video"}]},
            {"id": "bad-video-named", "input": "image", "inputs": [{"name": "clip", "type": "video"}]},
        ):
            with self.subTest(node=node), self.assertRaises(ValueError):
                validate_typed_model_node_inputs(node)


if __name__ == "__main__":
    unittest.main()
