"""Chat completions proxy route."""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from inferno import BackendProxyError, ChatRepositoryManager

try:
    from core.deps import get_runtime, get_chat_repository
    from core.model_state import apply_model_chat_defaults, ensure_models_state
    from core.runtime_state import RuntimeConfig
    from core.settings import merge_active_model_chat_defaults, merge_chat_defaults
except ModuleNotFoundError:
    from deps import get_runtime, get_chat_repository  # type: ignore[no-redef]
    from model_state import apply_model_chat_defaults, ensure_models_state  # type: ignore[no-redef]
    from runtime_state import RuntimeConfig  # type: ignore[no-redef]
    from settings import merge_active_model_chat_defaults, merge_chat_defaults  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/v1/models")
async def list_models(
    runtime_cfg: RuntimeConfig = Depends(get_runtime),
) -> JSONResponse:
    models_state = ensure_models_state(runtime_cfg)
    active_id = models_state.get("active_model_id")
    now = int(time.time())
    data = []
    for item in models_state.get("models", []):
        model_id = str(item.get("id") or "")
        filename = str(item.get("filename") or "")
        if not filename:
            continue
        # Only expose models that are downloaded and ready
        if item.get("status") not in (None, "ready", "downloaded"):
            continue
        entry_id = "local" if model_id == active_id else filename
        data.append({
            "id": entry_id,
            "object": "model",
            "created": now,
            "owned_by": "potato-os",
        })
    # Always include a "local" alias pointing to the active model
    if not any(m["id"] == "local" for m in data):
        data.insert(0, {"id": "local", "object": "model", "created": now, "owned_by": "potato-os"})
    return JSONResponse({"object": "list", "data": data})


@router.post("/v1/chat/completions")
async def chat_completions(
    request: Request,
    runtime_cfg: RuntimeConfig = Depends(get_runtime),
    chat_repository: ChatRepositoryManager = Depends(get_chat_repository),
) -> Response:
    lock = request.app.state.inference_lock

    # Read the request body BEFORE taking the inference lock / queue slot. The
    # body read is the one step an attacker (or a flaky link) can stall
    # arbitrarily — trickling bytes or sending a large image payload slowly.
    # Holding the single inference lock across it would let a few slow clients
    # fill the queue while no inference is running. Parsing here keeps the lock
    # scoped to actual inference.
    try:
        payload = await request.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="invalid_json") from exc
    except Exception as exc:
        if type(exc).__name__ == "ClientDisconnect":
            return Response(status_code=499)
        raise

    # Bounded queue: allow a small number of requests to wait their turn on the
    # lock instead of rejecting them outright.  `inference_queue_depth` counts
    # the in-flight request plus everyone waiting on the lock; once it reaches
    # `inference_max_queue` we shed load with a 429.  All reads/writes of the
    # counter happen without an intervening await, so no scheduling window lets
    # a request slip past the capacity check (single-threaded event loop).
    max_queue = getattr(request.app.state, "inference_max_queue", 3)
    current_depth = getattr(request.app.state, "inference_queue_depth", 0)
    if current_depth >= max_queue:
        return JSONResponse(
            status_code=429,
            content={
                "error": {
                    "message": "Inference queue is full. Try again shortly.",
                    "type": "concurrent_request",
                    "code": 429,
                }
            },
        )

    request.app.state.inference_queue_depth = current_depth + 1
    depth_released = False

    def _release_slot():
        nonlocal depth_released
        if not depth_released:
            depth_released = True
            request.app.state.inference_queue_depth = max(
                0, getattr(request.app.state, "inference_queue_depth", 1) - 1
            )

    try:
        # Queue behind any in-flight completion.  asyncio.Lock preserves FIFO
        # order, so waiters are served in arrival order.
        await lock.acquire()
    except BaseException:
        _release_slot()
        raise

    released = False
    try:
        _get_status_download_context = request.app.state.get_status_download_context
        _build_status = request.app.state.build_status

        # Build status AFTER acquiring the lock: a queued request may have
        # waited through a long stream, so readiness is re-checked at inference
        # time rather than at arrival.
        download_active, auto_start_remaining = await _get_status_download_context(request.app, runtime_cfg)
        status_payload = await _build_status(
            runtime_cfg,
            app=request.app,
            download_active=download_active,
            auto_start_remaining_seconds=auto_start_remaining,
            system_snapshot=request.app.state.system_metrics_snapshot,
        )
        if status_payload["state"] != "READY":
            return JSONResponse(status_code=503, content=status_payload)

        payload = merge_active_model_chat_defaults(payload, runtime=runtime_cfg)
        payload = merge_chat_defaults(payload)
        payload = apply_model_chat_defaults(
            payload,
            active_model_filename=str(status_payload.get("model", {}).get("filename") or ""),
        )
        headers = request.app.state.forward_headers(request)
        active_backend = status_payload["backend"]["active"]

        try:
            backend_response = await chat_repository.create_chat_completion(
                backend=active_backend,
                payload=payload,
                forward_headers=headers,
            )
        except BackendProxyError as exc:
            # Only fabricate a fake response when the fake backend is explicitly
            # enabled — mirror _resolve_backend_active, which requires
            # allow_fake_fallback for the auto→fake transition. Otherwise a
            # mid-request llama crash would silently return a canned answer
            # while /status still reports backend.active="llama".
            if (
                runtime_cfg.chat_backend_mode == "auto"
                and active_backend == "llama"
                and runtime_cfg.allow_fake_fallback
            ):
                backend_response = await chat_repository.create_chat_completion(
                    backend="fake",
                    payload=payload,
                    forward_headers=headers,
                )
            else:
                logger.exception("Backend proxy error")
                raise HTTPException(status_code=502, detail=f"backend unavailable: {exc}") from exc

        if backend_response.stream is not None:
            original = backend_response.stream

            async def _guarded_stream():
                try:
                    async for chunk in original:
                        yield chunk
                finally:
                    lock.release()
                    _release_slot()

            released = True
            return StreamingResponse(
                _guarded_stream(),
                status_code=backend_response.status_code,
                headers=backend_response.headers,
                background=backend_response.background,
            )

        return Response(
            content=backend_response.body or b"",
            status_code=backend_response.status_code,
            headers=backend_response.headers,
        )
    finally:
        if not released:
            lock.release()
            _release_slot()
