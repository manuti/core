# Potato OS

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Experimental Raspberry Pi Linux mod with optimised local LLM inference. Runs quantised models on-device with a browser chat UI — no cloud, no GPU, just a Pi.

![Potato OS Raspberry Pi next to a real potato](docs/assets/potato_os_next_to_a_real_spud.jpg)

*Potato sold separately.*

**Supports Raspberry Pi 5 (8 GB / 16 GB) and Raspberry Pi 4 (8 GB).** Pi 5 is the recommended target (~8 tok/sec). Pi 4 works but expect roughly 1/4 of the speed.

## Qwen3-30B-A3B running on a Pi 5 (8 GB) with an SSD — slightly throttling.

<p align="center"><img src="docs/assets/demo-chat.gif" alt="Potato OS demo — Qwen3-30B running on Raspberry Pi 5" width="100%"></p>

**Runtime:** [ik_llama.cpp](https://github.com/ikawrakow/ik_llama.cpp) (IQK-optimised, Pi 5) + upstream [llama.cpp](https://github.com/ggerganov/llama.cpp) (Pi 4 / Pi 5) | **Default model:** Qwen3.5-2B (Pi 5), Qwen3.5-0.8B (Pi 4)

## Install (recommended)

1. Download the latest SD card image from [Releases](https://github.com/potato-os/core/releases)
2. Flash it to a microSD card with [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
3. Insert the card, power on the Pi, and wait for first boot to complete
4. Open `http://potato.local` in a browser

A starter model downloads automatically on first boot (~1.8 GB on Pi 5, ~0.5 GB on Pi 4). Chat is ready once the download finishes and the status shows CONNECTED.

See [Flashing Guide](docs/flashing.md) for detailed step-by-step instructions, including how to flash directly from Raspberry Pi Imager without a manual download.

### What you need

- Raspberry Pi 5 (8 GB or 16 GB) or Raspberry Pi 4 (8 GB)
- microSD card (16 GB minimum)
- Power supply (20W USB-C minimum, 27W recommended if using a USB SSD)
- Ethernet or Wi-Fi connection (for first-boot model download)

### Performance

| Device | Model | Speed | Notes |
|--------|-------|-------|-------|
| Pi 5 (8 GB) | [Qwen3-30B-A3B](https://huggingface.co/byteshape/Qwen3-30B-A3B-Instruct-2507-GGUF) Q3_K_S (2.66 bpw, ~10 GB) | **~8-9 tok/sec** | 30B MoE with SSD offload, ik_llama |
| Pi 5 (8 GB) | Qwen3.5-2B Q4_K_M | ~7.8 tok/sec | ik_llama runtime |
| Pi 4 (8 GB) | Qwen3.5-0.8B IQ4_NL | ~5 tok/sec | llama.cpp universal |
| Pi 4 (8 GB) | Qwen3-30B-A3B Q3_K_S | ~2 tok/sec | 30B on 8 GB RAM |

The standout: **30B-parameter Qwen3-30B-A3B** (mixture-of-experts, only 3B active) runs at full conversational speed on Pi 5 with a USB SSD. That's a frontier-class model on a $80 board.

## MVP status

Potato OS is an early release meant for testing and tinkering, not production use.

### What works

- Chat with streaming responses
- Vision — attach a photo and ask about it
- Multi-chat sessions (persisted in your browser)
- Model management — download by URL, upload, delete, switch active model, with on-disk size shown per model
- HuggingFace token support — download gated/private models with an `hf_*` token (stored in a 0600 file, never in logs or API responses)
- Concurrent request queuing — a bounded inference queue lets a few requests wait their turn instead of failing immediately; only requests beyond the limit get a 429 (configurable via `POTATO_INFERENCE_MAX_QUEUE`, default 3)
- System monitoring — CPU, GPU, temperature, memory (available, not just free), storage, power draw, with a live thermal-throttling warning during inference
- Dual inference runtime — ik_llama (Pi 5 default) and upstream llama.cpp (Pi 4 default, Pi 5 fallback)
- OpenAI-compatible API — `GET /v1/models` and `POST /v1/chat/completions`
- `potatoctl` management CLI — health check, logs, status, restart
- In-place OTA updates — check for and install new releases from the portal (**Check for update**), with a staged backup and automatic rollback on failure (see `docs/ota-releases.md`, `docs/recovery.md`)

Reflashing is still supported (and the surest way to reset a device), but it is no longer the only upgrade path.

## Deploying changes without reflashing

If you already have a Potato OS installation you can push updates over SSH:

```bash
# From the root of your local clone
# Create destination directories first, then sync
ssh <user>@potato.local "mkdir -p /tmp/potato_update/core /tmp/potato_update/bin /tmp/potato_update/apps"

rsync -av --no-group core/ <user>@potato.local:/tmp/potato_update/core/
rsync -av --no-group bin/  <user>@potato.local:/tmp/potato_update/bin/
rsync -av --no-group apps/ <user>@potato.local:/tmp/potato_update/apps/

# On the Pi (SSH in, or chain with &&)
sudo cp -r /tmp/potato_update/core/* /opt/potato/core/
sudo cp -r /tmp/potato_update/bin/*  /opt/potato/bin/
sudo cp -r /tmp/potato_update/apps/* /opt/potato/apps/
sudo chown -R potato:potato /opt/potato/
sudo systemctl restart potato
```

`potatoctl` is available on your PATH out of the box — the installer and image
symlink it into `/usr/local/bin`, so `potatoctl doctor` works from anywhere on
the Pi with no extra setup. (If you deployed an older build, you can still add
`/opt/potato/bin` to your PATH manually:
`echo 'export PATH="/opt/potato/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc`.)

## Recovery and rollback

Need to back out or recover from a failed setup? See [docs/recovery.md](docs/recovery.md) for the practical rollback paths for:

- restoring a previous Raspberry Pi OS or other system image
- reflashing to a newer Potato OS image

---

## Quick reference

### Dev commands

```bash
make dev        # start local dev server (no inference runtime needed)
make test       # run all tests (unit + UI)
make test-unit  # pytest only
make test-ui    # Playwright only
make image      # build SD card image
```

### potatoctl (on the Pi)

```bash
potatoctl doctor          # health check — service, API, model, version
potatoctl logs api        # stream service logs (also: llm, model, all)
potatoctl status          # full JSON status from the API
potatoctl restart         # restart the potato service
```

### API endpoints

```bash
GET  http://potato.local/v1/models            # list available models (OpenAI-compatible)
POST http://potato.local/v1/chat/completions  # chat completions (streaming supported)
GET  http://potato.local/status               # full system status
```

Beyond these, the portal drives a large `POST /internal/*` admin surface
(model download/upload/delete/purge, runtime switch/reset, settings, OTA
update) and a `GET /logs` stream, plus a **web terminal** at `WS /ws/terminal`
that opens a *restricted* diagnostic shell (a small command allowlist — use SSH
for a full shell).

> **Security note.** These endpoints have no user login: Potato OS assumes a
> trusted LAN, so anyone who can reach `potato.local` can manage models, restart
> the runtime, and read logs. It does defend the browser trust boundary — a
> `Host` allowlist blocks DNS-rebinding, `/internal/*` mutations require a
> same-origin header (CSRF), and the web terminal is a restricted shell rather
> than root — but it is **not** hardened against a malicious device already on
> your LAN. Don't expose the portal to untrusted networks or the internet. To
> reach it through a custom hostname or public address, set
> `POTATO_ALLOWED_HOSTS` (comma-separated) so the `Host` guard accepts it.

---

## Development

Everything below is for contributors and developers.

### Local dev

```bash
uv sync
POTATO_ENABLE_ORCHESTRATOR=0 uv run uvicorn core.main:app --host 0.0.0.0 --port 1983
```

Or with Make:

```bash
make dev
```

### Tests

```bash
uv run python -m pytest tests/unit tests/api -q -n auto
npx playwright test --reporter=dot --timeout=15000 --workers=75%
```

Or with Make:

```bash
make test
```

### Building llama runtimes

Runtimes are built on the Pi (aarch64, no cross-compilation). From your Mac:

```bash
# Build both ik_llama + llama_cpp from latest source on Pi, sync back
./bin/build_and_publish_remote.sh

# Build + publish to GitHub Releases
./bin/build_and_publish_remote.sh --publish

# Just one family
./bin/build_and_publish_remote.sh --family ik_llama
```

This SSHs to `potato.local` (default: `pi`/`raspberry`), clones latest source, builds, and syncs the binaries back. Use `--publish` to upload tarballs to GitHub Releases.

Or build directly on the Pi:

```bash
./bin/build_llama_runtime.sh --family both --fetch --clean
```

Published runtimes are available at [GitHub Releases](https://github.com/potato-os/core/releases). Fresh installs auto-download when no local build is present:

```bash
POTATO_LLAMA_RELEASE_AUTO=1 ./bin/install_dev.sh
```

### SD card images

Build a flashable Potato OS image from macOS:

```bash
./bin/build_local_image.sh --setup-docker
```

See [Building Images](docs/building-images.md) for prerequisites, variants, flashing, and publishing releases.

### Project

- Active board: [github.com/orgs/potato-os/projects/1](https://github.com/orgs/potato-os/projects/1)
- Defaults: hostname `potato`, SSH `pi`/`raspberry`

## License

Apache License 2.0. See [LICENSE](LICENSE) for details. Third-party component
attribution is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
