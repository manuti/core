"""Tests for HuggingFace token secure storage (save/load/delete)."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from core.runtime_state import RuntimeConfig


def _runtime(tmp_path: Path) -> RuntimeConfig:
    base = tmp_path / "potato"
    model_dir = base / "models"
    state_dir = base / "state"
    model_dir.mkdir(parents=True)
    state_dir.mkdir(parents=True)
    return RuntimeConfig(
        base_dir=base,
        model_path=model_dir / "model.gguf",
        download_state_path=state_dir / "download.json",
        models_state_path=state_dir / "models.json",
        llama_base_url="http://llama.test:8080",
        chat_backend_mode="auto",
        web_port=1983,
        llama_port=8080,
        enable_orchestrator=False,
    )


def test_save_and_load_hf_token(tmp_path):
    from core.model_state import save_hf_token, load_hf_token

    runtime = _runtime(tmp_path)
    save_hf_token(runtime, "my-model-id", "hf_abc123")
    assert load_hf_token(runtime, "my-model-id") == "hf_abc123"


def test_load_missing_token_returns_none(tmp_path):
    from core.model_state import load_hf_token

    runtime = _runtime(tmp_path)
    assert load_hf_token(runtime, "nonexistent") is None


def test_delete_hf_token(tmp_path):
    from core.model_state import save_hf_token, load_hf_token, delete_hf_token

    runtime = _runtime(tmp_path)
    save_hf_token(runtime, "model-a", "hf_secret")
    save_hf_token(runtime, "model-b", "hf_other")
    delete_hf_token(runtime, "model-a")

    assert load_hf_token(runtime, "model-a") is None
    assert load_hf_token(runtime, "model-b") == "hf_other"


def test_hf_token_file_permissions(tmp_path):
    from core.model_state import save_hf_token, _hf_tokens_path

    runtime = _runtime(tmp_path)
    save_hf_token(runtime, "model-x", "hf_verysecret")

    path = _hf_tokens_path(runtime)
    assert path.exists()
    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode == 0o600, f"Expected 0600, got {oct(mode)}"


def test_hf_token_not_in_models_state(tmp_path):
    from core.model_state import save_hf_token, ensure_models_state

    runtime = _runtime(tmp_path)
    state = ensure_models_state(runtime)
    for model in state.get("models", []):
        model_id = str(model.get("id") or "")
        save_hf_token(runtime, model_id, "hf_shouldnotappear")

    state_after = ensure_models_state(runtime)
    for model in state_after.get("models", []):
        assert "hf_token" not in model, "hf_token must not be stored in models_state"


def test_overwrite_token(tmp_path):
    from core.model_state import save_hf_token, load_hf_token

    runtime = _runtime(tmp_path)
    save_hf_token(runtime, "model", "hf_old")
    save_hf_token(runtime, "model", "hf_new")
    assert load_hf_token(runtime, "model") == "hf_new"
