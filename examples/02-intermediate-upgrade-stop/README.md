# Example 2: required intermediate upgrade stop (v1.131.3 → v1.137.0)

A synthetic Immich setup running v1.131.3 with the then-default `tensorchord/pgvecto-rs` database image. The goal is to jump directly to v1.137.0. All values are placeholders.

```bash
node bin/cri.mjs analyze examples/02-intermediate-upgrade-stop --current v1.131.3 --target v1.137.0
node bin/cri.mjs analyze examples/02-intermediate-upgrade-stop --current v1.131.3 --target v1.137.0 --json
```

Saved outputs: [report.txt](report.txt) and [report.json](report.json), both checked by `test/examples.test.mjs`.

## What the report says

- **Path `INTERMEDIATE_REQUIRED: v1.131.3 -> v1.132.3 [F4-typeorm-boot] -> v1.137.0`.** The direct upgrade is never described as fine when a mandatory stop exists.
- **`F4-typeorm-boot` (`ACTION_REQUIRED`):** `Upgrade to v1.132.3 first and confirm Immich starts successfully.` The v1.137.0 release notes (E06) and the official error documentation (E07) require a successful start on a version from v1.132.0 through v1.136.0 before upgrading to v1.137.0 or later. v1.132.3 is the stop the rule recommends.
- **`F5-2x-switch-image` (`ADVISORY`):** a recommended, not yet mandatory, step. Before upgrading to v3.0.0, back up the database and move from `tensorchord/pgvecto-rs` to the VectorChord image documented for this PostgreSQL major and pgvecto.rs version (E04, E22, E08). The exact image tag comes from the documented `db_images` table, matched on both PostgreSQL 14 and pgvecto.rs 0.2.0, which are read from the image tag. The tool did not check whether that image is currently available.
- **Result `ACTION_REQUIRED`**, because the path needs a stop.
