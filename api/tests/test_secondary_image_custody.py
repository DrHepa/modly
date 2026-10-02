import asyncio
from io import BytesIO
import json
import stat
from pathlib import Path

import pytest
from PIL import Image

from conftest import PNG_BYTES


@pytest.mark.parametrize("route", ["/generate/from-image", "/workflow-runs/from-image"])
def test_generation_body_limit_rejects_chunked_body_without_content_length(api_modules, monkeypatch, route):
    from main import GenerationMultipartBodyLimitMiddleware

    jobs = api_modules["generation_jobs"]
    monkeypatch.setattr(jobs, "generation_multipart_body_limit", lambda: 5)
    messages = iter(
        [
            {"type": "http.request", "body": b"123", "more_body": True},
            {"type": "http.request", "body": b"456", "more_body": False},
        ]
    )
    sent = []

    async def receive():
        return next(messages)

    async def send(message):
        sent.append(message)

    async def consume(scope, receive, send):
        del scope
        while True:
            message = await receive()
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    asyncio.run(
        GenerationMultipartBodyLimitMiddleware(consume)(
            {"type": "http", "method": "POST", "path": route, "headers": []},
            receive,
            send,
        )
    )
    assert sent[0]["type"] == "http.response.start"
    assert sent[0]["status"] == 413


@pytest.mark.parametrize("route", ["/generate/from-image", "/workflow-runs/from-image"])
def test_generation_body_limit_rejects_content_length_before_parser(api_modules, monkeypatch, route):
    from main import GenerationMultipartBodyLimitMiddleware

    jobs = api_modules["generation_jobs"]
    monkeypatch.setattr(jobs, "generation_multipart_body_limit", lambda: 5)
    receive_calls = 0
    sent = []

    async def receive():
        nonlocal receive_calls
        receive_calls += 1
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    async def app(*_args):
        raise AssertionError("body parser must not run")

    asyncio.run(
        GenerationMultipartBodyLimitMiddleware(app)(
            {
                "type": "http",
                "method": "POST",
                "path": route,
                "headers": [(b"content-length", b"6")],
            },
            receive,
            send,
        )
    )
    assert sent[0]["status"] == 413
    assert receive_calls == 0


def _multipart(*, model_id: str, secondaries: list[tuple[int, str]]):
    fields = [("image", ("primary.png", PNG_BYTES, "image/png"))]
    for slot, handle in secondaries:
        fields.extend(
            [
                ("secondary_image", (f"slot-{slot}.png", PNG_BYTES, "image/png")),
                ("secondary_image_slot", (None, str(slot))),
                ("secondary_image_handle", (None, handle)),
            ]
        )
    fields.append(("model_id", (None, model_id)))
    return fields


def test_secondary_uploads_preserve_slot_gaps_and_are_cleaned_after_success(
    client, api_modules, monkeypatch
):
    generator = api_modules["fake_generator"]
    workspace = api_modules["workspace_dir"]
    captured = {}
    original_generate = generator.generate

    def generate(image_bytes, params, progress_cb=None, cancel_event=None):
        paths = params["extra_image_paths"]
        captured["paths"] = list(paths)
        assert paths[0] is None
        staged = paths[1]
        assert staged is not None
        staged_path = Path(staged)
        assert staged_path.parent.parent == workspace / ".modly-private-inputs"
        assert staged_path.is_file()
        assert stat.S_IMODE(staged_path.parent.stat().st_mode) == 0o700
        assert stat.S_IMODE(staged_path.stat().st_mode) == 0o600
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(generator, "generate", generate)
    response = client.post(
        "/generate/from-image",
        files=_multipart(
            model_id=api_modules["valid_model_id"],
            secondaries=[(3, "image_3")],
        ),
    )

    assert response.status_code == 200
    assert captured["paths"][0] is None
    assert not (workspace / ".modly-private-inputs" / response.json()["job_id"]).exists()


def test_workflow_run_from_image_has_multipart_secondary_parity(
    client, api_modules, monkeypatch
):
    generator = api_modules["fake_generator"]
    workspace = api_modules["workspace_dir"]
    captured = {}
    original_generate = generator.generate

    def generate(image_bytes, params, progress_cb=None, cancel_event=None):
        captured["secondary"] = Path(params["extra_image_paths"][1])
        assert captured["secondary"].is_file()
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(generator, "generate", generate)
    response = client.post(
        "/workflow-runs/from-image",
        files=_multipart(
            model_id=api_modules["valid_model_id"],
            secondaries=[(3, "image_3")],
        ),
    )

    assert response.status_code == 202
    run_id = response.json()["run_id"]
    assert client.get(f"/workflow-runs/{run_id}").json()["status"] == "done"
    assert not captured["secondary"].exists()
    assert not (workspace / ".modly-private-inputs" / run_id).exists()


def test_workflow_run_from_image_rejects_multipart_metadata_and_size_bypasses(
    client, api_modules, monkeypatch
):
    jobs = api_modules["generation_jobs"]
    model_id = api_modules["valid_model_id"]
    missing_handle = client.post(
        "/workflow-runs/from-image",
        files=[
            ("image", ("primary.png", PNG_BYTES, "image/png")),
            ("secondary_image", ("left.png", PNG_BYTES, "image/png")),
            ("secondary_image_slot", (None, "2")),
            ("model_id", (None, model_id)),
        ],
    )
    assert missing_handle.status_code == 400
    assert "counts must match" in missing_handle.text

    wrong_handle = client.post(
        "/workflow-runs/from-image",
        files=_multipart(model_id=model_id, secondaries=[(2, "image_3")]),
    )
    assert wrong_handle.status_code == 400
    assert "must be 'image_2'" in wrong_handle.text

    monkeypatch.setattr(jobs, "MAX_IMAGE_UPLOAD_BYTES", len(PNG_BYTES) + 1)
    oversize = client.post(
        "/workflow-runs/from-image",
        files=[
            ("image", ("primary.png", PNG_BYTES, "image/png")),
            ("secondary_image", ("large.png", PNG_BYTES * 2, "image/png")),
            ("secondary_image_slot", (None, "2")),
            ("secondary_image_handle", (None, "image_2")),
            ("model_id", (None, model_id)),
        ],
    )
    assert oversize.status_code == 413
    assert "64 MiB" in oversize.text
    assert jobs._jobs == {}


