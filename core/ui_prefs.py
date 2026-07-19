"""UI preferences store (language, …).

A tiny JSON file under state/ for browser-independent UI settings — currently
just the chosen interface language, so the choice syncs across devices instead
of living only in each browser's localStorage. Kept separate from the model
settings document on purpose: this is presentation, not runtime config.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path

try:
    from core.runtime_state import RuntimeConfig
except ModuleNotFoundError:  # pragma: no cover - import shim for flat layout
    from runtime_state import RuntimeConfig  # type: ignore[no-redef]

# A conservative BCP-47-ish shape: "en", "es", "pt-PT". Not an allowlist —
# the frontend owns the supported set; this only rejects obvious garbage.
_LANG_RE = re.compile(r"^[a-z]{2,3}(-[A-Za-z]{2,4})?$")


def _ui_prefs_path(runtime: RuntimeConfig) -> Path:
    return runtime.base_dir / "state" / "ui_preferences.json"


def read_ui_language(runtime: RuntimeConfig) -> str | None:
    path = _ui_prefs_path(runtime)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    lang = str(data.get("language") or "")
    return lang if _LANG_RE.match(lang) else None


def write_ui_language(runtime: RuntimeConfig, lang: str) -> bool:
    lang = str(lang or "").strip()
    if not _LANG_RE.match(lang):
        return False
    path = _ui_prefs_path(runtime)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if not isinstance(data, dict):
            data = {}
    except (json.JSONDecodeError, OSError):
        data = {}
    data["language"] = lang
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data))
        os.replace(tmp_name, path)
    except OSError:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        return False
    return True
