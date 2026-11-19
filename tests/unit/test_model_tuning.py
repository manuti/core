from __future__ import annotations

from core.model_tuning import TUNE_KEYS, classify_model_preset, suggest_model_tune

DEFAULT_CHAT = {
    "temperature": 0.7,
    "top_p": 0.8,
    "top_k": 20,
    "repetition_penalty": 1.0,
    "presence_penalty": 1.5,
    "max_tokens": 16384,
    "stream": True,
    "generation_mode": "random",
    "seed": 42,
    "system_prompt": "Be helpful.",
    "cache_prompt": True,
}


def test_classify_model_preset_from_filename():
    assert classify_model_preset("Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf") == "code"
    assert classify_model_preset("Qwen3-4B-Thinking.gguf") == "reasoning"
    assert classify_model_preset("deepseek-r1-distill.gguf") == "reasoning"
    assert classify_model_preset("gemma-4-12b-it-UD-Q2_K_XL.gguf") == "instruct"
    assert classify_model_preset("") == "instruct"


def test_instruct_defaults_report_no_changes():
    result = suggest_model_tune(dict(DEFAULT_CHAT), filename="gemma-4-12b-it.gguf")

    assert result["preset"] == "instruct"
    assert result["changes"] == []
    assert result["settings"] == DEFAULT_CHAT


def test_coder_preset_changes_sampling_and_keeps_other_keys():
    result = suggest_model_tune(dict(DEFAULT_CHAT), filename="Qwen2.5-Coder-7B.gguf")

    assert result["preset"] == "code"
    changed = {change["key"]: (change["from"], change["to"]) for change in result["changes"]}
    assert changed == {
        "temperature": (0.7, 0.2),
        "top_p": (0.8, 0.95),
        "repetition_penalty": (1.0, 1.05),
        "presence_penalty": (1.5, 1.0),
    }
    # top_k already matches the preset target, so it is not reported.
    assert "top_k" not in changed
    assert set(TUNE_KEYS).issuperset(changed)

    tuned = result["settings"]
    assert tuned["temperature"] == 0.2
    for key in ("max_tokens", "system_prompt", "seed", "generation_mode", "stream", "cache_prompt"):
        assert tuned[key] == DEFAULT_CHAT[key]
