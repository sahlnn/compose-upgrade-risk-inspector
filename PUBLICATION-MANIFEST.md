# Publication manifest (v0.2.2)

What this public repository contains, and what was deliberately left out of it. The repository was assembled from an explicit allowlist, not by copying and cleaning up the development directory.

## Included

| Category | Paths | Notes |
|---|---|---|
| CLI and engine | `bin/`, `src/` | Unchanged from the reviewed v0.2.2 code |
| Rules and evidence registry | `rules/immich.rules.yaml`, `rules/evidence.yaml` | 23 rules + 2 path constraints, `db_images` table |
| Version registries | `data/immich-release-tags.txt`, `data/immich-git-tags.txt` | Lists of official Immich release and tag names |
| Tests | `test/` | All suites, the hand-written golden record, and `test/examples.test.mjs` (new: checks the example outputs) |
| Development set | `fixtures/`, `fixtures-advisory/` | 36 + 5 synthetic cases with answer keys; embedded `.env` contents use placeholders only (`synthetic-placeholder`) |
| Tooling | `tools/` | Scoring, baseline, fixture validation, fixture split, mutation check (the mutation copy list now includes `examples/`) |
| Examples | `examples/01-…`, `02-…`, `03-…` | Synthetic inputs (including `.env` files with placeholder values), saved terminal and JSON reports, explanations |
| Documentation | `README.md`, `EVIDENCE.md`, `CHANGELOG.md`, `docs/` | English; `EVIDENCE.md` stays at the root because tests and tools parse its source table |
| Snapshot hashes | `docs/source-snapshots-sha256.txt` | SHA-256 values of the author's local source snapshots, for reference only; the snapshots themselves are not included |
| Package metadata | `package.json`, `package-lock.json` | Version `0.2.2`, `"private": true`, license `MIT`; one locked dependency (`yaml@2.9.1`, ISC) |
| Repository files | `LICENSE`, `.gitignore`, `.gitattributes`, `.github/workflows/ci.yml` | |

## Excluded

| Category | Reason |
|---|---|
| `node_modules/` | Installed from the lockfile with `npm ci` |
| `dataset/` | Stale generated split; tests regenerate it in a temporary directory |
| `evidence/` raw logs (`before-fix`, `test-run`, `mutation-check`, score outputs, sample outputs) | They contain local usernames, absolute paths and temporary directories, and several samples use older output formats. Replaced by the summaries in [docs/testing.md](docs/testing.md) |
| `evidence/snapshots/` (verbatim Immich release notes, docs and blog post) | Third-party material, not covered by this project's license. Sources are cited by URL and revision in [EVIDENCE.md](EVIDENCE.md) |
| Internal phase and round reports (`PHASE*`, `QUALITY-GATE`, `CASE-INVENTORY`, `FEASIBILITY`, `V0.2*` result and closure reports) | Internal working documents (mostly in Turkish, some with local paths). Summarised in [CHANGELOG.md](CHANGELOG.md) and [docs/development-process.md](docs/development-process.md) |
| AI development-session handoff notes | Private coordination material |
| Blind-evaluation material | Never part of this project directory; not published |
| Local publication-preparation report | Contains local paths; ignored by `.gitignore` |

Nothing in the excluded categories is needed to install, test or run the tool. The only verification that depended on excluded files is re-checking the snapshot hashes, which is not possible from this repository.
