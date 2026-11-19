"""Quality presets for per-model chat sampling settings.

Pure functions: no I/O, no persistence, no runtime dependency. The caller
supplies already-normalized chat settings (see ``normalize_model_settings``)
and receives the preset's target values plus the list of differences.
"""

from __future__ import annotations

from typing import Any

# Keys the tuner owns; everything else (system_prompt, max_tokens, stream,
# generation_mode, seed, cache_prompt, vision) is left untouched.
TUNE_KEYS = ("temperature", "top_p", "top_k", "repetition_penalty", "presence_penalty")

TUNE_PRESETS: dict[str, dict[str, float | int]] = {
    # Code models: deterministic sampling, no loops.
    "code": {
        "temperature": 0.2,
        "top_p": 0.95,
        "top_k": 20,
        "repetition_penalty": 1.05,
        "presence_penalty": 1.0,
    },
    # Reasoning / thinking models.
    "reasoning": {
        "temperature": 0.6,
        "top_p": 0.95,
        "top_k": 20,
        "repetition_penalty": 1.0,
        "presence_penalty": 1.0,
    },
    # Everything else: matches DEFAULT_MODEL_CHAT_SETTINGS.
    "instruct": {
        "temperature": 0.7,
        "top_p": 0.8,
        "top_k": 20,
        "repetition_penalty": 1.0,
        "presence_penalty": 1.5,
    },
}


def classify_model_preset(filename: str) -> str:
    """Pick a preset from the model filename. Filename-only, no GGUF parsing."""
    name = (filename or "").lower()
    if "code" in name:
        return "code"
    if "thinking" in name or "-r1" in name or "reasoning" in name:
        return "reasoning"
    return "instruct"


def suggest_model_tune(chat_settings: dict[str, Any], *, filename: str) -> dict[str, Any]:
    """Return the preset, the changed keys, and the full tuned chat settings."""
    preset = classify_model_preset(filename)
    tuned = dict(chat_settings)
    changes: list[dict[str, Any]] = []
    for key in TUNE_KEYS:
        target = TUNE_PRESETS[preset][key]
        current = tuned.get(key)
        if current != target:
            changes.append({"key": key, "from": current, "to": target})
            tuned[key] = target
    return {"preset": preset, "changes": changes, "settings": tuned}
