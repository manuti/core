"""Model state -- Potato-specific adapter over inferno.model_registry.

This module provides the RuntimeConfig-aware interface that the rest of
Potato uses.  All registry, format, settings, and projector logic lives
in inferno.model_registry and inferno.model_families; this file supplies
product-level defaults (device detection, default model selection) and
translates RuntimeConfig into ModelStoreConfig for inferno.

Activation flow (resolve_active_model, model_present) remains here
because it mutates RuntimeConfig.model_path -- extraction is planned
for a follow-up ticket.
"""

from __future__ import annotations

import json
import os
import stat
import tempfile
import time
from pathlib import Path
from typing import Any

try:
    from core.runtime_state import (
        RuntimeConfig,
        _atomic_write_json,
        _read_pi_device_model_name,
        classify_runtime_device,
    )
except ModuleNotFoundError:
    from runtime_state import (  # type: ignore[no-redef]
        RuntimeConfig,
        _atomic_write_json,
        _read_pi_device_model_name,
        classify_runtime_device,
    )

# ---------------------------------------------------------------------------
# Re-exports from inferno (pure functions, no RuntimeConfig dependency)
# ---------------------------------------------------------------------------

from inferno.model_registry import (  # noqa: F401 — re-exports
    DEFAULT_MODEL_CHAT_SETTINGS,
    DEFAULT_MODEL_VISION_SETTINGS,
    MODELS_STATE_VERSION,
    VALID_MODEL_EXTENSIONS,
    ModelSettingsValidationError,
    ModelStoreConfig,
    _has_valid_model_extension,
    _is_discoverable_local_model_filename,
    _sanitize_filename,
    _slugify_id,
    _unique_filename,
    _unique_model_id,
    apply_model_chat_defaults,
    build_model_capabilities,
    get_model_by_id,
    is_qwen35_a3b_filename,
    model_format_for_filename,
    model_supports_vision_filename,
    normalize_model_settings,
    validate_model_url,
)
from inferno.model_families import (  # noqa: F401 — re-exports
    _is_vision_family,
    default_projector_candidates_for_model,
)
from inferno.model_registry import (
    model_file_path as _inferno_model_file_path,
    model_file_present as _inferno_model_file_present,
    describe_model_storage as _inferno_describe_model_storage,
    resolve_model_runtime_path as _inferno_resolve_model_runtime_path,
    discover_local_model_filenames as _inferno_discover_local_model_filenames,
    ensure_models_state as _inferno_ensure_models_state,
    save_models_state as _inferno_save_models_state,
    register_model_url as _inferno_register_model_url,
    delete_model as _inferno_delete_model,
    update_model_settings as _inferno_update_model_settings,
    any_model_ready as _inferno_any_model_ready,
    download_default_projector_for_model as _inferno_download_default_projector,
)
from inferno.model_families import (
    build_model_projector_status as _inferno_build_model_projector_status,
)


# ---------------------------------------------------------------------------
# Product-level constants (Potato-specific defaults)
# ---------------------------------------------------------------------------

MODEL_FILENAME = "Qwen3.5-2B-Q4_K_M.gguf"
MODEL_URL = (
    "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/"
    "Qwen3.5-2B-Q4_K_M.gguf"
)

MODEL_FILENAME_PI4 = "Qwen3.5-0.8B-IQ4_NL.gguf"
MODEL_URL_PI4 = (
    "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/"
    "Qwen3.5-0.8B-IQ4_NL.gguf"
)


def default_model_for_device(device_class: str) -> tuple[str, str]:
    if device_class.startswith("pi4-"):
        return MODEL_FILENAME_PI4, MODEL_URL_PI4
    return MODEL_FILENAME, MODEL_URL


# ---------------------------------------------------------------------------
# RuntimeConfig → ModelStoreConfig translation
# ---------------------------------------------------------------------------


def _detect_device_class() -> str:
    return classify_runtime_device(pi_model_name=_read_pi_device_model_name())


def _store_config(runtime: RuntimeConfig) -> ModelStoreConfig:
    device_class = _detect_device_class()
    filename, url = default_model_for_device(device_class)
    return ModelStoreConfig(
        models_dir=runtime.base_dir / "models",
        state_path=runtime.models_state_path,
        default_filename=filename,
        default_url=url,
        known_default_filenames=(MODEL_FILENAME, MODEL_FILENAME_PI4),
        current_model_filename=getattr(runtime.model_path, "name", ""),
    )


def _models_dir(runtime: RuntimeConfig) -> Path:
    return runtime.base_dir / "models"


# ---------------------------------------------------------------------------
# Thin wrappers (RuntimeConfig → inferno delegation)
# ---------------------------------------------------------------------------


def _model_file_path(runtime: RuntimeConfig, filename: str) -> Path:
    return _inferno_model_file_path(_models_dir(runtime), filename)


def model_file_present(runtime: RuntimeConfig, filename: str) -> bool:
    return _inferno_model_file_present(_models_dir(runtime), filename)


