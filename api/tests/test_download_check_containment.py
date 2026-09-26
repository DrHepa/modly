from pathlib import Path

from services.download_check import safe_download_check_exists
from services.extension_process import ExtensionProcess
from services.generators.base import BaseGenerator


class CheckGenerator(BaseGenerator):
    def load(self) -> None:
        self._model = object()

    def generate(self, image_bytes, params, progress_cb=None, cancel_event=None) -> Path:
        return self.outputs_dir / "out.glb"


def test_base_generator_allows_existing_nested_download_check(tmp_path):
    model_dir = tmp_path / "models" / "demo" / "generate"
    check = model_dir / "weights" / "model.bin"
    check.parent.mkdir(parents=True)
    check.write_bytes(b"model")
    generator = CheckGenerator(model_dir, tmp_path / "outputs")
    generator.download_check = "weights/model.bin"

    assert generator.is_downloaded() is True


def test_base_generator_rejects_traversal_download_check(tmp_path):
    model_dir = tmp_path / "models" / "demo" / "generate"
    sibling = tmp_path / "models" / "demo" / "other" / "model.bin"
    sibling.parent.mkdir(parents=True)
    sibling.write_bytes(b"model")
    model_dir.mkdir(parents=True)
    generator = CheckGenerator(model_dir, tmp_path / "outputs")
    generator.download_check = "../other/model.bin"

    assert generator.is_downloaded() is False


def test_extension_process_rejects_child_symlink_download_check(tmp_path):
    model_dir = tmp_path / "models" / "demo" / "generate"
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "model.bin").write_bytes(b"model")
    model_dir.mkdir(parents=True)
    (model_dir / "linked").symlink_to(outside, target_is_directory=True)
    process = ExtensionProcess(tmp_path / "extension", {
        "id": "demo/generate",
        "download_check": "linked/model.bin",
    })
    process.model_dir = model_dir

    assert process.is_downloaded() is False


def test_download_check_rejects_unsafe_dot_empty_absolute_and_backslash(tmp_path):
    model_dir = tmp_path / "models" / "demo" / "generate"
    model_dir.mkdir(parents=True)

    assert safe_download_check_exists(model_dir, "") is False
    assert safe_download_check_exists(model_dir, "./model.bin") is False
    assert safe_download_check_exists(model_dir, "/tmp/model.bin") is False
    assert safe_download_check_exists(model_dir, "weights\\model.bin") is False
    assert safe_download_check_exists(model_dir, "weights/missing.bin") is False


def test_download_check_readiness_matches_electron_non_empty_semantics(tmp_path):
    model_dir = tmp_path / "models" / "demo" / "generate"
    empty_file = model_dir / "empty.bin"
    empty_file.parent.mkdir(parents=True)
    empty_file.touch()
    assert safe_download_check_exists(model_dir, "empty.bin") is False
    non_empty_dir = model_dir / "weights"
    non_empty_dir.mkdir()
    (non_empty_dir / "marker").write_bytes(b"ok")
    assert safe_download_check_exists(model_dir, "weights") is True