def test_secondary_upload_cleanup_runs_after_generator_error(client, api_modules):
    generator = api_modules["fake_generator"]
    workspace = api_modules["workspace_dir"]
    generator.fail_with = RuntimeError("partial generation")

    response = client.post(
        "/generate/from-image",
        files=_multipart(
            model_id=api_modules["valid_model_id"],
            secondaries=[(2, "image_2")],
        ),
    )

    assert response.status_code == 200
    job_id = response.json()["job_id"]
    assert client.get(f"/generate/status/{job_id}").json()["status"] == "error"
    assert not (workspace / ".modly-private-inputs" / job_id).exists()


def test_secondary_upload_cleanup_runs_after_pre_execution_cancel(api_modules):
    jobs = api_modules["generation_jobs"]
    generator = api_modules["fake_generator"]
    generator._loaded = True
    job = jobs.create_job()
    params, private_dir = jobs._stage_secondary_images(
        job.job_id,
        {},
        [(2, "image_2", PNG_BYTES, ".png")],
        model_id=api_modules["valid_model_id"],
    )
    jobs._cancelled.add(job.job_id)

    asyncio.run(
        jobs._run_generation(
            job.job_id,
            image_bytes=PNG_BYTES,
            params=params,
            model_id=api_modules["valid_model_id"],
            private_input_dir=private_dir,
        )
    )

    assert not private_dir.exists()


def test_secondary_upload_rejects_duplicate_invalid_and_mismatched_slots(client, api_modules):
    model_id = api_modules["valid_model_id"]
    duplicate = client.post(
        "/generate/from-image",
        files=_multipart(model_id=model_id, secondaries=[(2, "image_2"), (2, "image_2")]),
    )
    invalid = client.post(
        "/generate/from-image",
        files=_multipart(model_id=model_id, secondaries=[(5, "image_5")]),
    )
    wrong_handle = client.post(
        "/generate/from-image",
        files=_multipart(model_id=model_id, secondaries=[(2, "image_3")]),
    )
    over_capacity = client.post(
        "/generate/from-image",
        files=_multipart(
            model_id=model_id,
            secondaries=[(2, "image_2"), (3, "image_3"), (4, "image_4"), (5, "image_5")],
        ),
    )

    assert duplicate.status_code == 400
    assert "unique" in duplicate.text
    assert invalid.status_code == 400
    assert "one of: 2, 3, 4" in invalid.text
    assert wrong_handle.status_code == 400
    assert "must be 'image_2'" in wrong_handle.text
    assert over_capacity.status_code == 400
    assert "capacity" in over_capacity.text
    assert api_modules["generation_jobs"]._jobs == {}


def test_secondary_upload_rejects_oversize_and_bad_content(client, api_modules, monkeypatch):
    jobs = api_modules["generation_jobs"]
    monkeypatch.setattr(jobs, "MAX_IMAGE_UPLOAD_BYTES", len(PNG_BYTES) + 1)
    model_id = api_modules["valid_model_id"]
    oversize = client.post(
        "/generate/from-image",
        files=[
            ("image", ("primary.png", PNG_BYTES, "image/png")),
            ("secondary_image", ("large.png", PNG_BYTES * 2, "image/png")),
            ("secondary_image_slot", (None, "2")),
            ("secondary_image_handle", (None, "image_2")),
            ("model_id", (None, model_id)),
        ],
    )
    monkeypatch.setattr(jobs, "MAX_IMAGE_UPLOAD_BYTES", 64 * 1024 * 1024)
    bad = client.post(
        "/generate/from-image",
        files=[
            ("image", ("primary.png", PNG_BYTES, "image/png")),
            ("secondary_image", ("bad.png", b"not an image", "image/png")),
            ("secondary_image_slot", (None, "2")),
            ("secondary_image_handle", (None, "image_2")),
            ("model_id", (None, model_id)),
        ],
    )

    assert oversize.status_code == 413
    assert "64 MiB" in oversize.text
    assert bad.status_code == 400
    assert "not a decodable" in bad.text
    assert jobs._jobs == {}


def test_primary_upload_enforces_byte_and_safe_dimension_limits(client, api_modules, monkeypatch):
    jobs = api_modules["generation_jobs"]
    monkeypatch.setattr(jobs, "MAX_IMAGE_UPLOAD_BYTES", len(PNG_BYTES) - 1)
    oversize = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={"model_id": api_modules["valid_model_id"]},
    )
    assert oversize.status_code == 413

    monkeypatch.setattr(jobs, "MAX_IMAGE_UPLOAD_BYTES", 64 * 1024 * 1024)
    monkeypatch.setattr(jobs, "MAX_IMAGE_PIXELS", 0)
    unsafe_dimensions = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={"model_id": api_modules["valid_model_id"]},
    )
    assert unsafe_dimensions.status_code == 400
    assert "dimensions" in unsafe_dimensions.text


@pytest.mark.parametrize(
    "alias",
    [
        "left_image_path",
        "back_image_path",
        "right_image_path",
        "reference_image_path",
        "reference_image_paths",
        "custom-role_image_path",
        "CUSTOM_ROLE_IMAGE_PATHS",
        "input_images",
        "inputImages",
        "reference_images",
        "referenceImages",
        "referenceImagePaths",
        "Reference-Image-Paths",
        "REFERENCE.IMAGE.PATHS",
        "arbitraryCamelCasePath",
        "scene_manifest_path",
        "video_path",
        "capture_manifest_path",
    ],
)
def test_undeclared_generation_parameters_are_forbidden(client, api_modules, alias):
    response = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({alias: ["/tmp/external.png"]}),
        },
    )
    assert response.status_code == 400
    assert "not declared" in response.text
    assert api_modules["generation_jobs"]._jobs == {}


def test_declared_scalar_generation_parameter_is_accepted(client, api_modules):
    response = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({"quality": "draft"}),
        },
    )

    assert response.status_code == 200


def test_typed_transport_param_is_rejected_even_when_manifest_declares_it(
    client, api_modules
):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest["params_schema"].append({"id": "video_path", "type": "string"})
    response = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({"video_path": "/tmp/forged.mp4"}),
        },
    )

    assert response.status_code == 400
    assert "server-managed" in response.text
    assert api_modules["generation_jobs"]._jobs == {}


