"""Network trust-boundary middleware for the Potato OS portal.

Potato OS is unauthenticated by design on a trusted LAN, but two browser-driven
attacks reach beyond that model and are worth closing:

* **DNS rebinding** — a malicious page rebinds its own domain to the Pi's IP,
  becoming same-origin and bypassing the terminal's Origin check. A strict
  ``Host`` allowlist defeats it: the browser always sends the *typed* domain as
  ``Host``, so a rebound ``Host: evil.com`` is rejected while ``potato.local``
  and direct-IP access still work.

* **Simple-request CSRF** — a cross-site ``fetch`` with a "simple" content type
  triggers no CORS preflight, so a drive-by page can POST to ``/internal/*``.
  Requiring a custom header on those mutations blocks it: the browser cannot set
  a custom header cross-origin without a preflight, which the app never answers.

Both middlewares are pure ASGI so they cover WebSocket upgrades (the terminal)
as well as HTTP.
"""

from __future__ import annotations

import ipaddress
import os

# mDNS names (potato.local, potato-a3f.local, …) always pass.
_ALLOWED_SUFFIXES = (".local",)
_ALLOWED_EXACT = {"localhost"}

# Header the browser must send on state-changing /internal/* requests. A
# cross-origin page cannot set this without a CORS preflight, which the app
# does not answer — so its presence proves the request is same-origin.
CSRF_HEADER = "x-potato-csrf"
CSRF_PROTECTED_PREFIX = "/internal/"
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def allowed_hosts_from_env() -> frozenset[str]:
    """Extra exact hostnames/IPs from ``POTATO_ALLOWED_HOSTS`` (comma-separated).

    Use this for a public hostname or a non-private IP the device is reached
    through (a tunnel, a custom DNS name). LAN/private access needs no config.
    """
    raw = os.environ.get("POTATO_ALLOWED_HOSTS", "")
    return frozenset(h.strip().lower() for h in raw.split(",") if h.strip())


def is_host_allowed(host_header: str, *, extra_hosts: frozenset[str] = frozenset()) -> bool:
    """Return True if the ``Host`` header is a trusted way to reach this device.

    Accepts localhost, ``*.local`` mDNS names, any loopback/private/link-local
    IP literal, and anything explicitly listed in ``extra_hosts``. Rejects
    everything else — notably an attacker-controlled domain used for DNS
    rebinding (a rebound ``Host`` carries that domain, not an IP literal).
    """
    if not host_header:
        return False
    # Strip the port and a trailing FQDN dot; lowercase for comparison.
    host = host_header.rsplit(":", 1)[0].strip().lower().rstrip(".")
    # An IPv6 literal in a Host header is bracketed and contains colons, so the
    # naive rsplit above would mangle it — detect and re-extract.
    if host_header.strip().startswith("["):
        host = host_header.strip().split("]", 1)[0].lstrip("[").lower()
    if not host:
        return False
    if host in _ALLOWED_EXACT or host in extra_hosts:
        return True
    if any(host.endswith(suffix) for suffix in _ALLOWED_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


def _host_from_scope(scope: dict) -> str:
    for key, value in scope.get("headers") or ():
        if key == b"host":
            return value.decode("latin-1")
    return ""


class HostGuardMiddleware:
    """Reject HTTP/WebSocket requests whose ``Host`` isn't trusted (anti-rebinding)."""

    def __init__(self, app) -> None:
        self.app = app
        self.extra_hosts = allowed_hosts_from_env()

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] in ("http", "websocket"):
            host = _host_from_scope(scope)
            if not is_host_allowed(host, extra_hosts=self.extra_hosts):
                await self._reject(scope, send)
                return
        await self.app(scope, receive, send)

    async def _reject(self, scope, send) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4403})
            return
        body = b"Invalid or untrusted Host header"
        await send(
            {
                "type": "http.response.start",
                "status": 400,
                "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


class CsrfHeaderMiddleware:
    """Require a custom header on state-changing ``/internal/*`` HTTP requests."""

    def __init__(self, app) -> None:
        self.app = app
        self._header = CSRF_HEADER.encode("latin-1")

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http":
            method = scope.get("method", "")
            path = scope.get("path", "")
            # Enforce only when the request carries an Origin header. Browsers
            # always send Origin on cross-origin requests (and JS cannot remove
            # it), so a same-origin page proves itself with Origin + our header,
            # a cross-origin attacker can't set the header and is rejected, and
            # non-browser clients (curl, potatoctl, tests) send no Origin and
            # are correctly exempt — they were never a CSRF vector.
            if (
                path.startswith(CSRF_PROTECTED_PREFIX)
                and method not in _SAFE_METHODS
                and self._has_key(scope, b"origin")
                and not self._has_key(scope, self._header)
            ):
                await self._reject(send)
                return
        await self.app(scope, receive, send)

    @staticmethod
    def _has_key(scope, wanted: bytes) -> bool:
        return any(key == wanted for key, _ in scope.get("headers") or ())

    async def _reject(self, send) -> None:
        body = b'{"error":"missing CSRF header","code":403}'
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