def describe_model_storage(runtime: RuntimeConfig, filename: str) -> dict[str, Any]:
    return _inferno_describe_model_storage(_models_dir(runtime), filename)


def resolve_model_runtime_path(runtime: RuntimeConfig, filename: str) -> Path:
    return _inferno_resolve_model_runtime_path(_models_dir(runtime), filename)


def _discover_local_model_filenames(runtime: RuntimeConfig) -> list[str]:
    return _inferno_discover_local_model_filenames(_models_dir(runtime))


# Entries discovered on disk (or uploaded) have no URL to download from again,
# so a missing file means the user deleted it outside the app.
_LOCAL_ONLY_SOURCE_TYPES = frozenset({"local_file", "upload"})


def _prune_missing_local_models(
    runtime: RuntimeConfig,
    state: dict[str, Any],
) -> dict[str, Any] | None:
    """Drop registry entries whose model file was deleted outside the app.

    A missing file prunes the entry when it has no URL to download from again
    (discovered on disk / uploaded) or when it was already marked ``ready``
    (downloaded before, then removed). Registrations that were never downloaded
    keep their entry so they stay downloadable/resumable.

    Returns ``None`` when nothing had to be pruned.
    """
    models = state.get("models")
    if not isinstance(models, list):
        return None
    kept: list[dict[str, Any]] = []
    pruned = False
    for item in models:
        if not isinstance(item, dict):
            continue
        filename = str(item.get("filename") or "")
        if not filename or _inferno_model_file_present(_models_dir(runtime), filename):
            kept.append(item)
            continue
        source_url = str(item.get("source_url") or "").strip()
        source_type = str(item.get("source_type") or "").strip().lower()
        status = str(item.get("status") or "").strip().lower()
        if (not source_url and source_type in _LOCAL_ONLY_SOURCE_TYPES) or status == "ready":
            pruned = True
            continue
        kept.append(item)
    if not pruned:
        return None
    next_state = dict(state)
    next_state["models"] = kept
    return next_state


def ensure_models_state(runtime: RuntimeConfig) -> dict[str, Any]:
    config = _store_config(runtime)
    state = _inferno_ensure_models_state(config)
    pruned = _prune_missing_local_models(runtime, state)
    if pruned is None:
        return state
    return _inferno_save_models_state(config, pruned)


# ---------------------------------------------------------------------------
# Per-model load health (core-owned, survives restarts)
# ---------------------------------------------------------------------------

MODEL_HEALTH_FILENAME = "model_health.json"


def _model_health_path(runtime: RuntimeConfig) -> Path:
    return runtime.base_dir / "state" / MODEL_HEALTH_FILENAME


def empty_model_health() -> dict[str, Any]:
    return {
        "attempted": False,
        "ready_once": False,
        "failed": False,
        "last_error": None,
        "last_attempt_at_unix": None,
        "updated_at_unix": None,
    }


def _normalize_model_health(raw: Any) -> dict[str, Any]:
    health = empty_model_health()
    if not isinstance(raw, dict):
        return health
    health["attempted"] = bool(raw.get("attempted", False))
    health["ready_once"] = bool(raw.get("ready_once", False))
    health["failed"] = bool(raw.get("failed", False))
    error = raw.get("last_error")
    if isinstance(error, str) and error.strip():
        health["last_error"] = error.strip()[:500]
    for key in ("last_attempt_at_unix", "updated_at_unix"):
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            health[key] = value
    return health


def read_model_health(runtime: RuntimeConfig) -> dict[str, dict[str, Any]]:
    """Health records keyed by model id; empty when nothing was attempted yet."""
    try:
        raw = json.loads(_model_health_path(runtime).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict) or not isinstance(raw.get("models"), dict):
        return {}
    return {
        str(model_id): _normalize_model_health(value)
        for model_id, value in raw["models"].items()
        if isinstance(model_id, str)
    }


def _write_model_health(runtime: RuntimeConfig, entries: dict[str, dict[str, Any]]) -> None:
    _atomic_write_json(_model_health_path(runtime), {"models": entries})


def record_model_launch_attempt(runtime: RuntimeConfig, model_id: str) -> None:
    if not model_id:
        return
    entries = read_model_health(runtime)
    health = entries.get(model_id, empty_model_health())
    now = int(time.time())
    health.update({"attempted": True, "last_attempt_at_unix": now, "updated_at_unix": now})
    entries[model_id] = health
    _write_model_health(runtime, entries)


def record_model_ready(runtime: RuntimeConfig, model_id: str) -> None:
    if not model_id:
        return
    entries = read_model_health(runtime)
    health = entries.get(model_id, empty_model_health())
    if health["ready_once"] and not health["failed"] and health["last_error"] is None:
        return
    health.update(
        {
            "attempted": True,
            "ready_once": True,
            "failed": False,
            "last_error": None,
            "updated_at_unix": int(time.time()),
        }
    )
    entries[model_id] = health
    _write_model_health(runtime, entries)