@pytest.mark.parametrize("route", ["/generate/from-image", "/workflow-runs/from-image"])
@pytest.mark.parametrize(
    "alias", ["scene_path", "input_scene_path", "video_path", "mesh_path"]
)
def test_image_routes_never_authorize_typed_transport_aliases_from_client_params(
    client, api_modules, route, alias
):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest["name"] = "Pixal3D Scene Prep"
    manifest["params_schema"].append({"id": alias, "type": "string"})

    response = client.post(
        route,
        files={"image": ("front.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({alias: "../../forged-host-transport"}),
        },
    )

    assert response.status_code == 400
    assert "server-managed" in response.text
    assert api_modules["generation_jobs"]._jobs == {}


@pytest.mark.parametrize("route, expected_status, id_key", [
    ("/generate/from-scene", 200, "job_id"),
    ("/workflow-runs/from-scene", 202, "run_id"),
])
def test_pixal3d_worldsculpt_scene_aliases_are_injected_only_by_typed_route(
    client, api_modules, monkeypatch, route, expected_status, id_key
):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest.pop("inputs")
    manifest["name"] = "Pixal3D WorldSculpt"
    manifest["input"] = "scene"
    manifest["params_schema"] = [
        {"id": "face_budget", "type": "int"},
        {"id": "scene_path", "type": "string"},
        {"id": "input_scene_path", "type": "string"},
    ]
    scene = api_modules["workspace_dir"] / "Worlds" / "pixal" / "scene-manifest.json"
    scene.parent.mkdir(parents=True)
    scene.write_text(json.dumps({
        "schema": "modly.scene-manifest.v1",
        "sceneRoot": ".",
        "assets": [],
    }))
    captured = []
    generator = api_modules["fake_generator"]
    original_generate = generator.generate

    def generate(image_bytes, params, progress_cb=None, cancel_event=None):
        captured.append(dict(params))
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(generator, "generate", generate)
    response = client.post(route, json={
        "scene_path": "Worlds/pixal/scene-manifest.json",
        "model_id": api_modules["valid_model_id"],
        "params": {"face_budget": 1_000_000},
    })

    assert response.status_code == expected_status
    assert response.json()[id_key]
    assert captured[-1]["face_budget"] == 1_000_000
    assert captured[-1]["scene_path"] == "Worlds/pixal/scene-manifest.json"
    assert captured[-1]["input_scene_path"] == "Worlds/pixal/scene-manifest.json"


@pytest.mark.parametrize("route, expected_status", [
    ("/generate/from-image", 200),
    ("/workflow-runs/from-image", 202),
])
def test_installed_style_boolean_select_values_match_by_exact_type(
    client, api_modules, route, expected_status
):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest["params_schema"].append({
        "id": "remove_bg",
        "type": "select",
        "default": True,
        "options": [
            {"value": True, "label": "Yes"},
            {"value": False, "label": "No"},
        ],
    })

    for value in (True, False):
        response = client.post(
            route,
            files={"image": ("front.png", PNG_BYTES, "image/png")},
            data={
                "model_id": api_modules["valid_model_id"],
                "params": json.dumps({"remove_bg": value}),
            },
        )
        assert response.status_code == expected_status

    for value in (0, 1, "true", "false"):
        response = client.post(
            route,
            files={"image": ("front.png", PNG_BYTES, "image/png")},
            data={
                "model_id": api_modules["valid_model_id"],
                "params": json.dumps({"remove_bg": value}),
            },
        )
        assert response.status_code == 400
        assert "valid select value" in response.text


@pytest.mark.parametrize("route, expected_status, id_key", [
    ("/generate/from-image", 200, "job_id"),
    ("/workflow-runs/from-image", 202, "run_id"),
])
def test_legacy_workspace_images_are_snapshotted_with_gaps_and_cleaned(
    client, api_modules, monkeypatch, route, expected_status, id_key
):
    workspace = api_modules["workspace_dir"]
    legacy = workspace / "Inputs" / "legacy-secondary.png"
    legacy.parent.mkdir()
    legacy.write_bytes(PNG_BYTES)
    generator = api_modules["fake_generator"]
    original_generate = generator.generate
    captured = {}

    def generate(image_bytes, params, progress_cb=None, cancel_event=None):
        captured["paths"] = list(params["extra_image_paths"])
        assert captured["paths"][0] is None
        staged = Path(captured["paths"][1])
        assert staged.is_file()
        assert staged.name == "legacy-secondary.png"
        assert staged != legacy
        assert staged.parent.parent == workspace / ".modly-private-inputs"
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(generator, "generate", generate)
    response = client.post(
        route,
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({
                "quality": "draft",
                "extra_image_paths": [None, str(legacy.resolve())],
            }),
        },
    )

    assert response.status_code == expected_status
    assert captured["paths"][0] is None
    assert not Path(captured["paths"][1]).exists()
    assert not (workspace / ".modly-private-inputs" / response.json()[id_key]).exists()
    assert legacy.is_file()


@pytest.mark.parametrize(
    "legacy_value, expected",
    [
        (["/tmp/external-secondary.png"], "inside the workspace"),
        (["Inputs/../traversal.png"], "inside the workspace"),
        ([None, None, None, "Inputs/too-many.png"], "capacity"),
        ("Inputs/not-a-list.png", "bounded list"),
    ],
)
def test_legacy_workspace_images_reject_invalid_values(
    client, api_modules, legacy_value, expected
):
    response = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({"extra_image_paths": legacy_value}),
        },
    )

    assert response.status_code == 400
    assert expected in response.text
    assert api_modules["generation_jobs"]._jobs == {}


