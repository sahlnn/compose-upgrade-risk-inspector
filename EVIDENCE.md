# Evidence: Immich Compose upgrade risks

Every rule in [rules/immich.rules.yaml](rules/immich.rules.yaml) cites one or more of the sources below, by ID. The machine-readable registry is [rules/evidence.yaml](rules/evidence.yaml); a test keeps the IDs, URLs and revisions of that registry in sync with the table in section 1.

- **Collected:** 2026-11-09 (version registries: 2026-11-10).
- **Scope:** only official channels of the `immich-app` organisation (GitHub releases and discussions, repository documentation, the official blog, source code).
- Release and discussion bodies were read through the GitHub API; documentation files were read at a pinned commit.
- Short quotations below are attributed excerpts of the cited sources. This project is not affiliated with or endorsed by Immich.

**Snapshots.** During development, the author kept local verbatim copies of the editable sources (release notes, documentation pages, the v3 migration blog post) with SHA-256 hashes. Those copies are third-party material and are **not included** in this repository. Their hashes are listed in [docs/source-snapshots-sha256.txt](docs/source-snapshots-sha256.txt) for reference only; they cannot be re-verified from this repository. The live sources may have changed since the revisions given here.

## 1. Source registry

| ID | Source | Version / revision | Published / commit date | Can it change? |
|----|--------|--------------------|-------------------------|----------------|
| E01 | [Release v1.106.1](https://github.com/immich-app/immich/releases/tag/v1.106.1) · [discussion #10110](https://github.com/immich-app/immich/discussions/10110) | tag `v1.106.1` | 2024-06-11 | Yes, release text is editable |
| E02 | [Release v1.118.0](https://github.com/immich-app/immich/releases/tag/v1.118.0) · [#13459](https://github.com/immich-app/immich/discussions/13459) | tag `v1.118.0` | 2024-10-15 | Yes, editable |
| E03 | [Release v1.119.0](https://github.com/immich-app/immich/releases/tag/v1.119.0) | tag `v1.119.0` | 2024-10-28 | Yes, editable. No discussion labelled `breaking-change` exists for it |
| E04 | [Release v1.133.0](https://github.com/immich-app/immich/releases/tag/v1.133.0) · [#18429](https://github.com/immich-app/immich/discussions/18429) | tag `v1.133.0` | 2025-05-21 | Yes, editable |
| E05 | [Release v1.136.0](https://github.com/immich-app/immich/releases/tag/v1.136.0) · [#20133](https://github.com/immich-app/immich/discussions/20133) | tag `v1.136.0` | 2025-07-24 | Yes, editable |
| E06 | [Release v1.137.0](https://github.com/immich-app/immich/releases/tag/v1.137.0) · [#20481](https://github.com/immich-app/immich/discussions/20481) | tag `v1.137.0` | 2025-07-31 | Yes, editable |
| E07 | [docs.immich.app/errors#typeorm-upgrade](https://docs.immich.app/errors#typeorm-upgrade) (repo: `docs/src/pages/errors.md`) | read at main `87ef8950`; file last changed in `8ef4e4d452` (2026-02-12); TypeORM text from `880f2bc2c5` (2025-09-16) | — | **Yes, live documentation** |
| E08 | [docs.immich.app/install/upgrading](https://docs.immich.app/install/upgrading#migrating-to-vectorchord) (repo: `docs/docs/install/upgrading.md`) | main `87ef8950`; last changed in `6f45521610` (2026-07-06) | — | **Yes, live documentation** |
| E09 | [docs.immich.app/install/environment-variables](https://docs.immich.app/install/environment-variables) | main `87ef8950` | — | **Yes, live documentation** |
| E10 | [Release v3.0.0](https://github.com/immich-app/immich/releases/tag/v3.0.0) · [#29439](https://github.com/immich-app/immich/discussions/29439) | tag `v3.0.0` → commit `05d838b5` | 2026-07-02 | Yes, editable |
| E11 | [immich.app/blog/v3-migration](https://immich.app/blog/v3-migration) (repo: `immich-app/static-pages`) | static-pages main `5801b598` (2026-11-05) | Post dated 2026-07-01 | **Yes**, the post invites corrections |
| E12 | [PR #28159](https://github.com/immich-app/immich/pull/28159) drop pgvecto.rs support | merge `97c62136` | 2026-04-30 | PR description editable; merge commit fixed |
| E13 | [PR #27802](https://github.com/immich-app/immich/pull/27802) remove deprecated env variables | merge `41d2d84b` | 2026-04-15 | Same as E12 |
| E14 | [PR #28326](https://github.com/immich-app/immich/pull/28326) chore(ml)!: remove deprecated envs | merge `8c8dc9d3` | 2026-05-09 | Same as E12 |
| E15 | [PR #22185](https://github.com/immich-app/immich/pull/22185) availability checks (released in v1.143.0) | — | 2025-09-19 | Same as E12 |
| E16 | [`docker/docker-compose.yml`, `docker/example.env`](https://github.com/immich-app/immich/tree/main/docker) | main `87ef8950` | — | **Yes.** The file itself warns that the compose file on main may not match the latest release |
| E17 | [Release v2.0.0](https://github.com/immich-app/immich/releases/tag/v2.0.0) · [#22552](https://github.com/immich-app/immich/discussions/22552) | tag `v2.0.0` | 2025-10-01 | Yes, editable |
| E18 | [Discussions labelled `changelog:breaking-change`](https://github.com/immich-app/immich/discussions?discussions_q=label%3Achangelog%3Abreaking-change) | 31 results (2026-11-09) | — | Yes, labels are applied by hand |
| E19 | [Release v1.102.0](https://github.com/immich-app/immich/releases/tag/v1.102.0) | tag `v1.102.0` | 2024-04-19 | Yes, editable |
| E20 | [Release v2.7.0](https://github.com/immich-app/immich/releases/tag/v2.7.0) | tag `v2.7.0` | 2026-04-07 | Yes, editable |
| E21 | Source code: [`server/src/dtos/env.dto.ts`](https://github.com/immich-app/immich/blob/v3.0.0/server/src/dtos/env.dto.ts) @ `v3.0.0` and @ `v2.7.5` (`95e57a24`); `server/src/config.ts` @ `v2.7.5`/`v3.0.0`; `server/src/repositories/config.repository.ts` @ `v3.0.0` | tags | — | Tags treated as fixed |
| E22 | Source code: [`server/src/services/database.service.ts`](https://github.com/immich-app/immich/blob/v2.7.5/server/src/services/database.service.ts), `deprecatedExtension` warning: "DEPRECATION WARNING: The pgvecto.rs extension is deprecated and support for it will be removed very soon … switch to the VectorChord extension instead" | present @ `v2.0.0` and @ `v2.7.5`; **absent** @ `v1.133.0` | — | Tags fixed |
| E23 | Source code: [`machine-learning/immich_ml/main.py`](https://github.com/immich-app/immich/blob/v2.7.5/machine-learning/immich_ml/main.py), "Deprecated env variable: 'MACHINE_LEARNING_PRELOAD__CLIP'. Use … __TEXTUAL and … __VISUAL instead" (the same for FACIAL_RECOGNITION) | present @ `v2.0.0`, `v2.6.3`, `v2.7.5`; removed in v3.0.0 (E14) | — | Tags fixed |
| E24 | [Release v1.132.0](https://github.com/immich-app/immich/releases/tag/v1.132.0): Valkey image, "This is not a required change. If you wish to use it…" | tag `v1.132.0` | 2025-04-23 | Yes, editable (**rejected** as an ADVISORY candidate) |
| E25 | [Release v3.3.0](https://github.com/immich-app/immich/releases/tag/v3.3.0): `MACHINE_LEARNING_MODEL_REVISION=v2` opt-in, "This setting will be the default in a later release" | tag `v3.3.0` | 2026-10-07 | Yes, editable (**rejected** as an ADVISORY candidate) |

Sources that were read but produced no rule: v1.117.0 (only the JSON config file structure changed, not Compose) and v1.104, v1.105, v1.113, v1.122, v1.125.1, v1.127, v1.132, v1.138 (their breaking-change lists concern the API).

## 2. Rules and the sources they cite

Generated from `rules/immich.rules.yaml`: 23 rules and 2 upgrade-path constraints. The summary column is the rule's internal description; the instruction a report prints is generated from the rule's structured `remediation`, never from this text.

| Rule / constraint | Family | Label when it fires | Evidence | Summary |
|---|---|---|---|---|
| `F3-floor-1.107.2` | F3 | ACTION_REQUIRED (path stop `v1.107.2`) | E04 | Immich >= 1.133.0 only supports upgrading directly from 1.107.2 or later. |
| `F4-typeorm-boot` | F4 | ACTION_REQUIRED (path stop `v1.132.3`) | E06, E07 | Immich >= 1.137.0 requires one successful start on 1.132.0-1.136.0 (TypeORM removal). |
| `F1-106-port-host-renamed` | F1 | ACTION_REQUIRED | E01 | SERVER_PORT (API server) was renamed to IMMICH_PORT. Each legacy port/host variable is a separate rule, scoped to the service that reads it. |
| `F1-106-microservices-port-renamed` | F1 | ACTION_REQUIRED | E01, E02 | MICROSERVICES_PORT was renamed to IMMICH_PORT in v1.106 (separate microservices container). |
| `F1-106-ml-port-renamed` | F1 | ACTION_REQUIRED | E01 | MACHINE_LEARNING_PORT was renamed to IMMICH_PORT in v1.106 (machine-learning container). |
| `F1-106-ml-host-renamed` | F1 | ACTION_REQUIRED | E01 | MACHINE_LEARNING_HOST was renamed to IMMICH_HOST in v1.106 (machine-learning container). |
| `F1-106-host-transition` | F1 | ADVISORY | E01, E03 | v1.106 documents HOST -> IMMICH_HOST, but until the v1.119.0 fix the server still read HOST. |
| `F1-119-host-renamed` | F1 | ACTION_REQUIRED | E03 | The erroneous HOST variable is no longer read; IMMICH_HOST is the binding variable. |
| `F1-119-metrics-removed` | F1 | ACTION_REQUIRED | E03 | IMMICH_METRICS, IMMICH_API_METRICS, IMMICH_HOST_METRICS, IMMICH_IO_METRICS and IMMICH_JOB_METRICS were removed. |
| `F1-136-media-location-relative` | F1 | ACTION_REQUIRED | E05 | A relative IMMICH_MEDIA_LOCATION must become an absolute path (unset or absolute is unaffected). |
| `F1-300-ping-timeout-removed` | F1 | ACTION_REQUIRED | E11, E13, E21 | IMMICH_MACHINE_LEARNING_PING_TIMEOUT was removed in v3. |
| `F1-300-preload-clip-removed` | F1 | ACTION_REQUIRED | E11, E14 | MACHINE_LEARNING_PRELOAD__CLIP is no longer translated in v3. |
| `F1-300-preload-face-removed` | F1 | ACTION_REQUIRED | E11, E14 | MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION is no longer translated in v3. |
| `F1-2x-preload-clip-deprecated` | F1 | ADVISORY | E23, E11 | The ML service logs a deprecation warning for MACHINE_LEARNING_PRELOAD__CLIP; v3 removes it. |
| `F1-2x-preload-face-deprecated` | F1 | ADVISORY | E23, E11 | The ML service logs a deprecation warning for MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION; v3 removes it. |
| `F2-118-start-sh-removed` | F2 | ACTION_REQUIRED | E02 | `start.sh immich` / `start.sh microservices` commands were removed. |
| `F2-118-microservices-removed` | F2 | ACTION_REQUIRED | E02, E01 | The separate immich-microservices container is no longer supported. |
| `F2-118-port-alignment` | F2 | ACTION_REQUIRED | E02, E09 | immich-server now listens on 2283 inside the container by default (was 3001); IMMICH_PORT sets the listening port. |
| `F4-136-bug-from-old` | F4 | UNKNOWN | E07 | v1.136.0 has a bug blocking upgrades from v1.131.0 or earlier 'in some installations'; affected installations are not defined. |
| `F4-136-avoid-from-old` | F4 | ADVISORY | E07 | Official docs: avoid v1.136.0 if upgrading from v1.131.0 (or earlier). |
| `F5-300-no-supported-extension` | F5 | ACTION_REQUIRED | E10, E12, E08 | v3 refuses to start without a supported vector extension; the tensorchord/pgvecto-rs image only has pgvecto.rs. |
| `F5-2x-switch-image` | F5 | ADVISORY | E04, E22, E08 | pgvecto.rs still works before v3 but is deprecated; official text says to switch to VectorChord. |
| `F5-2x-explicit-pgvectors` | F5 | ADVISORY | E22, E08, E21 | DB_VECTOR_EXTENSION=pgvecto.rs keeps the database on deprecated pgvecto.rs. |
| `F6-300-env-pgvectors-rejected` | F6 | ACTION_REQUIRED | E11, E12, E21 | v3 only accepts DB_VECTOR_EXTENSION values pgvector or vectorchord; pgvecto.rs throws an error. |
| `F6-300-legacy-vectors-command` | F6 | UNKNOWN | E04, E08 | The VectorChord image is combined with the pre-1.133 `command` override (vectors.so). Official docs remove it but do not state the effect of keeping it. |

A rule that cannot be decided from the given inputs is reported as `UNKNOWN`, whatever its kind.
