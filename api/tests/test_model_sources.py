import os
import tempfile
import unittest
from pathlib import Path

from services.model_sources import (
    model_sources_are_downloaded,
    normalize_model_sources,
    normalize_weight_group_references,
    normalize_weight_groups,
    resolve_model_root,
    resolve_weight_group_root,
    resolve_source_destination,
    safe_owner_model_id,
    validate_source_file_plan,
)


def valid_node() -> dict:
    return {
        "model_sources": [
            {
                "id": "primary",
                "provider": "huggingface",
                "repo_id": "org/main",
                "destination": ".",
                "checks": ["pipeline.json"],
            },
            {
                "id": "encoder",
                "provider": "huggingface",
                "repo_id": "org/encoder",
                "revision": "refs/pr/1",
                "destination": "auxiliary/encoder",
                "include_prefixes": ["config.json", "weights/"],
                "checks": ["config.json", "model.safetensors"],
            },
        ]
    }


class ModelSourcesTests(unittest.TestCase):
    def test_shared_weight_groups_resolve_once_under_extension_shared_root(self) -> None:
        manifest = {
            "weight_groups": [
                {"id": "pixal3d-base", "model_sources": valid_node()["model_sources"][:1]},
                {"id": "pixal3d-mv", "model_sources": valid_node()["model_sources"][1:]},
            ]
        }
        groups = normalize_weight_groups(manifest)
        self.assertEqual([group["id"] for group in groups or []], ["pixal3d-base", "pixal3d-mv"])
        self.assertEqual(
            normalize_weight_group_references(
                {"weight_groups": ["pixal3d-base", "pixal3d-mv"]}, groups
            ),
            ["pixal3d-base", "pixal3d-mv"],
        )
        with tempfile.TemporaryDirectory(prefix="modly-shared-groups-") as tmp:
            self.assertEqual(
                resolve_weight_group_root(Path(tmp), "pixal3d", "pixal3d-base"),
                Path(tmp).resolve() / "pixal3d" / "_shared" / "pixal3d-base",
            )

    def test_shared_weight_groups_reject_unknown_refs_and_reserved_node_aliases(self) -> None:
        groups = normalize_weight_groups({
            "weight_groups": [{"id": "base", "model_sources": valid_node()["model_sources"][:1]}]
        })
        with self.assertRaisesRegex(ValueError, "unknown weight group"):
            normalize_weight_group_references({"weight_groups": ["missing"]}, groups)
        with self.assertRaises(ValueError):
            resolve_weight_group_root(Path("/tmp/models"), "pixal3d", "../outside")

    def test_rejects_unsafe_legacy_weight_owner_ids_before_path_construction(self) -> None:
        for owner_id in ("demo/../outside", "/tmp/outside", "demo/C:/outside", "demo/.."):
            with self.subTest(owner_id=owner_id), self.assertRaises(ValueError):
                safe_owner_model_id(owner_id)
        self.assertEqual(safe_owner_model_id("demo/generate"), "demo/generate")
    def test_validates_new_sources_without_reinterpreting_legacy_fields(self) -> None:
        sources = normalize_model_sources(valid_node())
        self.assertEqual([source["id"] for source in sources or []], ["primary", "encoder"])
        self.assertIsNone(normalize_model_sources({
            "hf_repo": "legacy/repo",
            "download_check": "../generate/model.safetensors",
            "hf_skip_prefixes": ["weights/**"],
        }))

    def test_rejects_unsafe_and_non_portable_declarations(self) -> None:
        source = valid_node()["model_sources"][0]
        for destination in ("../outside", "aux/CON", "aux/name.", "C:/models"):
            with self.subTest(destination=destination), self.assertRaises(ValueError):
                normalize_model_sources({
                    "model_sources": [{**source, "destination": destination}]
                })
        with self.assertRaisesRegex(ValueError, "provider"):
            normalize_model_sources({
                "model_sources": [{**source, "provider": "url"}]
            })
        with self.assertRaisesRegex(ValueError, "portable-unique"):
            normalize_model_sources({
                "model_sources": [source, {**source, "id": "PRIMARY"}]
            })
        with self.assertRaisesRegex(ValueError, "checks"):
            normalize_model_sources({
                "model_sources": [{**source, "checks": []}]
            })

    def test_rejects_portable_cross_source_file_collisions(self) -> None:
        sources = normalize_model_sources(valid_node()) or []
        with self.assertRaisesRegex(ValueError, "portable target collision"):
            validate_source_file_plan(sources, {
                "primary": ["pipeline.json", "Auxiliary/Encoder/model.safetensors"],
                "encoder": ["config.json", "model.safetensors"],
            })

    def test_rejects_same_source_portable_file_collisions(self) -> None:
        sources = normalize_model_sources(valid_node()) or []
        with self.assertRaisesRegex(ValueError, "portable filename collision"):
            validate_source_file_plan(sources, {
                "primary": ["pipeline.json", "Pipeline.JSON"],
                "encoder": ["config.json", "model.safetensors"],
            })

    def test_rejects_same_source_file_directory_ancestry_collisions(self) -> None:
        sources = normalize_model_sources(valid_node()) or []
        with self.assertRaisesRegex(ValueError, "portable target collision"):
            validate_source_file_plan(sources, {
                "primary": ["pipeline.json", "weights", "weights/model.safetensors"],
                "encoder": ["config.json", "model.safetensors"],
            })

    def test_rejects_checks_excluded_from_the_download_plan(self) -> None:
        sources = normalize_model_sources(valid_node()) or []
        with self.assertRaisesRegex(ValueError, "excluded from its download plan"):
            validate_source_file_plan(sources, {
                "primary": ["pipeline.json"],
                "encoder": ["config.json"],
            })

    def test_requires_all_checks_and_rejects_symlinked_extension_ancestry(self) -> None:
        sources = normalize_model_sources(valid_node()) or []
        with tempfile.TemporaryDirectory(prefix="modly-model-sources-") as tmp:
            models = Path(tmp) / "models"
            model_root = models / "pixal3d" / "generate"
            encoder = model_root / "auxiliary" / "encoder"
            encoder.mkdir(parents=True)
            (model_root / "pipeline.json").write_text("{}", encoding="utf-8")
            (encoder / "config.json").write_text("{}", encoding="utf-8")
            self.assertFalse(model_sources_are_downloaded(models, "pixal3d/generate", sources))
            (encoder / "model.safetensors").write_bytes(b"x")
            self.assertTrue(model_sources_are_downloaded(models, "pixal3d/generate", sources))

            (encoder / "model.safetensors").write_bytes(b"")
            self.assertFalse(model_sources_are_downloaded(models, "pixal3d/generate", sources))
            (encoder / "model.safetensors").unlink()
            (encoder / "model.safetensors").mkdir()
            self.assertFalse(model_sources_are_downloaded(models, "pixal3d/generate", sources))

            for child in sorted((models / "pixal3d").rglob("*"), reverse=True):
                child.unlink() if child.is_file() else child.rmdir()
            (models / "pixal3d").rmdir()
            outside = Path(tmp) / "outside"
            (outside / "generate").mkdir(parents=True)
            try:
                os.symlink(outside, models / "pixal3d", target_is_directory=True)
            except (NotImplementedError, OSError) as exc:
                self.skipTest(f"Symlinks unavailable: {exc}")
            with self.assertRaisesRegex(ValueError, "symlink"):
                resolve_model_root(models, "pixal3d/generate")
            self.assertFalse(model_sources_are_downloaded(models, "pixal3d/generate", sources))

    def test_allows_configured_models_dir_symlink_but_rejects_child_symlink_escape(self) -> None:
        sources = normalize_model_sources(valid_node()) or []
        with tempfile.TemporaryDirectory(prefix="modly-model-sources-root-link-") as tmp:
            real_models = Path(tmp) / "real-models"
            linked_models = Path(tmp) / "linked-models"
            model_root = real_models / "pixal3d" / "generate"
            encoder = model_root / "auxiliary" / "encoder"
            encoder.mkdir(parents=True)
            (model_root / "pipeline.json").write_text("{}", encoding="utf-8")
            (encoder / "config.json").write_text("{}", encoding="utf-8")
            (encoder / "model.safetensors").write_bytes(b"x")
            outside = Path(tmp) / "outside"
            outside.mkdir()
            try:
                os.symlink(real_models, linked_models, target_is_directory=True)
            except (NotImplementedError, OSError) as exc:
                self.skipTest(f"Symlinks unavailable: {exc}")

            self.assertTrue(model_sources_are_downloaded(linked_models, "pixal3d/generate", sources))
            (encoder / "model.safetensors").unlink()
            os.symlink(outside / "model.safetensors", encoder / "model.safetensors")
            self.assertFalse(model_sources_are_downloaded(linked_models, "pixal3d/generate", sources))

    def test_rejects_existing_file_as_model_root_or_destination_ancestor(self) -> None:
        sources = normalize_model_sources(valid_node()) or []
        with tempfile.TemporaryDirectory(prefix="modly-model-sources-files-") as tmp:
            models = Path(tmp) / "models"
            (models / "pixal3d").mkdir(parents=True)
            (models / "pixal3d" / "generate").write_bytes(b"not-a-directory")
            with self.assertRaisesRegex(ValueError, "not a directory"):
                resolve_model_root(models, "pixal3d/generate")

            (models / "pixal3d" / "generate").unlink()
            (models / "pixal3d" / "generate").mkdir()
            (models / "pixal3d" / "generate" / "auxiliary").write_bytes(b"not-a-directory")
            with self.assertRaisesRegex(ValueError, "not a directory"):
                resolve_source_destination(models, "pixal3d/generate", "auxiliary/encoder")

    def test_rejects_symlinked_part_target_before_download(self) -> None:
        sources = normalize_model_sources(valid_node()) or []
        with tempfile.TemporaryDirectory(prefix="modly-model-sources-part-") as tmp:
            models = Path(tmp) / "models"
            destination = models / "pixal3d" / "generate"
            destination.mkdir(parents=True)
            outside = Path(tmp) / "outside.bin"
            try:
                os.symlink(outside, destination / "model.safetensors.part")
            except (NotImplementedError, OSError) as exc:
                self.skipTest(f"Symlinks unavailable: {exc}")
            with self.assertRaisesRegex(ValueError, "symlink"):
                from services.model_sources import resolve_download_path
                resolve_download_path(destination, "model.safetensors")


if __name__ == "__main__":
    unittest.main()
