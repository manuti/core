"""Settings document routes."""

from __future__ import annotations

from typing import Any

import yaml
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

try:
    from core.deps import get_runtime
    from core.model_state import ensure_models_state, get_model_by_id, normalize_model_settings
    from core.model_tuning import suggest_model_tune
    from core.runtime_state import RuntimeConfig
    from core.settings import apply_settings_document_yaml, export_settings_document_yaml
    from core.ui_prefs import read_ui_language, write_ui_language
except ModuleNotFoundError:
    from deps import get_runtime  # type: ignore[no-redef]
    from model_state import ensure_models_state, get_model_by_id, normalize_model_settings  # type: ignore[no-redef]
    from model_tuning import suggest_model_tune  # type: ignore[no-redef]
    from runtime_state import RuntimeConfig  # type: ignore[no-redef]
    from settings import apply_settings_document_yaml, export_settings_document_yaml  # type: ignore[no-redef]
    from ui_prefs import read_ui_language, write_ui_language  # type: ignore[no-redef]

router = APIRouter()

_restart_managed_llama_process = None


def register_settings_helpers(*, restart_managed_llama_process):
    global _restart_managed_llama_process
    _restart_managed_llama_process = restart_managed_llama_process


@router.get("/internal/ui-preferences")
async def get_ui_preferences(runtime_cfg: RuntimeConfig = Depends(get_runtime)) -> JSONResponse:
    return JSONResponse(status_code=200, content={"language": read_ui_language(runtime_cfg)})


@router.post("/internal/ui-preferences")
async def set_ui_preferences(
    request: Request,
    runtime_cfg: RuntimeConfig = Depends(get_runtime),
) -> JSONResponse:
    payload = await request.json()
    language = str(payload.get("language") or "")
    if not write_ui_language(runtime_cfg, language):
        return JSONResponse(status_code=400, content={"updated": False, "reason": "invalid_language"})
    return JSONResponse(status_code=200, content={"updated": True, "language": language})


@router.get("/internal/settings-document")
async def get_settings_document(runtime_cfg: RuntimeConfig = Depends(get_runtime)) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={
            "format": "yaml",
            "document": export_settings_document_yaml(runtime_cfg),
        },
    )


@router.post("/internal/settings/tune")
async def suggest_settings_tune_endpoint(
    request: Request,
    runtime_cfg: RuntimeConfig = Depends(get_runtime),
) -> JSONResponse:
    payload = await request.json()
    model_id = str(payload.get("model_id") or "").strip()
    if not model_id:
        return JSONResponse(status_code=400, content={"reason": "model_id_required"})
    state = ensure_models_state(runtime_cfg)
    model = get_model_by_id(state, model_id)
    if model is None:
        return JSONResponse(status_code=404, content={"reason": "model_not_found", "model_id": model_id})
    filename = str(model.get("filename") or "")
    chat = normalize_model_settings(model.get("settings"), filename=filename).get("chat", {})
    result = suggest_model_tune(chat, filename=filename)
    return JSONResponse(
        status_code=200,
        content={
            "model_id": model_id,
            "filename": filename,
            "preset": result["preset"],
            "changes": result["changes"],
            "settings": result["settings"],
        },
    )


@router.post("/internal/settings-document")
async def apply_settings_document_endpoint(
    request: Request,
    runtime_cfg: RuntimeConfig = Depends(get_runtime),
) -> JSONResponse:
    payload = await request.json()
    document = str(payload.get("document") or "")
    if not document.strip():
        return JSONResponse(status_code=400, content={"updated": False, "reason": "document_required"})
    updated, reason, settings_document = apply_settings_document_yaml(runtime_cfg, document)
    if not updated:
        return JSONResponse(status_code=400, content={"updated": False, "reason": reason, **settings_document})
    restarted, restart_reason = await _restart_managed_llama_process(request.app)
    return JSONResponse(
        status_code=200,
        content={
            "updated": True,
            "reason": reason,
            "active_model_id": settings_document.get("active_model_id"),
            "document": yaml.safe_dump(settings_document, sort_keys=False, allow_unicode=True),
            "restarted": restarted,
            "restart_reason": restart_reason,
        },
    )
