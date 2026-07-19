#!/usr/bin/env python3
"""i18n locale helper for Potato OS.

Scaffold a new language file or report translation coverage against the
English source of truth (core/assets/locales/en.json).

Usage:
    # Create fr-style scaffolding for a new language (values seeded from English):
    python scripts/i18n_locale.py new de

    # Show a coverage report for every shipped locale (missing / extra keys):
    python scripts/i18n_locale.py report

The coverage report is also enforced in CI by
tests/unit/test_i18n_locales.py — this script is the friendly, human-facing
companion for contributors.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_LOCALES = _ROOT / "core" / "assets" / "locales"
_EN = _LOCALES / "en.json"


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _dump(path: Path, data: dict, order: list[str]) -> None:
    lines = ["{"]
    for i, key in enumerate(order):
        comma = "," if i < len(order) - 1 else ""
        lines.append(f"  {json.dumps(key, ensure_ascii=False)}: "
                     f"{json.dumps(data[key], ensure_ascii=False)}{comma}")
    lines.append("}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def cmd_new(code: str) -> int:
    en = _load(_EN)
    target = _LOCALES / f"{code}.json"
    if target.exists():
        print(f"! {target.name} already exists — use 'report' to see gaps, "
              f"or edit it directly.")
        return 1
    _dump(target, dict(en), list(en.keys()))
    print(f"✓ Wrote {target.relative_to(_ROOT)} with {len(en)} keys "
          f"(values seeded from English).")
    print("Next steps:")
    print(f"  1. Translate the values in {target.name} (keep every {{var}} "
          f"and leave brand/technical tokens as-is).")
    print(f"  2. Add \"{code}\" to SUPPORTED and its native name to LANG_NAMES "
          f"in core/assets/i18n.js.")
    print("  3. Run:  python scripts/i18n_locale.py report")
    return 0


def cmd_report() -> int:
    en = _load(_EN)
    en_keys = set(en)
    var_re = __import__("re").compile(r"\{(\w+)\}")
    any_gap = False
    for path in sorted(_LOCALES.glob("*.json")):
        if path.name == "en.json":
            continue
        loc = _load(path)
        loc_keys = set(loc)
        missing = sorted(en_keys - loc_keys)
        extra = sorted(loc_keys - en_keys)
        var_bad = [
            k for k, v in en.items()
            if k in loc and var_re.findall(v or "")
            and set(var_re.findall(v)) != set(var_re.findall(loc[k] or ""))
        ]
        done = len(en_keys & loc_keys) - len(var_bad)
        pct = round(100 * done / len(en_keys)) if en_keys else 100
        status = "✓" if not (missing or extra or var_bad) else "•"
        print(f"{status} {path.stem}: {pct}% complete "
              f"({len(missing)} missing, {len(extra)} extra, "
              f"{len(var_bad)} var-mismatch)")
        if missing:
            any_gap = True
            print(f"    missing: {', '.join(missing[:12])}"
                  f"{' …' if len(missing) > 12 else ''}")
        if extra:
            any_gap = True
            print(f"    unknown: {', '.join(extra[:12])}"
                  f"{' …' if len(extra) > 12 else ''}")
        if var_bad:
            any_gap = True
            print(f"    var-mismatch: {', '.join(var_bad[:12])}"
                  f"{' …' if len(var_bad) > 12 else ''}")
    return 1 if any_gap else 0


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "new" and len(argv) == 3:
        return cmd_new(argv[2])
    if len(argv) == 2 and argv[1] == "report":
        return cmd_report()
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
