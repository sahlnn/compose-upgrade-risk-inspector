# Architecture

The tool is a small Node.js program (ES modules, Node.js ≥ 20 declared, tested on 24) with one runtime dependency, `yaml@2.9.1`. The engine is called as `analyze({ dir, current, target })`. It reads only the given directory and never touches Docker, a database, the network, shell environment variables or an LLM.

## Modules

| Path | Role |
|---|---|
| `bin/cri.mjs` | CLI: option parsing, `analyze` / `lint`, output selection (terminal or `--json`), error envelope and exit codes |
| `src/version.mjs` | SemVer 2.0 parsing and precedence; loads the version registries |
| `src/compose.mjs` | Loads the Compose project, see below |
| `src/rules.mjs` | Loads and lints the rule file and evidence registry; validates remediations; renders instructions from structured remediation |
| `src/engine.mjs` | Version policy, service roles, database resolution, three-valued rule evaluation, env-destination guard, upgrade-path planner, result semantics |
| `src/report.mjs` | Terminal rendering of the same report object that `--json` prints |
| `rules/immich.rules.yaml` | 23 rules + 2 path constraints, data only, plus the documented `db_images` table |
| `rules/evidence.yaml` | Machine-readable evidence registry; IDs, URLs and revisions must match [EVIDENCE.md](../EVIDENCE.md) |
| `data/immich-release-tags.txt`, `data/immich-git-tags.txt` | Official release and git-tag lists (fetched 2026-11-09 / 2026-11-10) |

### What `src/compose.mjs` loads
- `compose.yaml` / `docker-compose.yml`.
- The project `.env`, used for interpolation only.
- `env_file:` entries, including `format: raw`, and `environment:` blocks.
- Interpolation: `$$`, `$V`, `${V}`, `${V:-d}`, `${V-d}`, `${V:?e}`, `${V:+r}`.

It records uncertainty per service field: override files, unmerged `extends`, missing or unparsable env files, and unresolved fragments. It reads only files whose real path (links and junctions resolved) is inside the input directory. It also runs a narrow type check of the Compose fields it consumes (`SCHEMA_ERROR` names the field, never the value).

## Evaluation

1. **Version policy.**
   - A malformed version is `INPUT_ERROR`.
   - A well-formed version that is not an official release or git tag, or that lies outside `v1.102.0` … `v3.4.0-rc.3`, is `UNSUPPORTED_VERSION`.
   - A downgrade is `INPUT_ERROR`.
2. **Service roles.** These come from the exact normalised image repository (`ghcr.io/immich-app/immich-server`, `…/immich-machine-learning`), never from a substring. A service with an unresolved image or only a `build:` has an unknown role; any check that relies on the absence of a role then becomes `UNKNOWN`.
3. **Database service.** Resolved the way Immich does it: the `DB_URL` host, else `DB_HOSTNAME`, else `database`. It is matched against service names, `container_name`, `hostname` and network aliases. Ambiguous, external, `links`, `extra_hosts`, `network_mode` and profile-gated cases are `UNKNOWN`.
4. **Three-valued predicates.** Each predicate returns true, false or unknown: version crossings, environment variables (with an optional service-identity filter by command prefix), command argv, container ports, database image kind. Rule conditions combine them with `all` / `any` / `not`. An undecidable condition makes the finding `UNKNOWN`, whatever the rule's kind.
5. **Service identity for legacy ports.** `SERVER_PORT` is checked on the API server, `MICROSERVICES_PORT` on the separate `start.sh microservices` container (targets below v1.118.0), and `MACHINE_LEARNING_PORT` on the machine-learning service. Any `entrypoint:`, or a shell-wrapped, unresolved or unparsable command, makes the identity `UNKNOWN`. Only a server-image service with neither `command:` nor `entrypoint:` counts as the API server.
6. **Env-destination guard** (for `rename_env` / `duplicate_env`). A rename writes the destination where the legacy variable is defined, so each Immich service the write reaches is checked: a shared env file reaches every service that lists it, and a service's own `environment:` reaches only that service and outranks env files.
   - Two different values for one destination → `different_values`.
   - An existing destination with a different value → `existing_value_differs`.
   - Both keep the rule's label and switch the remediation to `resolve_env_conflict`.
   - An unresolved value (`unresolved_value`), a destination that cannot be looked up (`existing_value_unchecked`), or a shared file that would also change another service's default (`reaches_other_service`) makes the finding `UNKNOWN` with a "Verify before renaming …" instruction.
   - Values are compared internally and never emitted.
7. **Upgrade path.** Path constraints add mandatory stops (`INTERMEDIATE_REQUIRED`); advisory rules can add recommended stops.
8. **Conflict check.** If two certain findings with the same action key disagree on the label, the run fails with `RULE_CONFLICT` instead of reporting.

## Output boundary

Reports carry only:
- rule IDs, labels and structured action keys;
- instructions generated from validated remediation;
- configuration references (service, field, file and line; values shown as `(set)` or as a classification such as `relative path`);
- uncertainty reasons;
- evidence `{id, url, revision}`.

Rule summaries and evidence titles are internal and are never emitted. Errors carry `{category, message, field?}` and never repeat the value a user supplied. The JSON format is versioned separately (`schema: 3`) from the package version.

## Exit codes

| Code | Categories |
|---|---|
| `0` | analysis completed |
| `2` | `INPUT_ERROR`, `SCHEMA_ERROR`, `RULE_ERROR`, `RULE_CONFLICT` |
| `3` | `UNSUPPORTED_VERSION` |
| `1` | `INTERNAL_ERROR` |