def record_model_failure(
    runtime: RuntimeConfig,
    model_id: str,
    *,
    error: str | None,
    failed: bool,
) -> None:
    if not model_id:
        return
    entries = read_model_health(runtime)
    health = entries.get(model_id, empty_model_health())
    health.update(
        {
            "attempted": True,
            # Sticky: a model that never loaded stays red across retries and
            # restarts until it actually becomes ready.
            "failed": bool(failed) or bool(health["failed"]),
            "last_error": (str(error).strip()[:500] if error else None),
            "updated_at_unix": int(time.time()),
        }
    )
    entries[model_id] = health
    _write_model_health(runtime, entries)


def save_models_state(runtime: RuntimeConfig, state: dict[str, Any]) -> dict[str, Any]:
    return _inferno_save_models_state(_store_config(runtime), state)


def register_model_url(runtime: RuntimeConfig, source_url: str, alias: str | None = None) -> tuple[bool, str, dict[str, Any] | None]:
    return _inferno_register_model_url(_store_config(runtime), source_url, alias)


def delete_model(runtime: RuntimeConfig, *, model_id: str) -> tuple[bool, str, bool, int, bool]:
    return _inferno_delete_model(_store_config(runtime), model_id=model_id)


def update_model_settings(
    runtime: RuntimeConfig,
    *,
    model_id: str,
    settings: dict[str, Any],
) -> tuple[bool, str, dict[str, Any] | None]:
    return _inferno_update_model_settings(_store_config(runtime), model_id=model_id, settings=settings)


def any_model_ready(runtime: RuntimeConfig) -> bool:
    return _inferno_any_model_ready(_store_config(runtime))


def download_default_projector_for_model(*, runtime: RuntimeConfig, model_id: str) -> tuple[bool, str, str | None]:
    return _inferno_download_default_projector(_store_config(runtime), model_id)


def build_model_projector_status(runtime: RuntimeConfig, model: dict[str, Any]) -> dict[str, Any]:
    return _inferno_build_model_projector_status(_models_dir(runtime), model)


# ---------------------------------------------------------------------------
# HuggingFace token store (separate file, mode 0600)
# ---------------------------------------------------------------------------

def _hf_tokens_path(runtime: RuntimeConfig) -> Path:
    return runtime.base_dir / "state" / "hf_tokens.json"


def save_hf_token(runtime: RuntimeConfig, model_id: str, token: str) -> None:
    path = _hf_tokens_path(runtime)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        tokens: dict[str, str] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (json.JSONDecodeError, OSError):
        tokens = {}
    if token:
        tokens[model_id] = token
    else:
        tokens.pop(model_id, None)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        os.chmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(tokens))
        os.replace(tmp_name, path)
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass


def load_hf_token(runtime: RuntimeConfig, model_id: str) -> str | None:
    path = _hf_tokens_path(runtime)
    if not path.exists():
        return None
    try:
        tokens: dict[str, str] = json.loads(path.read_text(encoding="utf-8"))
        return tokens.get(model_id) or None
    except (json.JSONDecodeError, OSError):
        return None


def delete_hf_token(runtime: RuntimeConfig, model_id: str) -> None:
    save_hf_token(runtime, model_id, "")


# ---------------------------------------------------------------------------
# Product policy state
# ---------------------------------------------------------------------------


def set_download_countdown_enabled(runtime: RuntimeConfig, enabled: bool) -> dict[str, Any]:
    state = ensure_models_state(runtime)
    state["countdown_enabled"] = bool(enabled)
    return save_models_state(runtime, state)


def _default_model_record(_runtime: RuntimeConfig, *, device_class: str = "") -> dict[str, Any]:
    effective_class = device_class or _detect_device_class()
    filename, url = default_model_for_device(effective_class)
    return {
        "id": "default",
        "filename": filename,
        "source_url": url,
        "source_type": "url",
        "status": "not_downloaded",
        "error": None,
        "settings": normalize_model_settings(None, filename=filename),
    }


# ---------------------------------------------------------------------------
# Activation flow (excluded from #295 extraction scope)
# ---------------------------------------------------------------------------


def resolve_active_model(state: dict[str, Any], runtime: RuntimeConfig) -> tuple[dict[str, Any], Path]:
    active_id = str(state.get("active_model_id") or "")
    model = get_model_by_id(state, active_id)
    if model is None:
        model = state["models"][0]
        state["active_model_id"] = model["id"]
    path = resolve_model_runtime_path(runtime, str(model["filename"]))
    runtime.model_path = path
    return model, path


def model_present(runtime: RuntimeConfig) -> bool:
    state = ensure_models_state(runtime)
    _, active_model_path = resolve_active_model(state, runtime)
    try:
        return active_model_path.exists() and active_model_path.stat().st_size > 0
    except OSError:
        return False
