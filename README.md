# Compose Upgrade Risk Inspector (for Immich)

An offline, read-only command-line tool that reads an [Immich](https://immich.app) Docker Compose project and reports which documented changes an upgrade from one Immich version to another **requires**, **recommends**, or **cannot decide** from the given files. Every finding cites the official source it is based on.

> **Status: research / portfolio prototype, v0.2.2 pre-release.**
> - Independent project. **Not affiliated with or endorsed by Immich.**
> - **Offline and read-only.** It does not run upgrades, does not modify Docker or Compose files, and does not talk to Docker, a database, the network or an LLM.
> - It **does not replace the official Immich upgrade instructions** and release notes. Read them, and back up before upgrading.
> - It **does not guarantee** safety, compatibility or completeness. It covers six documented risk families and nothing else.
> - It **does not verify** your database's real state or whether any Docker image is available.
> - It has **not been validated for production use.**

## Contents

1. [What it is](#what-it-is)
2. [The problem it addresses](#the-problem-it-addresses)
3. [What it analyzes](#what-it-analyzes)
4. [Key features](#key-features)
5. [Quick start](#quick-start)
6. [Three runnable examples](#three-runnable-examples)
7. [Sample terminal and JSON reports](#sample-terminal-and-json-reports)
8. [Supported version policy](#supported-version-policy)
9. [How findings and UNKNOWN work](#how-findings-and-unknown-work)
10. [Testing and verification](#testing-and-verification)
11. [Known limitations](#known-limitations)
12. [AI-assisted development and independent review](#ai-assisted-development-and-independent-review)
13. [Evidence and attribution](#evidence-and-attribution)
14. [License and non-affiliation](#license-and-non-affiliation)

## What it is

A Node.js CLI (`bin/cri.mjs`) with one runtime dependency (`yaml`, pinned in `package-lock.json`). You point it at the directory that holds your `compose.yaml` / `docker-compose.yml` and its env files, and give it the version you run now (`--current`) and the version you want (`--target`). It prints a terminal report, or the same data as JSON with `--json`.

## The problem it addresses

Immich moves fast, and some releases need manual changes to the Compose setup:
- renamed or removed environment variables;
- removed containers and start commands;
- required intermediate versions;
- the move from pgvecto.rs to VectorChord.

These steps are spread across many release notes, docs pages and a migration guide, and whether they apply depends on your files. This tool collects the documented, Compose-visible steps for a version range into one cited report. It is careful to say when the files are not enough to decide.

## What it analyzes

Six risk families, from Immich **v1.102.0 to v3.4.0-rc.3**, implemented as **23 rules + 2 path constraints** (`node bin/cri.mjs lint` prints the current counts):

| Family | Examples of what is checked |
|---|---|
| F1 Environment variables | v1.106 port/host renames (per service), v1.119 `HOST` → `IMMICH_HOST` and removed metrics variables, v1.136 relative `IMMICH_MEDIA_LOCATION`, variables removed in v3, 2.x deprecations |
| F2 Service architecture | v1.118 removal of `start.sh` commands and the `immich-microservices` container, server port alignment |
| F3 Direct-upgrade floor | targets ≥ v1.133.0 need a running version ≥ v1.107.2 |
| F4 Intermediate migration | targets ≥ v1.137.0 need a successful start on v1.132–v1.136 first; v1.136.0 caveats |
| F5 PostgreSQL / VectorChord | v3 has no supported vector extension in the old pgvecto.rs image; 2.x advisories to switch |
| F6 pgvecto.rs removal | v3 rejects `DB_VECTOR_EXTENSION=pgvecto.rs`; legacy `vectors.so` command overrides |

It reads `compose.yaml` / `docker-compose.yml`, the project `.env` (for interpolation), `env_file:` entries and `environment:` blocks, including the Compose interpolation forms `$V`, `${V}`, `${V:-d}`, `${V-d}`, `${V:?e}` and `${V:+r}`. It does not read Dockerfiles, shell environment variables, files outside the project directory, or anything over the network.

## Key features

- **Three-valued logic.** A check that the files cannot decide is `UNKNOWN`, never quietly "not applicable".
- **Cited findings.** Each finding carries the evidence IDs, URLs and revisions it is based on ([EVIDENCE.md](EVIDENCE.md)).
- **Structured remediation.** Instructions are generated from validated, structured rule data (`op`, `subjects`, `replacements`), never from free text in the rules.
- **Service-aware.** Images are matched by exact repository, and the database is found the way Immich finds it (`DB_URL`, else `DB_HOSTNAME`, default `database`). Legacy variables are checked only on the service that reads them.
- **Safe renames.** A rename that would give one service two values, overwrite a different existing value, or reach another service through a shared env file becomes a collision or a verify-first instruction.
- **No secrets in output.** Variable values, interpolated values, image tags and `DB_URL` are never printed, and error messages do not repeat user input.
- **Upgrade path planner.** It reports mandatory and advisory intermediate stops.
- **Stable JSON output** (`schema: 3`) and documented exit codes.

## Quick start

Requirements: Node.js. The package declares `>=20`, but the test suite has only been run on Node.js 24.

```bash
npm ci
```
```bash
node bin/cri.mjs analyze examples/02-intermediate-upgrade-stop --current v1.131.3 --target v1.137.0
```
```bash
node bin/cri.mjs analyze examples/02-intermediate-upgrade-stop --current v1.131.3 --target v1.137.0 --json
```
```bash
npm test
```

Against your own setup: `node bin/cri.mjs analyze <compose-dir> --current vX.Y.Z --target vX.Y.Z [--json]`. If you omit `--current`, every version-dependent check becomes `UNKNOWN`.

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | The analysis completed. Read the `Result` line and the labels. |
| `2` | `INPUT_ERROR`, `SCHEMA_ERROR`, `RULE_ERROR` or `RULE_CONFLICT`: bad YAML, a malformed version, a downgrade, a wrong Compose field type, an invalid or unreadable rules file. |
| `3` | `UNSUPPORTED_VERSION`: a well-formed version outside the version policy below. |
| `1` | `INTERNAL_ERROR`: an unexpected failure. No result is produced and no stack trace is printed. |

## Three runnable examples

All three are synthetic projects with placeholder values. Each folder holds the inputs, the exact commands, the actual saved terminal and JSON outputs, and a short explanation. `test/examples.test.mjs` re-runs them and checks the saved outputs byte for byte.

| Example | Upgrade | What it shows |
|---|---|---|
| [01-env-variable-migration](examples/01-env-variable-migration/) | v1.118.2 → v1.119.0 | `ACTION_REQUIRED`: `Rename HOST to IMMICH_HOST.` and the removed metrics variables (E03) |
| [02-intermediate-upgrade-stop](examples/02-intermediate-upgrade-stop/) | v1.131.3 → v1.137.0 | `INTERMEDIATE_REQUIRED`: stop at v1.132.3 first (E06, E07), plus an `ADVISORY` VectorChord image step |
| [03-external-database-unknown](examples/03-external-database-unknown/) | v2.7.5 → v3.0.0 | `UNKNOWN`: an external database cannot be checked for the v3 pgvecto.rs removal; the report says why |

## Sample terminal and JSON reports

Terminal output of example 1 (full file: [report.txt](examples/01-env-variable-migration/report.txt)):

```text
Compose Upgrade Risk Inspector  (offline, read-only; no files are changed)
Upgrade : v1.118.2 -> v1.119.0
Result  : ACTION_REQUIRED
          At least one supported rule requires a change or an intermediate upgrade before this upgrade.
Read    : docker-compose.yml, .env
Note    : no immich-machine-learning service in this compose; ML variables were not checked
Note    : database service: database (host 'database' from DB_HOSTNAME default)
Path    : NO_KNOWN_STOP: v1.118.2 -> v1.119.0

F1 Environment variables....... ACTION_REQUIRED
   !! [ACTION_REQUIRED] F1-119-host-renamed
      action : Rename HOST to IMMICH_HOST.
      config : request = v1.118.2 -> v1.119.0 crosses v1.119.0
      config : immich-server.environment.HOST = (set)  (.env:8)
      source : E03 <https://github.com/immich-app/immich/releases/tag/v1.119.0> (tag v1.119.0)
   !! [ACTION_REQUIRED] F1-119-metrics-removed
      ...
F2 Service architecture........ NOT_APPLICABLE
...
```

One finding from the JSON report of the same run (full file: [report.json](examples/01-env-variable-migration/report.json)):

```json
{
  "rule_id": "F1-119-host-renamed",
  "family": "F1",
  "label": "ACTION_REQUIRED",
  "action_key": "env.rename:HOST",
  "remediation": { "op": "rename_env", "subjects": ["HOST"], "replacements": ["IMMICH_HOST"] },
  "action": "Rename HOST to IMMICH_HOST.",
  "evidence": [{ "id": "E03", "url": "https://github.com/immich-app/immich/releases/tag/v1.119.0", "revision": "tag v1.119.0" }],
  "config": [
    { "field": "request", "value": "v1.118.2 -> v1.119.0 crosses v1.119.0" },
    { "service": "immich-server", "field": "environment.HOST", "value": "(set)", "source": ".env:8" }
  ],
  "missing_inputs": []
}
```

**JSON report fields:** `tool`, `schema`, `request`, `inputs`, `assessment`, `coverage`, `upgrade_path` and `families` (F1–F6, each with `label` and `findings`), plus `summary`. `schema: 3` is the version of the output format; it is independent of the package version.

On an error, nothing is analyzed. With `--json`, stdout carries only the error envelope and stderr stays empty:

```json
{"tool": "compose-upgrade-risk-inspector", "schema": 3, "error": {"category": "UNSUPPORTED_VERSION", "message": "current version is newer than v3.4.0-rc.3, the newest version whose release notes were reviewed; no rules cover it", "field": "--current"}}
```

`field` is present only when an input can be named: `--current`, `--target`, `--rules`, `<compose-dir>` or a Compose field path. Error messages name the category and the field, but never repeat the value you supplied.

## Supported version policy

Both `--current` and `--target` must:
1. **Be well-formed.** That means SemVer 2.0 `vMAJOR.MINOR.PATCH`, with an optional prerelease such as `-rc.3`. Otherwise the result is `INPUT_ERROR`.
2. **Be official.** The version must be an official Immich GitHub release ([data/immich-release-tags.txt](data/immich-release-tags.txt)) or an official git tag ([data/immich-git-tags.txt](data/immich-git-tags.txt)). Both lists were fetched 2026-11-10.
3. **Lie in the reviewed range** `v1.102.0` … `v3.4.0-rc.3`.

Anything else is `UNSUPPORTED_VERSION` (exit 3). That includes real releases newer than the reviewed range, such as `v3.4.0`, whose release notes were not reviewed. A tag without a GitHub release entry (e.g. `v1.125.0`) is analyzed, and the report notes it. A downgrade is an `INPUT_ERROR`.

Recognising a version as an official release or tag **does not establish that a Docker image for it is available**. Image availability (for example on GHCR) was not verified.

## How findings and UNKNOWN work

| Label (per finding and per family) | Meaning |
|---|---|
| `ACTION_REQUIRED` | An official source makes the change mandatory for this target, and the trigger is visible in your files. |
| `ADVISORY` | An official source recommends the change (deprecation, upgrade-path safety), but it is not mandatory yet. |
| `UNKNOWN` | The inputs cannot decide the question: a missing file, an unresolved variable, an unknown running version, an external database, an override file. Or the source itself leaves the condition open. **It is not a pass.** The finding lists what is missing. |
| `NOT_APPLICABLE` | With complete inputs, no supported rule of that family matched. **It is not a safety verdict.** |

- **Family label:** the highest label among its findings, in the order `ACTION_REQUIRED > UNKNOWN > ADVISORY > NOT_APPLICABLE`. Every finding is listed, so overlapping rules never hide each other.
- **`assessment.status`:** `ACTION_REQUIRED > UNKNOWN > ADVISORY > NO_KNOWN_RISK_IN_COVERED_RULES`. There is deliberately no `OK` or `SAFE` value.
- **`upgrade_path.status`:** `INTERMEDIATE_REQUIRED > UNKNOWN > ADVISORY > NO_KNOWN_STOP`.
- **An `UNKNOWN` finding's action is always conditional**, in the form "Cannot decide without the missing inputs. If it applies: …" or "Verify before renaming …".

**Renamed variables are guarded.** A rename writes the new variable where the old one is defined. Before a rename is emitted, the tool checks every Immich service that the write would reach. A shared env file reaches every service that lists it; a service's own `environment:` reaches only that service. If one service would get two different values for the new variable, or an existing different value would be overwritten, the finding becomes a `resolve_env_conflict` instruction with a `conflicts` list. No winning value is chosen. If a value cannot be read, or a shared file would also change another service's default, the finding becomes `UNKNOWN` and asks you to verify first. See [docs/architecture.md](docs/architecture.md).

## Testing and verification

```bash
npm test
```
```bash
node bin/cri.mjs lint
```
```bash
npm run -s validate
```
```bash
npm run score -- --evidence <output-dir>
```

| Kind | What it is | Status |
|---|---|---|
| Regression and unit tests | `node --test`: unit, negative, isolation, per-rule golden checks, security/output-boundary tests, post-review regressions, example reproduction | Run locally on Windows with Node.js 24; see [docs/testing.md](docs/testing.md) for the exact counts and the one platform skip |
| Development set | 41 synthetic cases with hand-written answer keys, scored on the full report | 41/41, written by the same author as the rules. **Not a real-world accuracy measure.** |
| Mutation testing | `npm run mutate` injects one defect at a time into a temp copy and runs the suite | See [docs/testing.md](docs/testing.md) for which runs were full and which targeted |
| Independent AI code review | Several review rounds with Codex | See below |
| CI | [.github/workflows/ci.yml](.github/workflows/ci.yml): Ubuntu and Windows, Node.js 24 | Prepared; **not yet run on GitHub Actions** |
| Production validation | — | **Not performed** |

## Known limitations

The short version:
- Only Immich, only families F1–F6, only the Compose-visible part of each change.
- `extends`, `include:`, override files and multiple compose files are not merged; they make the affected checks `UNKNOWN`.
- The database is never contacted, so its real extension state is unknown.
- A custom `entrypoint:` or shell-wrapped command makes service identity `UNKNOWN`.
- Versions newer than v3.4.0-rc.3 are rejected.

Full list: [docs/limitations.md](docs/limitations.md).

## AI-assisted development and independent review

This project was built with AI-assisted engineering tools, in two separate roles:
- **Development:** the implementation, tests and documents were written with **Claude Code** (Anthropic), directed by the project owner.
- **Independent review:** several rounds of code and behaviour review were done with **Codex** (OpenAI), kept separate from development. Each review finding was first reproduced as a failing test, then fixed.

This is not an external certification, not a human security audit, and not a production approval. No customer deployments exist. Details: [docs/development-process.md](docs/development-process.md).

## Evidence and attribution

[EVIDENCE.md](EVIDENCE.md) lists every source (E01–E25) with URL and revision, and maps each rule to the sources it cites. The sources are Immich release notes, documentation, the official v3 migration blog post and source code. They belong to their authors and are **not** covered by this project's license. This repository contains no copies of them, only links, revision identifiers and short attributed quotations.

## License and non-affiliation

The original code and documentation of this project are released under the [MIT License](LICENSE). Third-party material (Immich documentation and release notes referenced in [EVIDENCE.md](EVIDENCE.md), and the `yaml` dependency under its own ISC license) is not covered by it.

"Immich" is the name of an independent open-source project. This project is **not affiliated with, endorsed by or supported by** Immich or its maintainers. Changes are summarised in [CHANGELOG.md](CHANGELOG.md).
