def assert_backend_ready(client) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_create_workflow_run_from_image_accepts_request(client, api_modules, image_upload):
    assert_backend_ready(client)

    response = client.post(
        "/workflow-runs/from-image",
        files={"image": image_upload},
        data={"model_id": api_modules["valid_model_id"], "params": '{"filename": "accepted.glb"}'},
    )

    assert response.status_code == 202
    body = response.json()
    assert body["run_id"]
    assert body["status"] in {"pending", "running"}


def test_create_workflow_run_from_none_uses_same_lifecycle_and_empty_bytes(
    client,
    api_modules,
    monkeypatch,
):
    assert_backend_ready(client)
    from services.generator_registry import generator_registry

    generator_registry._manifests[api_modules["valid_model_id"]]["input"] = "none"
    captured: dict[str, object] = {}
    original_generate = api_modules["fake_generator"].generate

    def capture_generate(
        image_bytes: bytes,
        params: dict,
        progress_cb=None,
        cancel_event=None,
    ):
        captured["image_bytes"] = image_bytes
        captured["params"] = dict(params)
        return original_generate(
            image_bytes,
            params,
            progress_cb,
            cancel_event,
        )

    monkeypatch.setattr(
        api_modules["fake_generator"],
        "generate",
        capture_generate,
    )

    response = client.post(
        "/workflow-runs/from-none",
        data={
            "model_id": api_modules["valid_model_id"],
            "params": '{"seed": 11, "filename": "workflow-none.glb"}',
        },
    )

    assert response.status_code == 202
    run_id = response.json()["run_id"]
    status_response = client.get(f"/workflow-runs/{run_id}")
    assert status_response.status_code == 200
    assert status_response.json()["status"] == "done"
    assert captured == {
        "image_bytes": b"",
        "params": {
            "seed": 11,
            "filename": "workflow-none.glb",
        },
    }


