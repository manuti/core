"use strict";

// Attach a same-origin CSRF header to every request so state-changing
// /internal/* calls satisfy the server's CsrfHeaderMiddleware. A cross-site
// page cannot add a custom header without a CORS preflight the app never
// answers, so this proves the request is same-origin. Installed once, as early
// as possible, by importing this module first.
(function installCsrfFetch() {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  if (window.__potatoCsrfFetchInstalled) return;
  window.__potatoCsrfFetchInstalled = true;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input, init) => {
    let sameOrigin = true;
    try {
      const raw = typeof input === "string" ? input : (input && input.url) || "";
      sameOrigin = new URL(raw, window.location.href).origin === window.location.origin;
    } catch (_err) {
      sameOrigin = true; // relative URLs resolve same-origin
    }
    if (!sameOrigin) return nativeFetch(input, init);

    const opts = init ? { ...init } : {};
    const headers = new Headers(
      (init && init.headers) || (typeof input !== "string" && input && input.headers) || {}
    );
    if (!headers.has("x-potato-csrf")) headers.set("x-potato-csrf", "1");
    opts.headers = headers;
    return nativeFetch(input, opts);
  };
})();