def test_legacy_workspace_images_reject_link_and_bad_content(client, api_modules):
    workspace = api_modules["workspace_dir"]
    bad = workspace / "Inputs" / "bad.png"
    bad.parent.mkdir()
    bad.write_bytes(b"not an image")
    outside = workspace.parent / "outside.png"
    outside.write_bytes(PNG_BYTES)
    link = bad.parent / "link.png"
    try:
        link.symlink_to(outside)
    except NotImplementedError:
        pytest.skip("symlink creation is unavailable on this platform")
    except OSError as exc:
        if getattr(exc, "winerror", None) == 1314:
            pytest.skip("symlink creation requires additional privileges on this platform")
        raise

    for path, expected in [
        ("Inputs/bad.png", "not a decodable"),
        ("Inputs/link.png", "link or reparse point"),
    ]:
        response = client.post(
            "/generate/from-image",
            files={"image": ("primary.png", PNG_BYTES, "image/png")},
            data={
                "model_id": api_modules["valid_model_id"],
                "params": json.dumps({"extra_image_paths": [path]}),
            },
        )
        assert response.status_code == 400
        assert expected in response.text


def test_legacy_extra_image_paths_reject_casefold_basename_collisions(
    client, api_modules
):
    workspace = api_modules["workspace_dir"]
    first = workspace / "Front" / "View.png"
    second = workspace / "Back" / "view.PNG"
    first.parent.mkdir()
    second.parent.mkdir()
    first.write_bytes(PNG_BYTES)
    second.write_bytes(PNG_BYTES)

    response = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({
                "extra_image_paths": ["Front/View.png", "Back/view.PNG"],
            }),
        },
    )

    assert response.status_code == 400
    assert "colliding image names" in response.text
    assert api_modules["generation_jobs"]._jobs == {}


def test_legacy_workspace_images_enforce_per_file_size_bound(
    client, api_modules, monkeypatch
):
    jobs = api_modules["generation_jobs"]
    legacy = api_modules["workspace_dir"] / "legacy.png"
    legacy.write_bytes(PNG_BYTES * 2)
    monkeypatch.setattr(jobs, "MAX_IMAGE_UPLOAD_BYTES", len(PNG_BYTES))

    response = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({"extra_image_paths": ["legacy.png"]}),
        },
    )

    assert response.status_code == 413
    assert "64 MiB" in response.text
    assert jobs._jobs == {}


def test_legacy_workspace_images_reject_multipart_conflict(client, api_modules):
    legacy = api_modules["workspace_dir"] / "legacy.png"
    legacy.write_bytes(PNG_BYTES)
    fields = _multipart(
        model_id=api_modules["valid_model_id"],
        secondaries=[(2, "image_2")],
    )
    fields.append(("params", (None, json.dumps({"extra_image_paths": ["legacy.png"]}))))

    response = client.post("/generate/from-image", files=fields)

    assert response.status_code == 400
    assert "must not be combined" in response.text
    assert api_modules["generation_jobs"]._jobs == {}


def test_named_and_custom_manifest_handles_are_validated_and_injected(client, api_modules, monkeypatch):
    jobs = api_modules["generation_jobs"]
    from services.generator_registry import generator_registry

    generator_registry._manifests[api_modules["valid_model_id"]]["inputs"] = [
        {"name": "front", "type": "image"},
        {"name": "detail-map", "type": "image"},
        {"name": "right", "type": "image"},
    ]
    captured = {}
    generator = api_modules["fake_generator"]
    original_generate = generator.generate

    def generate(image_bytes, params, progress_cb=None, cancel_event=None):
        captured.update(params)
        assert params["extra_image_paths"][0] is None
        assert Path(params["extra_image_paths"][1]).is_file()
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(generator, "generate", generate)
    response = client.post(
        "/generate/from-image",
        files=_multipart(
            model_id=api_modules["valid_model_id"],
            secondaries=[(3, "right")],
        ),
    )
    assert response.status_code == 200
    assert set(captured).isdisjoint({"right_image_path", "detail-map_image_path"})
    assert captured["extra_image_paths"][0] is None
    assert not Path(captured["extra_image_paths"][1]).exists()

    wrong = client.post(
        "/generate/from-image",
        files=_multipart(
            model_id=api_modules["valid_model_id"],
            secondaries=[(2, "right")],
        ),
    )
    assert wrong.status_code == 400
    assert "detail-map" in wrong.text


def test_declared_hunyuan_style_image_path_params_are_server_managed(
    client, api_modules, monkeypatch
):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest["inputs"] = [
        {"name": "front", "type": "image", "required": True},
        {"name": "left", "type": "image", "required": False},
        {"name": "back", "type": "image", "required": False},
        {"name": "right", "type": "image", "required": False},
    ]
    manifest["params_schema"] = [
        {"id": "quality", "type": "string"},
        {
            "id": "reference_images",
            "type": "select",
            "default": 4,
            "options": [{"value": 1}, {"value": 2}, {"value": 3}, {"value": 4}],
        },
        {"id": "input_images", "type": "string", "default": "three"},
        {"id": "left_image_path", "type": "string"},
        {"id": "back_image_path", "type": "string"},
        {"id": "right_image_path", "type": "string"},
        {"id": "rightImagePath", "type": "string"},
    ]

    forged = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({"left_image_path": "/tmp/external-left.png"}),
        },
    )
    assert forged.status_code == 400
    assert "server-managed" in forged.text
    assert api_modules["generation_jobs"]._jobs == {}

    scalar_path_bypass = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({"reference_images": "/tmp/not-a-count.png"}),
        },
    )
    assert scalar_path_bypass.status_code == 400
    assert "valid select value" in scalar_path_bypass.text
    assert api_modules["generation_jobs"]._jobs == {}

    generator = api_modules["fake_generator"]
    original_generate = generator.generate
    consumed = {}

    def generate(image_bytes, params, progress_cb=None, cancel_event=None):
        consumed["left"] = Path(params["left_image_path"])
        consumed["right"] = Path(params["right_image_path"])
        consumed["right_camel"] = Path(params["rightImagePath"])
        consumed["generic"] = list(params["extra_image_paths"])
        consumed["reference_count"] = int(params["reference_images"])
        consumed["input_images_label"] = params["input_images"]
        assert consumed["left"].is_file()
        assert consumed["right"].is_file()
        assert consumed["right_camel"] == consumed["right"]
        assert "back_image_path" not in params
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(generator, "generate", generate)
    response = client.post(
        "/generate/from-image",
        files=[*_multipart(
            model_id=api_modules["valid_model_id"],
            secondaries=[(2, "left"), (4, "right")],
        ), ("params", (None, json.dumps({
            "reference_images": 3,
            "input_images": "three",
        })))],
    )

    assert response.status_code == 200
    assert consumed["generic"][0] == str(consumed["left"])
    assert consumed["generic"][1] is None
    assert consumed["generic"][2] == str(consumed["right"])
    assert consumed["reference_count"] == 3
    assert consumed["input_images_label"] == "three"
    assert consumed["generic"] != consumed["reference_count"]
    assert not consumed["left"].exists()
    assert not consumed["right"].exists()