def test_create_workflow_run_from_none_rejects_non_none_model(
    client,
    api_modules,
):
    assert_backend_ready(client)

    response = client.post(
        "/workflow-runs/from-none",
        data={"model_id": api_modules["valid_model_id"]},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Model 'demo/fake' expects input 'image' but this endpoint received 'none'."
    assert api_modules["generation_jobs"]._jobs == {}


def test_workflow_run_routes_enforce_declared_model_input_symmetrically(client, api_modules, image_upload):
    assert_backend_ready(client)
    from services.generator_registry import generator_registry

    generator_registry._manifests[api_modules["valid_model_id"]]["input"] = "image"
    image_response = client.post(
        "/workflow-runs/from-image",
        files={"image": image_upload},
        data={"model_id": api_modules["valid_model_id"]},
    )
    assert image_response.status_code == 202

    text_mismatch = client.post(
        "/workflow-runs/from-text",
        json={"prompt": "hello", "model_id": api_modules["valid_model_id"]},
    )
    assert text_mismatch.status_code == 400
    assert text_mismatch.json()["detail"] == "Model 'demo/fake' expects input 'image' but this endpoint received 'text'."

    generator_registry._manifests[api_modules["valid_model_id"]]["input"] = "text"
    text_response = client.post(
        "/workflow-runs/from-text",
        json={"prompt": "hello", "model_id": api_modules["valid_model_id"]},
    )
    assert text_response.status_code == 202

    scene_manifest = api_modules["workspace_dir"] / "Worlds" / "workflow.scene.json"
    scene_manifest.parent.mkdir(parents=True, exist_ok=True)
    scene_manifest.write_text('{"schema":"modly.scene-manifest.v1","sceneRoot":"Worlds/workflow","assets":[]}', encoding="utf-8")

    generator_registry._manifests[api_modules["valid_model_id"]]["input"] = "scene"
    scene_response = client.post(
        "/workflow-runs/from-scene",
        json={"scene_path": "Worlds/workflow.scene.json", "model_id": api_modules["valid_model_id"]},
    )
    assert scene_response.status_code == 202

    image_mismatch = client.post(
        "/workflow-runs/from-image",
        files={"image": image_upload},
        data={"model_id": api_modules["valid_model_id"]},
    )
    assert image_mismatch.status_code == 400
    assert image_mismatch.json()["detail"] == "Model 'demo/fake' expects input 'scene' but this endpoint received 'image'."


def test_workflow_run_from_image_accepts_legacy_missing_input_metadata(client, api_modules, image_upload):
    assert_backend_ready(client)
    from services.generator_registry import generator_registry

    generator_registry._manifests[api_modules["valid_model_id"]].pop("input", None)
    response = client.post(
        "/workflow-runs/from-image",
        files={"image": image_upload},
        data={"model_id": api_modules["valid_model_id"]},
    )

    assert response.status_code == 202


def test_workflow_run_routes_reject_blank_model_id(client, api_modules, image_upload):
    assert_backend_ready(client)

    image_response = client.post(
        "/workflow-runs/from-image",
        files={"image": image_upload},
        data={"model_id": "   "},
    )
    assert image_response.status_code == 400
    assert image_response.json()["detail"] == "model_id is required"

    none_response = client.post(
        "/workflow-runs/from-none",
        data={"model_id": "   "},
    )
    assert none_response.status_code == 400
    assert none_response.json()["detail"] == "model_id is required"
    assert api_modules["generation_jobs"]._jobs == {}


def test_get_workflow_run_returns_done_payload_with_scene_candidate(client, api_modules, image_upload):
    assert_backend_ready(client)

    create_response = client.post(
        "/workflow-runs/from-image",
        files={"image": image_upload},
        data={"model_id": api_modules["valid_model_id"], "params": '{"filename": "workflow-output.glb"}'},
    )
    run_id = create_response.json()["run_id"]

    status_response = client.get(f"/workflow-runs/{run_id}")

    assert status_response.status_code == 200
    body = status_response.json()
    assert body["run_id"] == run_id
    assert body["status"] == "done"
    assert body["progress"] == 100
    assert body["output_url"] == "/workspace/Default/workflow-output.glb"
    assert body["scene_candidate"] == {
        "kind": "mesh",
        "workspace_path": "Default/workflow-output.glb",
        "output_url": "/workspace/Default/workflow-output.glb",
        "display_name": "workflow-output.glb",
    }


def test_get_unknown_workflow_run_returns_404(client):
    assert_backend_ready(client)

    response = client.get("/workflow-runs/missing-run")

    assert response.status_code == 404
    assert "missing-run" in response.json()["detail"]


def test_get_workflow_run_returns_error_status_when_generation_fails(client, api_modules, image_upload):
    assert_backend_ready(client)
    api_modules["fake_generator"].fail_with = RuntimeError("boom from fake generator")

    create_response = client.post(
        "/workflow-runs/from-image",
        files={"image": image_upload},
        data={"model_id": api_modules["valid_model_id"]},
    )
    run_id = create_response.json()["run_id"]

    status_response = client.get(f"/workflow-runs/{run_id}")

    assert status_response.status_code == 200
    body = status_response.json()
    assert body["status"] == "error"
    assert "boom from fake generator" in body["error"]


def test_cancel_workflow_run_is_idempotent(client, api_modules):
    assert_backend_ready(client)

    job = api_modules["generation_jobs"].create_job()
    job.status = "running"

    first = client.post(f"/workflow-runs/{job.job_id}/cancel")
    second = client.post(f"/workflow-runs/{job.job_id}/cancel")
    status_response = client.get(f"/workflow-runs/{job.job_id}")

    assert first.status_code == 202
    assert first.json() == {"run_id": job.job_id, "status": "cancelled"}
    assert second.status_code == 200
    assert second.json() == {"run_id": job.job_id, "status": "cancelled"}
    assert status_response.status_code == 200
    assert status_response.json()["status"] == "cancelled"


def test_cancel_unknown_workflow_run_returns_404(client):
    assert_backend_ready(client)

    response = client.post("/workflow-runs/missing-run/cancel")

    assert response.status_code == 404
    assert "missing-run" in response.json()["detail"]


def test_create_workflow_run_rejects_unknown_model(client, api_modules, image_upload):
    assert_backend_ready(client)

    response = client.post(
        "/workflow-runs/from-image",
        files={"image": image_upload},
        data={"model_id": "unknown/model"},
    )

    assert response.status_code == 400
    assert "Unknown model ID" in response.json()["detail"]
    assert api_modules["generation_jobs"]._jobs == {}


def test_create_workflow_run_rejects_non_image_input(client, api_modules):
    assert_backend_ready(client)

    response = client.post(
        "/workflow-runs/from-image",
        files={"image": ("notes.txt", b"not-an-image", "text/plain")},
        data={"model_id": api_modules["valid_model_id"]},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "File must be an image"
    assert api_modules["generation_jobs"]._jobs == {}


def test_create_workflow_run_rejects_invalid_params_json(client, api_modules, image_upload):
    assert_backend_ready(client)

    response = client.post(
        "/workflow-runs/from-image",
        files={"image": image_upload},
        data={"model_id": api_modules["valid_model_id"], "params": "{not-json}"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "params must be a valid JSON object"
    assert api_modules["generation_jobs"]._jobs == {}


def test_create_workflow_run_rejects_non_object_params(client, api_modules, image_upload):
    assert_backend_ready(client)

    response = client.post(
        "/workflow-runs/from-image",
        files={"image": image_upload},
        data={"model_id": api_modules["valid_model_id"], "params": '["not", "an", "object"]'},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "params must be a JSON object"
    assert api_modules["generation_jobs"]._jobs == {}


def test_done_workflow_run_payload_remains_descriptive_only(client, api_modules, image_upload):
    assert_backend_ready(client)

    create_response = client.post(
        "/workflow-runs/from-image",
        files={"image": image_upload},
        data={"model_id": api_modules["valid_model_id"], "params": '{"filename": "ui-only.glb"}'},
    )
    run_id = create_response.json()["run_id"]

    status_response = client.get(f"/workflow-runs/{run_id}")

    assert status_response.status_code == 200
    body = status_response.json()
    assert body["status"] == "done"
    assert body["output_url"] == "/workspace/Default/ui-only.glb"
    assert body["scene_candidate"] == {
        "kind": "mesh",
        "workspace_path": "Default/ui-only.glb",
        "output_url": "/workspace/Default/ui-only.glb",
        "display_name": "ui-only.glb",
    }
    assert "add_to_scene" not in body
    assert "action" not in body["scene_candidate"]
