from pathlib import Path

import pytest


def _create_client(monkeypatch):
    pytest.importorskip("fastapi")

    import main
    from fastapi.testclient import TestClient
    from services.generator_registry import generator_registry

    monkeypatch.setattr(generator_registry, "initialize", lambda: None)
    monkeypatch.setattr(generator_registry, "unload_all", lambda: None)
    return TestClient(main.app)


def test_workspace_route_serves_normal_files(api_modules, monkeypatch):
    workspace_dir = api_modules["workspace_dir"]
    target = workspace_dir / "Workflows" / "generated" / "hero.txt"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("hero", encoding="utf-8")

    client = _create_client(monkeypatch)
    response = client.get("/workspace/Workflows/generated/hero.txt")

    assert response.status_code == 200
    assert response.text == "hero"


@pytest.mark.parametrize(
    "path",
    [
        "/workspace/../outside.txt",
        "/workspace/%2e%2e/outside.txt",
        "/workspace/Workflows/%2e%2e/outside.txt",
        "/workspace/%2Ftmp%2Foutside.txt",
    ],
)
def test_workspace_route_rejects_traversal_and_absolute_escapes(path, api_modules, monkeypatch):
    client = _create_client(monkeypatch)

    response = client.get(path)

    assert response.status_code == 404


def test_workspace_route_rejects_symlink_escape(api_modules, monkeypatch, tmp_path):
    workspace_dir = api_modules["workspace_dir"]
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")

    symlink_path = workspace_dir / "Workflows" / "generated" / "escape.txt"
    symlink_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        symlink_path.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is unavailable on this platform")

    client = _create_client(monkeypatch)
    response = client.get("/workspace/Workflows/generated/escape.txt")

    assert response.status_code == 404


def test_workspace_route_denies_private_input_custody_tree(api_modules, monkeypatch):
    private_file = (
        api_modules["workspace_dir"]
        / ".modly-private-inputs"
        / "job-id"
        / "slot-2.png"
    )
    private_file.parent.mkdir(parents=True)
    private_file.write_bytes(b"private")

    client = _create_client(monkeypatch)
    response = client.get("/workspace/.modly-private-inputs/job-id/slot-2.png")

    assert response.status_code == 404


@pytest.mark.parametrize(
    "path",
    [
        "/workspace/.MODLY-PRIVATE-INPUTS/job-id/slot-2.png",
        "/workspace/%2emodly-private-inputs/job-id/slot-2.png",
        "/workspace/.modly-private-inputs%5cjob-id%5cslot-2.png",
    ],
)
def test_workspace_route_denies_private_tree_spelling_variants(path, api_modules, monkeypatch):
    client = _create_client(monkeypatch)
    assert client.get(path).status_code == 404


def test_workspace_route_denies_symlink_alias_to_private_tree(api_modules):
    import main

    workspace = api_modules["workspace_dir"]
    private_file = workspace / ".modly-private-inputs" / "job" / "slot.png"
    private_file.parent.mkdir(parents=True)
    private_file.write_bytes(b"private")
    alias = workspace / "Workflows" / "private-alias"
    alias.parent.mkdir(parents=True)
    try:
        alias.symlink_to(private_file.parent, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is unavailable on this platform")

    with pytest.raises(Exception) as error:
        main.resolve_workspace_request_path(workspace, "Workflows/private-alias/slot.png")
    assert getattr(error.value, "status_code", None) == 404