def test_declared_sensenova_legacy_paths_are_snapshotted_without_multiport_inputs(
    client, api_modules, monkeypatch, tmp_path
):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest.pop("inputs")
    manifest["input"] = "image"
    manifest["params_schema"] = [
        {"id": "prompt_image_path", "type": "string", "pickerIntent": "image"},
        {"id": "view_2_image_path", "type": "string", "pickerIntent": "image"},
        {"id": "view10ImagePath", "type": "string", "pickerIntent": "image"},
    ]
    refs = api_modules["workspace_dir"] / "Refs"
    refs.mkdir()
    for name in ("prompt.png", "view2.png", "view10.png"):
        (refs / name).write_bytes(PNG_BYTES)

    captured = {}
    generator = api_modules["fake_generator"]
    original_generate = generator.generate

    def generate(image_bytes, params, progress_cb=None, cancel_event=None):
        for key in ("prompt_image_path", "view_2_image_path", "view10ImagePath"):
            path = Path(params[key])
            assert path.is_file()
            assert path.parent.parent == api_modules["workspace_dir"] / ".modly-private-inputs"
            captured[key] = path
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(generator, "generate", generate)
    response = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({
                "prompt_image_path": "Refs/prompt.png",
                "view_2_image_path": str((refs / "view2.png").resolve()),
                "view10ImagePath": "Refs/view10.png",
            }),
        },
    )
    assert response.status_code == 200
    assert all(not path.exists() for path in captured.values())

    external = tmp_path / "external.png"
    external.write_bytes(PNG_BYTES)
    rejected = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({"prompt_image_path": str(external)}),
        },
    )
    assert rejected.status_code == 400
    assert "stay inside the workspace" in rejected.text


def test_declared_dreamcube_depth_and_legacy_list_use_private_custody(
    client, api_modules, monkeypatch
):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest.pop("inputs")
    manifest["input"] = "image"
    manifest["params_schema"] = [
        {"id": "depth_image_path", "type": "string", "pickerIntent": "image"},
        {"id": "image_paths", "type": "string", "default": "[]", "tooltip": "JSON list of image paths."},
    ]
    refs = api_modules["workspace_dir"] / "Refs"
    refs.mkdir()
    for name in ("a.png", "b.png"):
        (refs / name).write_bytes(PNG_BYTES)
    tiff = BytesIO()
    Image.new("RGB", (2, 2), "white").save(tiff, format="TIFF")
    (refs / "depth.tiff").write_bytes(tiff.getvalue())

    captured = []
    generator = api_modules["fake_generator"]
    original_generate = generator.generate

    def generate(image_bytes, params, progress_cb=None, cancel_event=None):
        depth = Path(params["depth_image_path"])
        listed = json.loads(params["image_paths"])
        assert listed[1] is None
        paths = [depth, Path(listed[0]), Path(listed[2])]
        assert all(path.is_file() for path in paths)
        assert [path.name for path in paths] == ["depth.tiff", "a.png", "b.png"]
        captured.extend(paths)
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(generator, "generate", generate)
    response = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({
                "depth_image_path": "Refs/depth.tiff",
                "image_paths": json.dumps(["Refs/a.png", None, "Refs/b.png"]),
            }),
        },
    )
    assert response.status_code == 200
    assert client.get(f"/generate/status/{response.json()['job_id']}").json()["status"] == "done"
    assert len(captured) == 3
    assert all(not path.exists() for path in captured)


def test_legacy_image_list_rejects_casefold_basename_collisions(
    client, api_modules
):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest.pop("inputs")
    manifest["input"] = "image"
    manifest["params_schema"] = [
        {"id": "image_paths", "type": "string", "default": "[]"},
    ]
    workspace = api_modules["workspace_dir"]
    first = workspace / "Front" / "View.png"
    second = workspace / "Back" / "view.PNG"
    first.parent.mkdir()
    second.parent.mkdir()
    first.write_bytes(PNG_BYTES)
    second.write_bytes(PNG_BYTES)

    response = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({"image_paths": json.dumps([
                "Front/View.png", "Back/view.PNG",
            ])}),
        },
    )

    assert response.status_code == 400
    assert "colliding image names" in response.text
    assert api_modules["generation_jobs"]._jobs == {}


def test_declared_vggt_and_hunyuan_image_directories_use_sorted_private_custody(
    client, api_modules, monkeypatch, tmp_path
):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest.pop("inputs")
    manifest["input"] = "image"
    manifest["params_schema"] = [
        {"id": "images_dir", "type": "string", "default": ""},
        {"id": "image_folder", "type": "string", "default": ""},
        {"id": "constraints_path", "type": "string", "default": "", "pickerIntent": "generic-file", "tooltip": "Path to constraints."},
    ]
    source = api_modules["workspace_dir"] / "Views"
    source.mkdir()
    for name in ("front.png", "left.png", "back.png"):
        (source / name).write_bytes(PNG_BYTES)
    bmp = BytesIO()
    Image.new("RGB", (2, 2), "white").save(bmp, format="BMP")
    (source / "right.bmp").write_bytes(bmp.getvalue())
    (source / "ignored.txt").write_text("ignored")
    captured = []
    generator = api_modules["fake_generator"]
    original_generate = generator.generate

    def generate(image_bytes, params, progress_cb=None, cancel_event=None):
        assert params["constraints_path"] == ""
        for key in ("images_dir", "image_folder"):
            directory = Path(params[key])
            assert [item.name for item in directory.iterdir()] == ["back.png", "front.png", "left.png", "right.bmp"]
            captured.append(directory)
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(generator, "generate", generate)
    response = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={"model_id": api_modules["valid_model_id"], "params": json.dumps({
            "images_dir": "Views", "image_folder": "Views", "constraints_path": "",
        })},
    )
    assert response.status_code == 200
    assert all(not directory.exists() for directory in captured)

    external = tmp_path / "outside"
    external.mkdir()
    (external / "a.png").write_bytes(PNG_BYTES)
    rejected = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={"model_id": api_modules["valid_model_id"], "params": json.dumps({"images_dir": str(external)})},
    )
    assert rejected.status_code == 400
    assert "stay inside the workspace" in rejected.text


