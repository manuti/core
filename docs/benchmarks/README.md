# Benchmarks

Performance measurements for Potato OS across models, quantizations, runtimes
(ik_llama vs upstream llama.cpp), and Raspberry Pi hardware.

Numbers here come from **real hardware runs** — this index defines the common
schema and how to capture results reproducibly, so every report is comparable.

## Reports

| Date | Focus | Report |
|------|-------|--------|
| 2026-04-04 | Gemma 4 (E2B / E4B / 26B-A4B) on Pi 4/5 | [gemma4-pi-benchmark-2026-04-04.md](gemma4-pi-benchmark-2026-04-04.md) |

_Add a row when you publish a new report._

## Standard results schema

Keep result tables comparable by using these columns (drop any you didn't
measure, don't rename the rest):

| Model | Quant | Runtime | Gen t/s | Prompt t/s (T1 → T2+) | pp512 t/s | tg128 t/s | Power W | Temp °C | Throttle | Swap | Notes |
|-------|-------|---------|---------|-----------------------|-----------|-----------|---------|---------|----------|------|-------|

- **Runtime**: `ik_llama` or `llama_cpp`, with the build commit in the hardware table.
- **Gen t/s**: decode tokens/sec in a real chat turn (not micro-bench).
- **pp512 / tg128**: `llama-bench` prompt-processing (512) and text-generation (128).
- **Power W**: `adjusted_total_watts` from `/status` (PMIC on Pi 5; estimated on Pi 4).
- **Throttle**: whether `throttling.any_current` fired during the run.

Always include a **Hardware** table (board, RAM, storage, runtime build) and a
**Methodology** section — see the Gemma 4 report for the template.

## Capturing results

### Quick snapshot — `potatoctl bench`

On the Pi (or against `POTATO_URL`), run one timed generation and get a
ready-to-paste row:

```bash
potatoctl bench                       # default prompt, 128 tokens
potatoctl bench "Summarize X." 256    # custom prompt / token budget
```

It reads device, runtime, power, temperature and throttle state from `/status`,
times a non-streaming completion for decode tok/s, and prints a Markdown row.

### Rigorous — `llama-bench`

For `pp512` / `tg128`, run `llama-bench` directly against the model on the
device (1+ repetitions, no concurrent workload). See the Gemma 4 report for the
exact invocation and multi-turn chat protocol.

## Notes

- Run with no other workloads active; note SD vs SSD and any zram/swap.
- Record the runtime build commits — ik_llama vs llama.cpp differences are the
  whole point of comparing.
- Related: idle CPU-governor behaviour is tracked in #13 (power at idle).
