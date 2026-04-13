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