def test_private_image_budget_is_shared_across_multipart_and_declared_carriers(api_modules, monkeypatch):
    jobs = api_modules["generation_jobs"]
    secondary = [(2, "image_2", b"a", ".png")]
    declared = {
        f"prompt_{index}_image_path": ("scalar", [(b"b", ".png")])
        for index in range(16)
    }
    with pytest.raises(Exception, match="maximum of 16"):
        jobs.validate_private_image_request_budget(secondary, declared)

    monkeypatch.setattr(jobs, "MAX_GENERATION_MULTIPART_BYTES", 2)
    with pytest.raises(Exception, match="aggregate"):
        jobs.validate_private_image_request_budget(
            secondary,
            {"depth_image_path": ("scalar", [(b"bb", ".png")])},
        )


def test_directory_budget_stops_before_opening_over_limit_file(api_modules, monkeypatch):
    jobs = api_modules["generation_jobs"]
    from services.generator_registry import generator_registry
    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest.pop("inputs")
    manifest["input"] = "image"
    manifest["params_schema"] = [{"id": "images_dir", "type": "string", "default": ""}]
    directory = api_modules["workspace_dir"] / "Many"
    directory.mkdir()
    for index in range(16):
        (directory / f"{index:02d}.png").write_bytes(PNG_BYTES)
    budget = jobs.ImageRequestBudget()
    budget.reserve(len(PNG_BYTES))  # primary image
    original_open = jobs.os.open
    opened = []
    def tracking_open(path, *args, **kwargs):
        opened.append(Path(path).name)
        return original_open(path, *args, **kwargs)
    monkeypatch.setattr(jobs.os, "open", tracking_open)
    with pytest.raises(Exception, match="maximum of 16"):
        jobs.snapshot_declared_legacy_image_transports(
            api_modules["valid_model_id"], {"images_dir": "Many"}, budget
        )
    assert opened == [f"{index:02d}.png" for index in range(15)]


@pytest.mark.parametrize("mutation", ["grow", "truncate", "rewrite"])
def test_legacy_image_rejects_mutation_during_read(api_modules, monkeypatch, mutation):
    jobs = api_modules["generation_jobs"]
    path = api_modules["workspace_dir"] / "mutable.png"
    path.write_bytes(PNG_BYTES)
    original_read = jobs.os.read
    mutated = False
    def mutating_read(fd, size):
        nonlocal mutated
        chunk = original_read(fd, size)
        if not mutated:
            mutated = True
            if mutation == "grow":
                path.write_bytes(PNG_BYTES + b"x")
            elif mutation == "truncate":
                path.write_bytes(PNG_BYTES[:-1])
            else:
                replacement = bytearray(PNG_BYTES)
                replacement[-1] ^= 1
                path.write_bytes(replacement)
        return chunk
    monkeypatch.setattr(jobs.os, "read", mutating_read)
    with pytest.raises(Exception, match="changed while being read"):
        jobs._read_legacy_workspace_image("mutable.png", budget=jobs.ImageRequestBudget())


def test_mutable_growth_cannot_undercount_aggregate_bytes(api_modules, monkeypatch):
    jobs = api_modules["generation_jobs"]
    path = api_modules["workspace_dir"] / "growing.png"
    path.write_bytes(PNG_BYTES)
    monkeypatch.setattr(jobs, "MAX_GENERATION_MULTIPART_BYTES", len(PNG_BYTES))
    original_read = jobs.os.read
    mutated = False
    def growing_read(fd, size):
        nonlocal mutated
        chunk = original_read(fd, size)
        if not mutated:
            mutated = True
            with path.open("ab") as stream:
                stream.write(b"overflow")
        return chunk
    monkeypatch.setattr(jobs.os, "read", growing_read)
    with pytest.raises(Exception, match="aggregate|changed while being read"):
        jobs._read_legacy_workspace_image("growing.png", budget=jobs.ImageRequestBudget())


def test_declared_camel_list_image_alias_receives_only_custody_paths(
    client, api_modules, monkeypatch
):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest["params_schema"].append({"id": "referenceImagePaths", "type": "string"})
    manifest["params_schema"].append({"id": "image_paths", "type": "string"})
    captured = {}
    generator = api_modules["fake_generator"]
    original_generate = generator.generate

    def generate(image_bytes, params, progress_cb=None, cancel_event=None):
        captured.update(params)
        assert params["referenceImagePaths"] == params["extra_image_paths"]
        assert params["image_paths"] == params["extra_image_paths"]
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(generator, "generate", generate)
    response = client.post(
        "/generate/from-image",
        files=_multipart(
            model_id=api_modules["valid_model_id"],
            secondaries=[(3, "image_3")],
        ),
    )

    assert response.status_code == 200
    assert captured["referenceImagePaths"][0] is None
    assert not Path(captured["referenceImagePaths"][1]).exists()


@pytest.mark.parametrize("route, expected_status", [
    ("/generate/from-image", 200),
    ("/workflow-runs/from-image", 202),
])
def test_mixed_image_mesh_transport_uses_physical_image_slot_and_private_custody(
    client, api_modules, monkeypatch, route, expected_status
):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest["inputs"] = [
        {"name": "front", "type": "image", "required": True},
        {"name": "mesh", "type": "mesh", "required": True},
        {"name": "left", "type": "image", "required": False},
    ]
    source_mesh = api_modules["workspace_dir"] / "Meshes" / "source.glb"
    source_mesh.parent.mkdir()
    source_mesh.write_bytes(b"glTF-safe-mesh")
    generator = api_modules["fake_generator"]
    original_generate = generator.generate
    captured = {}

    def generate(image_bytes, params, progress_cb=None, cancel_event=None):
        staged_mesh = Path(params["mesh_path"])
        captured["mesh"] = staged_mesh
        captured["left"] = Path(params["extra_image_paths"][0])
        assert staged_mesh.is_file()
        assert staged_mesh.read_bytes() == source_mesh.read_bytes()
        assert staged_mesh != source_mesh
        assert staged_mesh.parent == captured["left"].parent
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(generator, "generate", generate)
    fields = _multipart(
        model_id=api_modules["valid_model_id"],
        secondaries=[(3, "left")],
    )
    fields.append(("mesh_path", (None, "Meshes/source.glb")))
    response = client.post(route, files=fields)

    assert response.status_code == expected_status
    assert not captured["mesh"].exists()
    assert not captured["left"].exists()
    assert source_mesh.is_file()


