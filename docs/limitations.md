# Known limitations and unsupported cases

This is a research and portfolio prototype. It is **not** validated for production use and does not replace the official Immich upgrade instructions.

## Scope
- **Immich only, families F1–F6 only** (environment variables, service architecture, direct-upgrade floor, intermediate migration, PostgreSQL/VectorChord, pgvecto.rs removal). Changes outside these families are not checked: API, mobile app, hardware/CPU requirements, admin settings, data migrations. `NOT_APPLICABLE` is never a safety verdict.
- **Reviewed release notes cover `v1.102.0` … `v3.4.0-rc.3` only.** Newer versions, including the real `v3.4.0`, are `UNSUPPORTED_VERSION` until their notes are reviewed. The version registries are a snapshot from 2026-11-10.
- **Only the Compose-visible part of a change is checked.** No rule exists where the only evidence was a pull-request title, for example `LOG_LEVEL` in v1.106 and the v1.118 "worker env" change. `IMMICH_HELMET_FILE` is out of scope.

## Inputs the tool does not model (they make affected checks `UNKNOWN`)
- `extends`, `include:`, override files (`compose.override.yaml` …) and multiple compose files are not merged. Under an unmerged `extends`, only local `environment:` values count as certain.
- Services under `profiles:`, and server services with `links`, `external_links`, `network_mode` or `extra_hosts`.
- Any `entrypoint:`, and shell-wrapped, unresolved or unparsable commands. These make service identity unknown for the checks that depend on it.
- Services without an image (build-only). Dockerfiles are not inspected.
- Variables taken from the shell environment (`environment: [VAR]` without a value). The tool never reads `process.env`.

## Things it never verifies
- **The real database state**: installed extensions, data. The database is never contacted. External, ambiguous or custom database images give `UNKNOWN`.
- **Docker image availability.** Recognising a release or tag does not mean an image exists. The two documented VectorChord image tags in `db_images` come from the pinned upgrading docs (E08); their availability on GHCR was not checked.
- **Runtime behaviour** of Immich after the upgrade.
- **Whether the cited sources still say the same.** Release notes and docs are editable; see the revisions in [EVIDENCE.md](../EVIDENCE.md).

## Known conservative or partial behaviour
- **Possibly redundant `UNKNOWN`s.** A rename inside a shared env file that other Immich services also read is reported as conditional (`reaches_other_service`), even when the value happens to equal the other service's default. The pinned sources do not document the defaults of the legacy variables, so they are not compared.
- **Possibly redundant `UNKNOWN` for an `entrypoint:`.** Any `entrypoint:` makes service identity uncertain, even one that restates the image default.
- **`HOST` on the machine-learning service** and legacy port variables outside their owning service are not reported. The sources do not say those containers read them.
- **The microservices worker inside `immich-server` (v1.106+).** Whether it reads a port is undocumented, so `MICROSERVICES_PORT` on the API server is not reported.
- **Repeated `IMMICH_HOST` lines.** Two legacy variables with equal values renamed into one shared file would produce two identical `IMMICH_HOST` lines if applied literally. This is harmless, but the instruction text does not deduplicate them.
- **The schema check is narrow.** It covers only the Compose fields the tool reads, not the full Compose Specification.
- **No tests exercise a genuine `INTERNAL_ERROR`.** That path is a catch-all.

## Verification limits
- **Accuracy.** The 41 development cases, their answer keys, the rules and the regression tests were all written by the same author. 41/41 on that set says nothing about real-world accuracy. An earlier independently authored blind evaluation informed v0.2; its cases have since been exposed and are not used as evidence.
- **Platform coverage.** The test suite has been run on Node.js 24 only: locally on Windows, and in GitHub Actions on Ubuntu and Windows (Node.js 24.22.2, all 179 tests passed on both). Node.js 20 and 22 are declared in `package.json` but untested, and macOS has not been tested. Locally, one test (a file symlink check) is skipped without elevated rights; it passed on both CI runners.
