from __future__ import annotations

import json

from fastapi.testclient import TestClient

from core.main import create_app, get_runtime


def _client_with_coder(runtime) -> TestClient:
    app = create_app(runtime=runtime, enable_orchestrator=True)
    app.dependency_overrides[get_runtime] = lambda: runtime
    client = TestClient(app)
    client.__enter__()
    upload = client.post(
        "/internal/models/upload",
        headers={"x-potato-filename": "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf"},
        content=b"gguf",
    )
    assert upload.status_code == 200
    model_id = upload.json()["model"]["id"]
    client.model_id = model_id  # type: ignore[attr-defined]
    return client


def test_tune_endpoint_returns_preset_and_diff(runtime):
    client = _client_with_coder(runtime)
    try:
        response = client.post("/internal/settings/tune", json={"model_id": client.model_id})
        persisted = json.loads(runtime.models_state_path.read_text(encoding="utf-8"))
    finally:
        client.__exit__(None, None, None)

    assert response.status_code == 200
    body = response.json()
    assert body["model_id"] == client.model_id
    assert body["filename"] == "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf"
    assert body["preset"] == "code"
    changed = {change["key"]: (change["from"], change["to"]) for change in body["changes"]}
    assert changed == {
        "temperature": (0.7, 0.2),
        "top_p": (0.8, 0.95),
        "repetition_penalty": (1.0, 1.05),
        "presence_penalty": (1.5, 1.0),
    }
    assert body["settings"]["temperature"] == 0.2
    assert body["settings"]["max_tokens"] == 16384
    # Tuning is a suggestion only: nothing persisted.
    stored = next(model for model in persisted["models"] if model["id"] == client.model_id)
    assert stored["settings"]["chat"]["temperature"] == 0.7


def test_tune_endpoint_rejects_unknown_model(runtime):
    app = create_app(runtime=runtime, enable_orchestrator=True)
    app.dependency_overrides[get_runtime] = lambda: runtime

    with TestClient(app) as client:
        response = client.post("/internal/settings/tune", json={"model_id": "nope"})

    assert response.status_code == 404
    assert response.json()["reason"] == "model_not_found"


def test_tune_endpoint_requires_model_id(runtime):
    app = create_app(runtime=runtime, enable_orchestrator=True)
    app.dependency_overrides[get_runtime] = lambda: runtime

    with TestClient(app) as client:
        response = client.post("/internal/settings/tune", json={})

    assert response.status_code == 400
    assert response.json()["reason"] == "model_id_required"
