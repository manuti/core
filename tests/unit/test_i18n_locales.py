"""i18n locale coverage — guards translation completeness in CI.

en.json is the source of truth. Every shipped locale must define exactly the
same set of keys (no missing, no extra), and every ``data-i18n*`` key referenced
in the HTML must exist in en.json. A contributor adding a language just copies
en.json and translates the values; this test fails loudly if any key is missing.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_LOCALES_DIR = _ROOT / "core" / "assets" / "locales"
_HTML_FILES = [
    _ROOT / "core" / "assets" / "index.html",
    _ROOT / "apps" / "chat" / "assets" / "chat.html",
]

_DATA_I18N_RE = re.compile(r'data-i18n(?:-[a-z]+)?="([^"]+)"')
_VAR_RE = re.compile(r"\{(\w+)\}")


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _locale_files() -> list[Path]:
    return sorted(_LOCALES_DIR.glob("*.json"))


def test_en_is_present_and_nonempty():
    en = _load(_LOCALES_DIR / "en.json")
    assert en, "en.json (source of truth) must not be empty"


@pytest.mark.parametrize("locale_path", _locale_files(), ids=lambda p: p.stem)
def test_locale_matches_english_keyset(locale_path: Path):
    en = _load(_LOCALES_DIR / "en.json")
    locale = _load(locale_path)
    en_keys, loc_keys = set(en), set(locale)
    missing = sorted(en_keys - loc_keys)
    extra = sorted(loc_keys - en_keys)
    assert not missing, f"{locale_path.name} is missing keys: {missing}"
    assert not extra, f"{locale_path.name} has unknown keys not in en.json: {extra}"


@pytest.mark.parametrize("locale_path", _locale_files(), ids=lambda p: p.stem)
def test_locale_preserves_interpolation_vars(locale_path: Path):
    """Each translated value must keep the same {vars} as the English source."""
    en = _load(_LOCALES_DIR / "en.json")
    locale = _load(locale_path)
    mismatches = []
    for key, en_value in en.items():
        if key not in locale:
            continue
        if _VAR_RE.findall(en_value or "") and set(_VAR_RE.findall(en_value)) != set(
            _VAR_RE.findall(locale[key] or "")
        ):
            mismatches.append(key)
    assert not mismatches, (
        f"{locale_path.name} changed interpolation vars for keys: {mismatches}"
    )


def test_html_data_i18n_keys_exist_in_english():
    en = _load(_LOCALES_DIR / "en.json")
    used: set[str] = set()
    for html_path in _HTML_FILES:
        for match in _DATA_I18N_RE.finditer(html_path.read_text(encoding="utf-8")):
            used.add(match.group(1))
    missing = sorted(used - set(en))
    assert not missing, f"HTML references data-i18n keys absent from en.json: {missing}"