def test_mixed_manifest_legacy_extra_image_paths_remain_image_relative(
    client, api_modules, monkeypatch
):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest["inputs"] = [
        {"name": "front", "type": "image", "required": True},
        {"name": "mesh", "type": "mesh", "required": True},
        {"name": "left", "type": "image", "required": False},
        {"name": "back", "type": "image", "required": False},
    ]
    back = api_modules["workspace_dir"] / "Views" / "back.png"
    back.parent.mkdir()
    back.write_bytes(PNG_BYTES)
    captured = {}
    generator = api_modules["fake_generator"]
    original_generate = generator.generate

    def generate(image_bytes, params, progress_cb=None, cancel_event=None):
        captured["paths"] = list(params["extra_image_paths"])
        assert captured["paths"][0] is None
        assert Path(captured["paths"][1]).is_file()
        assert Path(captured["paths"][1]).name == "back.png"
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(generator, "generate", generate)
    response = client.post(
        "/generate/from-image",
        files={"image": ("front.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "params": json.dumps({"extra_image_paths": [None, "Views/back.png"]}),
        },
    )

    assert response.status_code == 200
    assert captured["paths"][0] is None
    assert not Path(captured["paths"][1]).exists()


def test_mixed_image_mesh_transport_rejects_external_and_non_mesh_models(
    client, api_modules, tmp_path
):
    from services.generator_registry import generator_registry

    outside = tmp_path.parent / "outside.glb"
    outside.write_bytes(b"glTF-external")
    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest["inputs"] = [
        {"name": "front", "type": "image", "required": True},
        {"name": "mesh", "type": "mesh", "required": True},
    ]
    external = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "mesh_path": str(outside),
        },
    )
    assert external.status_code == 400
    assert "inside the workspace" in external.text

    manifest["inputs"] = [{"name": "front", "type": "image", "required": True}]
    unsupported = client.post(
        "/generate/from-image",
        files={"image": ("primary.png", PNG_BYTES, "image/png")},
        data={
            "model_id": api_modules["valid_model_id"],
            "mesh_path": "Meshes/source.glb",
        },
    )
    assert unsupported.status_code == 400
    assert "does not declare a mesh input" in unsupported.text
    assert api_modules["generation_jobs"]._jobs == {}


def test_mixed_image_mesh_transport_rejects_link_private_tree_and_oversize(
    client, api_modules, monkeypatch
):
    from services.generator_registry import generator_registry

    jobs = api_modules["generation_jobs"]
    workspace = api_modules["workspace_dir"]
    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest["inputs"] = [
        {"name": "front", "type": "image", "required": True},
        {"name": "mesh", "type": "mesh", "required": True},
    ]
    meshes = workspace / "Meshes"
    meshes.mkdir()
    real_mesh = meshes / "real.glb"
    real_mesh.write_bytes(b"glTF-mesh")
    link_mesh = meshes / "link.glb"
    try:
        link_mesh.symlink_to(real_mesh)
    except NotImplementedError:
        pytest.skip("symlink creation is unavailable on this platform")
    except OSError as exc:
        if getattr(exc, "winerror", None) == 1314:
            pytest.skip("symlink creation requires additional privileges on this platform")
        raise
    private_mesh = workspace / ".modly-private-inputs" / "foreign" / "private.glb"
    private_mesh.parent.mkdir(parents=True)
    private_mesh.write_bytes(b"glTF-private")

    def request(path: str):
        return client.post(
            "/generate/from-image",
            files={"image": ("primary.png", PNG_BYTES, "image/png")},
            data={
                "model_id": api_modules["valid_model_id"],
                "mesh_path": path,
            },
        )

    linked = request("Meshes/link.glb")
    private = request(".modly-private-inputs/foreign/private.glb")
    monkeypatch.setattr(jobs, "MAX_MESH_INPUT_BYTES", len(real_mesh.read_bytes()) - 1)
    oversize = request("Meshes/real.glb")

    assert linked.status_code == 400
    assert "link or reparse point" in linked.text
    assert private.status_code == 400
    assert "private input custody" in private.text
    assert oversize.status_code == 413
    assert "512 MiB" in oversize.text
    assert jobs._jobs == {}


def test_input_contract_names_legacy_image_slots_and_preserves_generic_runtime_abi(
    client, api_modules, monkeypatch
):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest["inputs"] = ["image", "image", "image", "image"]
    manifest["input_contract"] = [
        {"name": "front", "type": "image", "required": True},
        {"name": "left", "type": "image", "required": False},
        {"id": "back", "type": "image", "required": False},
        {"name": "right", "type": "image", "required": False},
    ]
    captured = {}
    generator = api_modules["fake_generator"]
    original_generate = generator.generate

    def generate(image_bytes, params, progress_cb=None, cancel_event=None):
        captured.update(params)
        return original_generate(image_bytes, params, progress_cb, cancel_event)

    monkeypatch.setattr(generator, "generate", generate)
    response = client.post(
        "/generate/from-image",
        files=_multipart(
            model_id=api_modules["valid_model_id"],
            secondaries=[(3, "back")],
        ),
    )

    assert response.status_code == 200
    assert captured["extra_image_paths"][0] is None
    assert not Path(captured["extra_image_paths"][1]).exists()
    assert set(captured).isdisjoint({"back_image_path", "back_image_paths"})


def test_input_contract_duplicate_names_are_rejected(client, api_modules):
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest["input_contract"] = [
        {"name": "front", "type": "image"},
        {"name": "duplicate", "type": "image"},
        {"name": "duplicate", "type": "image"},
        {"name": "right", "type": "image"},
    ]
    response = client.post(
        "/generate/from-image",
        files=_multipart(
            model_id=api_modules["valid_model_id"],
            secondaries=[(2, "duplicate")],
        ),
    )

    assert response.status_code == 400
    assert "repeats input handle" in response.text


