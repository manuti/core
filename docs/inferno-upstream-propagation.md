# Runbook: propagate the LiteRT i18n error-code change to upstream inferno

**Status:** pending. `manuti/core` currently pins the inference package to a
fork (`manuti/inferno`) because the i18n error-code change landed there first.
The clean end state is to land the same change in the upstream
`potato-os/inferno` and re-point the pin back to upstream.

This runbook is self-contained: it fully specifies the change so it can be
reproduced directly in `potato-os/inferno` without diffing the fork.

---

## Background

The Potato OS UI is multilingual and localizes **stable backend error codes**
via an `errcode.*` namespace + `tReason(code)`. The only backend that still
returned English-only prose to the chat UI was the **LiteRT adapter** in the
`inferno` package (`inferno/litert_adapter.py`, `/v1/chat/completions`).

The fix — adding a machine-readable `code` to each error response — was made in
**`manuti/inferno` (PR #18, commit `840d51b6ee826c45b847b68d409be50a6aedab00`)**.
`manuti/core` already:
- consumes `body.error.code` in `apps/chat/assets/chat-engine.js::formatChatFailureMessage`;
- ships the matching `errcode.*` keys in all four locales;
- pins `potato-inferno` to that fork commit (`requirements.txt`).

## The change to propagate (upstream `potato-os/inferno`)

In `inferno/litert_adapter.py`, add a stable `"code"` field to each error
response object, **keeping `message` and `type` unchanged** (so generic OpenAI
clients still get human text). Do **not** change any `status_code`.

| HTTP | `message` (unchanged) | add `"code"` |
|------|-----------------------|--------------|
| 503  | `LiteRT engine not loaded` | `litert_engine_not_loaded` |
| 400  | `Invalid JSON` | `invalid_json` |
| 400  | `messages required` | `messages_required` |
| 400  | `Vision input is not supported by this model/runtime configuration` | `vision_not_supported` |
| 500  | `Inference failed` | `inference_failed` |

Example (before → after):

```python
# before (upstream @2785766)
content={"error": {"message": "Vision input is not supported by this model/runtime configuration", "type": "invalid_request_error"}}
# after
content={"error": {"message": "Vision input is not supported by this model/runtime configuration", "type": "invalid_request_error", "code": "vision_not_supported"}}
```

The dynamic `ValueError` branch (`{"message": str(ve)}`, 400) may stay without a
code — it's free text and the client passes it through. The health-path
`{"status": "error", "reason": "engine_not_loaded"}` already uses a code; leave
it.

### Two ways to land it upstream
- **Cherry-pick:** apply `manuti/inferno@840d51b`'s `litert_adapter.py` change
  onto a branch of `potato-os/inferno` and open a PR. (If the fork commit mixes
  in unrelated changes, cherry-pick only the litert_adapter error-code edits.)
- **Re-implement:** make the five one-line additions above directly.

### Tests to add upstream
One assertion per branch: `resp.json()["error"]["code"] == "<code>"` for each of
the five cases (engine not loaded, invalid JSON, missing messages, vision not
supported, inference failed).

## After it lands upstream: re-point the core pin

1. Get the new upstream commit SHA (merge commit on `potato-os/inferno`).
2. In `manuti/core`, edit `requirements.txt`:
   ```
   potato-inferno @ git+https://github.com/potato-os/inferno.git@<UPSTREAM_SHA>
   ```
3. Verify (in a core checkout):
   ```bash
   pip install --force-reinstall --no-deps \
     "potato-inferno @ git+https://github.com/potato-os/inferno.git@<UPSTREAM_SHA>"
   python -c "import core.main"                 # imports cleanly
   python -m pytest tests/api tests/unit -q     # only the known pre-existing fails
   ```
4. Commit the pin bump. No frontend/locale changes are needed — the codes and
   `errcode.*` keys already exist and match.

## Deploying the pin change to an existing Pi

A `requirements.txt` change is **not** picked up by an `rsync`-only update. On an
already-installed device, reinstall the package and restart:

```bash
sudo -u potato /opt/potato/venv/bin/pip install --force-reinstall --no-deps \
  "potato-inferno @ git+https://github.com/potato-os/inferno.git@<UPSTREAM_SHA>"
sudo systemctl restart potato
```

A fresh flash / re-run of the installer picks it up automatically (`pip install
-r requirements.txt`).

## Acceptance criteria

- `potato-os/inferno` `/v1/chat/completions` error responses include the five
  `code`s above (message/type preserved, status codes unchanged).
- `manuti/core` `requirements.txt` points back at `potato-os/inferno@<sha>`.
- `import core.main` works and api+unit tests pass with the upstream package.
- LiteRT errors render localized in the UI (they already do via the fork; this
  just moves the source to upstream).

## Cross-repo contract (for reference)

`code` values are snake_case, stable, never translated. Each maps to an
`errcode.<code>` key in `core/assets/locales/{en,es,fr,pt}.json`. Adding a *new*
code upstream requires adding its `errcode.<code>` key to those four files in
`manuti/core`. The five codes above already exist there.
