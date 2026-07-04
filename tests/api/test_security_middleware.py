from __future__ import annotations

import pytest

from core.security import host_is_public, is_host_allowed, url_download_allowed


# --- is_host_allowed (pure) -------------------------------------------------

@pytest.mark.parametrize(
    "host",
    [
        "potato.local",
        "potato.local:1983",
        "potato-a3f.local",
        "localhost",
        "localhost:8080",
        "127.0.0.1",
        "192.168.1.42",
        "10.0.0.5",
        "172.16.4.9",
        "169.254.10.10",
        "[::1]",
    ],
)
def test_is_host_allowed_accepts_trusted(host):
    assert is_host_allowed(host) is True


@pytest.mark.parametrize(
    "host",
    [
        "",
        "evil.com",
        "attacker.example",
        "8.8.8.8",            # public IP, not configured
        "potato.local.evil.com",
        "notlocal",
    ],
)
def test_is_host_allowed_rejects_untrusted(host):
    assert is_host_allowed(host) is False


def test_is_host_allowed_honors_extra_hosts():
    assert is_host_allowed("my-pi.example.com", extra_hosts=frozenset({"my-pi.example.com"})) is True


# --- HostGuardMiddleware (integration) --------------------------------------

def test_request_with_rebound_host_is_rejected(client):
    # A DNS-rebinding request carries the attacker's domain as Host.
    resp = client.get("/status", headers={"host": "evil.com"})
    assert resp.status_code == 400


def test_request_with_trusted_host_passes(client):
    resp = client.get("/status", headers={"host": "potato.local"})
    assert resp.status_code == 200


# --- CsrfHeaderMiddleware (integration) -------------------------------------

def test_internal_post_with_cross_origin_and_no_csrf_header_is_rejected(client):
    # Simulates a drive-by cross-site POST: Origin present, no custom header.
    resp = client.post(
        "/internal/models/purge",
        headers={"origin": "http://evil.com", "host": "potato.local"},
        json={},
    )
    assert resp.status_code == 403


def test_internal_post_with_origin_and_csrf_header_passes_guard(client):
    # Our own UI sends Origin + the custom header; must get past the CSRF guard
    # (status may then be a normal 4xx/2xx from the route, just not our 403).
    resp = client.post(
        "/internal/models/purge",
        headers={
            "origin": "http://potato.local",
            "host": "potato.local",
            "x-potato-csrf": "1",
        },
        json={},
    )
    assert resp.status_code != 403


def test_internal_post_without_origin_is_exempt(client):
    # Non-browser client (no Origin) — e.g. curl/CLI/tests — is not a CSRF
    # vector and must not be blocked by the header requirement.
    resp = client.post("/internal/models/purge", json={})
    assert resp.status_code != 403


def test_internal_get_is_not_csrf_protected(client):
    resp = client.get("/internal/llama-healthz", headers={"origin": "http://evil.com"})
    # Safe method — CSRF guard does not apply (may 200/404, never 403 from us).
    assert resp.status_code != 403


# --- SSRF guard (model URLs) ------------------------------------------------

@pytest.mark.parametrize(
    "host,expected",
    [
        ("8.8.8.8", True),
        ("1.1.1.1", True),
        ("127.0.0.1", False),
        ("10.0.0.1", False),
        ("192.168.1.1", False),
        ("172.16.0.1", False),
        ("169.254.169.254", False),  # cloud metadata / link-local
        ("::1", False),
        ("", False),
    ],
)
def test_host_is_public(host, expected):
    assert host_is_public(host) is expected


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://8.8.8.8/model.gguf", True),
        ("https://192.168.0.5/model.gguf", False),   # private
        ("https://169.254.169.254/x.gguf", False),   # metadata
        ("http://8.8.8.8/model.gguf", False),        # not https
        ("file:///etc/passwd", False),
        ("https://127.0.0.1/model.gguf", False),
    ],
)
def test_url_download_allowed(url, expected):
    assert url_download_allowed(url) is expected


def test_url_download_allowed_resolves_dns(monkeypatch):
    import socket as _socket

    # A hostname that resolves to a private address must be rejected.
    def _fake_getaddrinfo(host, *a, **k):
        return [(_socket.AF_INET, _socket.SOCK_STREAM, 6, "", ("192.168.4.4", 0))]

    monkeypatch.setattr("core.security.socket.getaddrinfo", _fake_getaddrinfo)
    assert url_download_allowed("https://sneaky.example.com/x.gguf") is False


def test_register_rejects_private_host_url(client):
    resp = client.post(
        "/internal/models/register",
        json={"source_url": "https://192.168.0.5/model.gguf"},
    )
    assert resp.status_code == 400
    assert resp.json().get("reason") == "url_not_allowed"