def test_absolute_image_port_and_multipart_bounds_ignore_malicious_manifest(api_modules):
    jobs = api_modules["generation_jobs"]
    from fastapi import HTTPException
    from services.generator_registry import generator_registry

    manifest = generator_registry._manifests[api_modules["valid_model_id"]]
    manifest["inputs"] = ["image"] * (jobs.MAX_IMAGE_PORTS + 1)
    manifest["max_secondary_images"] = 10_000
    manifest["max_upload_bytes"] = 10_000_000_000

    with pytest.raises(HTTPException, match="maximum of 16 image ports"):
        jobs._declared_image_handles(api_modules["valid_model_id"])
    assert jobs.generation_multipart_body_limit() == 512 * 1024 * 1024


def test_registry_projects_node_input_contract(api_modules, monkeypatch, tmp_path):
    import services.generator_registry as registry_module

    extension_dir = tmp_path / "extensions" / "contract-extension"
    extension_dir.mkdir(parents=True)
    input_contract = [
        {"name": "front", "type": "image", "required": True},
        {"name": "reference", "type": "image", "required": False},
    ]
    (extension_dir / "manifest.json").write_text(
        json.dumps(
            {
                "id": "contract-extension",
                "type": "model",
                "generator_class": "ContractGenerator",
                "nodes": [
                    {
                        "id": "generate",
                        "input": "image",
                        "inputs": ["image", "image"],
                        "input_contract": input_contract,
                        "output": "mesh",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (extension_dir / "generator.py").write_text(
        "from services.generators.base import BaseGenerator\n"
        "class ContractGenerator(BaseGenerator):\n"
        "    pass\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(registry_module, "EXTENSIONS_DIR", extension_dir.parent)

    discovered = registry_module._discover_extensions()

    assert discovered["contract-extension/generate"][1]["input_contract"] == input_contract


def test_job_id_collision_does_not_overwrite_existing_job(api_modules, monkeypatch):
    jobs = api_modules["generation_jobs"]
    values = iter(["collision", "collision", "unique"])
    monkeypatch.setattr(jobs.uuid, "uuid4", lambda: next(values))

    first = jobs.create_job()
    first_event = jobs._cancel_events[first.job_id]
    second = jobs.create_job()

    assert first.job_id == "collision"
    assert second.job_id == "unique"
    assert jobs._jobs["collision"] is first
    assert jobs._cancel_events["collision"] is first_event


def test_partial_staging_failure_cleans_job_directory(api_modules, monkeypatch):
    jobs = api_modules["generation_jobs"]
    original_chmod = jobs.os.chmod

    def fail_job_chmod(path, mode):
        if Path(path).name == "partial-job":
            raise OSError("chmod failed")
        return original_chmod(path, mode)

    monkeypatch.setattr(jobs.os, "chmod", fail_job_chmod)
    try:
        jobs._stage_secondary_images(
            "partial-job",
            {},
            [(2, "image_2", PNG_BYTES, ".png")],
            model_id=api_modules["valid_model_id"],
        )
    except OSError as exc:
        assert "chmod failed" in str(exc)
    else:
        raise AssertionError("expected partial staging failure")
    assert not (api_modules["workspace_dir"] / ".modly-private-inputs" / "partial-job").exists()


def test_enqueue_failure_cleans_staging_and_job_state(api_modules):
    jobs = api_modules["generation_jobs"]

    class FailingBackgroundTasks:
        def add_task(self, *_args, **_kwargs):
            raise RuntimeError("enqueue failed")

    try:
        jobs.create_from_image_job(
            FailingBackgroundTasks(),
            PNG_BYTES,
            {},
            model_id=api_modules["valid_model_id"],
            secondary_images=[(2, "image_2", PNG_BYTES, ".png")],
        )
    except RuntimeError as exc:
        assert "enqueue failed" in str(exc)
    else:
        raise AssertionError("expected enqueue failure")
    assert jobs._jobs == {}
    assert jobs._cancel_events == {}
    assert list((api_modules["workspace_dir"] / ".modly-private-inputs").glob("*")) == []


def test_stale_custody_sweep_recovers_prior_abrupt_shutdown(api_modules):
    jobs = api_modules["generation_jobs"]
    stale = api_modules["workspace_dir"] / ".modly-private-inputs" / "stale-job"
    stale.mkdir(parents=True)
    (stale / "partial.png").write_bytes(PNG_BYTES)

    assert jobs.sweep_stale_private_inputs() == []
    assert not stale.exists()


def test_shutdown_sweeps_custody_even_when_registry_shutdown_fails(api_modules, monkeypatch):
    import main
    from services.generator_registry import generator_registry

    jobs = api_modules["generation_jobs"]
    sweeps = []
    monkeypatch.setattr(jobs, "sweep_stale_private_inputs", lambda: sweeps.append("sweep") or [])
    monkeypatch.setattr(generator_registry, "initialize", lambda: None)
    monkeypatch.setattr(
        generator_registry,
        "shutdown_all",
        lambda: (_ for _ in ()).throw(RuntimeError("shutdown failed")),
    )

    async def exercise():
        try:
            async with main.lifespan(object()):
                pass
        except RuntimeError as exc:
            assert "shutdown failed" in str(exc)
        else:
            raise AssertionError("expected shutdown failure")

    asyncio.run(exercise())
    assert sweeps == ["sweep", "sweep"]


def test_cleanup_retries_and_reports_failure(api_modules, monkeypatch, caplog):
    jobs = api_modules["generation_jobs"]
    custody = api_modules["workspace_dir"] / ".modly-private-inputs" / "retry-job"
    custody.mkdir(parents=True)
    calls = 0
    original = jobs.shutil.rmtree

    def flaky(path):
        nonlocal calls
        calls += 1
        if calls < 3:
            raise OSError("busy")
        return original(path)

    monkeypatch.setattr(jobs.shutil, "rmtree", flaky)
    with caplog.at_level("WARNING"):
        assert jobs._cleanup_private_input_dir(custody)
    assert calls == 3
    assert "private input cleanup failed" in caplog.text
