# Example 1: documented environment-variable migration (v1.118.2 → v1.119.0)

A synthetic Immich setup running v1.118.2. Its shared `.env` (read by `immich-server`) still sets `HOST` and the metrics variables `IMMICH_METRICS` / `IMMICH_HOST_METRICS`. There is no machine-learning service in this example. All values are placeholders.

```bash
node bin/cri.mjs analyze examples/01-env-variable-migration --current v1.118.2 --target v1.119.0
node bin/cri.mjs analyze examples/01-env-variable-migration --current v1.118.2 --target v1.119.0 --json
```

Saved outputs: [report.txt](report.txt) (terminal) and [report.json](report.json) (JSON). `test/examples.test.mjs` re-runs both commands and compares the output byte for byte.

## What the report says

- **Result `ACTION_REQUIRED`**, family F1. The path status is `NO_KNOWN_STOP`: no supported rule requires an intermediate version for this hop.
- **`F1-119-host-renamed`:** `Rename HOST to IMMICH_HOST.` The v1.119.0 release notes (E03) say the server's host-binding variable was erroneously named `HOST` and is now `IMMICH_HOST`. The rename is unconditional here: only `immich-server` reads this `.env`, and no `IMMICH_HOST` is set anywhere. If another Immich service read the same file, or an existing `IMMICH_HOST` differed or could not be checked, the tool would make the instruction conditional or report a collision instead.
- **`F1-119-metrics-removed`:** `Remove IMMICH_METRICS, … and configure IMMICH_TELEMETRY_INCLUDE and IMMICH_TELEMETRY_EXCLUDE instead.` v1.119.0 removed these variables (E03).
- **Config references** point at the exact lines (`.env:8`, `.env:9`, `.env:10`), but values are never printed (`(set)`).
- **The other families are `NOT_APPLICABLE`.** With complete inputs, none of their supported rules matched. This is **not** a statement that the upgrade is safe.
