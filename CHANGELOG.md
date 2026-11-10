# Changelog

All notable changes. Versions before 0.2.2 were **internal engineering iterations** and were never published. The JSON output format has its own version (`schema`), which is independent of the package version.

## [0.2.2] - 2026-11-10 - first public pre-release (research / portfolio)

Packaging for publication:
- MIT license for the project's own code and documentation. Third-party sources are referenced, not included.
- English README, [EVIDENCE.md](EVIDENCE.md) and documentation under `docs/`.
- Three runnable synthetic examples with saved terminal and JSON outputs, checked by `test/examples.test.mjs`.
- `.gitignore`, `.gitattributes` (LF line endings) and a CI workflow for Ubuntu and Windows on Node.js 24 (prepared, not yet run).

Engineering changes since 0.2.1:
- **Unchecked destinations.** A rename whose existing destination cannot be checked (for example because an env file is missing) is no longer emitted unconditionally. It becomes `UNKNOWN` with a "Verify before renaming …" instruction (`existing_value_unchecked`).
- **Shared env files.** A rename inside a shared env file that would also change another Immich service's default is conditional too (`reaches_other_service`).
- **Port ownership.** Legacy port variables follow the service that read them: `SERVER_PORT` on the API server, `MICROSERVICES_PORT` on the separate `start.sh microservices` container (targets below v1.118.0), `MACHINE_LEARNING_PORT` on machine learning. There are two new rules, 23 in total.
- **Custom entrypoints.** Any `entrypoint:` now makes service identity `UNKNOWN` instead of being read as the API server.
- **Rules file errors.** A missing, non-regular or unreadable `--rules` file is `INPUT_ERROR` (exit 2, `field: --rules`) instead of `INTERNAL_ERROR`.

## [0.2.1] - 2026-11-10 - internal

- **Rename collision guard.** It prevents two different values for one destination (`IMMICH_HOST`, `IMMICH_PORT`) and never silently overwrites an existing different value. `MACHINE_LEARNING_HOST` is renamed only on the machine-learning service, and `HOST` only on the server.
- **Narrow schema checks** for long-form `ports`, `volumes` and the `env_file` mapping fields.
- **Error handling.** YAML alias errors and invalid options return the structured JSON error when `--json` is given. Unexpected failures become `INTERNAL_ERROR` (exit 1) without a stack trace.
- **No echo of user input.** Error messages no longer repeat versions, commands, options, paths, YAML text or `env_file.format` values.
- **Strict SemVer 2.0 prerelease grammar**, so `v1.125.0-..` is `INPUT_ERROR`.

## [0.2.0] - 2026-11-10 - internal

- **Result semantics.** `assessment.status` (`ACTION_REQUIRED > UNKNOWN > ADVISORY > NO_KNOWN_RISK_IN_COVERED_RULES`), a `coverage` section, and `upgrade_path.status` (`INTERMEDIATE_REQUIRED > UNKNOWN > ADVISORY > NO_KNOWN_STOP`). JSON `schema: 3`.
- **Narrow Compose schema check** (`SCHEMA_ERROR`) and error categories with exit codes.
- **Version policy.** Official releases and git tags in `v1.102.0` … `v3.4.0-rc.3`; otherwise `UNSUPPORTED_VERSION` (exit 3).
- **HOST transition advisory** for v1.106 – v1.118.
- **Documented VectorChord image table**, so a PostgreSQL 16 setup is never offered a PostgreSQL 14 image.

## [0.1.x] - 2026-11-09 - internal (Phase 1 – 1.3.2)

- **First rule engine.** Six risk families, three-valued evaluation, cited evidence registry, 41 synthetic development cases scored on the full report, and mutation testing.
- **Audit hardening:**
  - database resolution like Immich, and exact image-repository matching;
  - real-path containment of input files;
  - structured remediation instead of free-text actions;
  - validated evidence IDs, URLs and revisions;
  - no secrets or rule prose in reports.
