from __future__ import annotations

import subprocess
import sys
from pathlib import Path

_WRAPPER = Path(__file__).parent.parent.parent / "bin" / "potato-web-shell"
_DENY = "Not allowed. Try in a SSH session instead of web terminal."


def _run(script: str) -> str:
    result = subprocess.run(
        [sys.executable, str(_WRAPPER)],
        input=script,
        capture_output=True,
        text=True,
        timeout=15,
    )
    return result.stdout + result.stderr


def test_allowed_command_runs():
    out = _run("echo potato-canary\nexit\n")
    assert "potato-canary" in out


def test_forbidden_command_is_denied():
    out = _run("rm -rf /tmp/whatever\nexit\n")
    assert _DENY in out


def test_privilege_commands_denied():
    for cmd in ("sudo bash", "su", "bash", "ssh user@host", "less /etc/hosts"):
        out = _run(f"{cmd}\nexit\n")
        assert _DENY in out, f"{cmd!r} should be denied"


def test_no_shell_injection_via_metacharacters(tmp_path):
    # A metacharacter payload must not spawn a second command. The canary file
    # must survive: `echo ... ; rm <canary>` is parsed as argv, so 'rm' is just
    # a literal argument to echo, never executed.
    canary = tmp_path / "canary.txt"
    canary.write_text("alive", encoding="utf-8")
    out = _run(f"echo hi ; rm -f {canary}\nexit\n")
    assert canary.exists(), "injection deleted the canary — metachars were interpreted"
    # 'echo' still ran with the literal args.
    assert "hi" in out


def test_deny_message_is_exact():
    # The message the product spec requires, verbatim.
    text = _WRAPPER.read_text(encoding="utf-8")
    assert 'DENY_MESSAGE = "Not allowed. Try in a SSH session instead of web terminal."' in text


def test_allowlist_excludes_dangerous_commands():
    text = _WRAPPER.read_text(encoding="utf-8")
    # Pull the ALLOWED list literal and check escape-capable commands are absent.
    for banned in ("less", "more", "man", "vi", "vim", "nano", "find", "awk",
                   "sed", "xargs", "sudo", "su", "bash", "sh", "python", "perl"):
        assert f'"{banned}"' not in text, f"{banned} must not be allowlisted"
