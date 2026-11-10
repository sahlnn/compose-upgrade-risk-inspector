# Testing and verification

Everything below was run locally on Windows with Node.js 24.16.0, on the files of this repository, on 2026-11-10. The prepared CI workflow (Ubuntu and Windows, Node.js 24) has **not** run yet. **No production validation has been performed.**

## How to run

```bash
npm ci
```
```bash
node --test
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
```bash
npm run mutate -- --evidence <output-dir>
```

`score` and `mutate` write their result files to `evidence/phase1.1/` and `evidence/phase1.2/` unless `--evidence <dir>` is given; `evidence/` is git-ignored. `mutate` takes several minutes. It copies the project to a temporary directory once per mutation and never edits the working copy.

## Results by kind

### 1. Regression and unit tests (`node --test`)

**179 tests: 178 passed, 0 failed, 1 skipped.**

| Suite | What it covers |
|---|---|
| `unit`, `negative` | Parsing, interpolation, version comparison, invalid inputs and rule files |
| `isolation` | The engine cannot see answer keys; inputs never escape the project directory; the evidence registry matches [EVIDENCE.md](../EVIDENCE.md) |
| `rules` | One isolated positive case per rule and path constraint, compared with the hand-written golden record (`test/golden/rules.yaml`); deleting a rule must be detected |
| `regression` | Determinism, plus the development set (below) scored on the full report with hard gates |
| `audit`, `audit2`, `audit3`, `audit4` | Reproductions of earlier review findings: database resolution, containment, output boundary, structured remediation, evidence validation |
| `v02`, `v021`, `v022` | Reproductions and controls for the v0.2, v0.2.1 and v0.2.2 review findings (result semantics, schema, version policy, HOST/port collision guard, JSON errors, redaction, service identity, `--rules`, entrypoint) |
| `examples` | The three [examples](../examples/) reproduce their saved terminal and JSON reports byte for byte |

**The skip.** `C4b` (a file symlink pointing outside the project is refused) needs permission to create file symlinks, which Windows grants only with elevated rights or Developer Mode. It reports `EPERM` here and was not forced. The directory-junction variant `C4a` runs and passes. On Linux the test is expected to run, but that has not been checked yet.

### 2. Lint and fixture validation

- `node bin/cri.mjs lint`: `rules OK: 23 rules, 2 path constraints`.
- `npm run -s validate`: 36/36 core fixtures and 5/5 advisory fixtures valid.

### 3. Development set (41 synthetic cases)

- **Engine:** 41/41 on the scored family, 41/41 on the full report (all six family labels, action keys, upgrade path, cited UNKNOWN reasons), 0 hard-gate violations.
- **Naive keyword baseline**, for comparison: 23/41 on the scored family, 0/41 on the full report, 21 hard-gate violations (an `UNKNOWN` case reported as certain).
- **This is not an accuracy measure.** The cases, their answer keys, the rules and the golden record come from the same author. The set shows that the engine does what its author intended on the author's own cases, nothing more.

### 4. Mutation testing (`npm run mutate`)

`tools/mutation-check.mjs` applies one deliberate defect at a time to a temporary copy of the project and runs the full suite there. A defect counts as caught only if the suite fails. The unmodified control run must pass and is excluded from the rate.

| Run | Result |
|---|---|
| Full run, v0.2.1 code | 50/50 real mutations caught; control passed |
| Targeted runs, v0.2.2 changes | 16/16 targeted mutations failed their **intended** test (10 new, 6 earlier guard mutations re-checked); all mutation anchors still applied; the custom-entrypoint fix added one more targeted mutation, caught by its intended test |
| Full run, this repository (61 real mutations) | **61/61 caught**; control passed. In a full run, "caught" means the suite failed; the intended-test check was done only in the targeted runs above |

### 5. Independent AI code review

Several review rounds with Codex, separate from development; see [development-process.md](development-process.md). The final round reported PASS on the last HIGH finding. This is AI-assisted review, not a human security audit or certification.

### 6. Production validation

**Not performed.** The tool has not been validated against real Immich deployments, and no claim of real-world accuracy, safety or completeness is made.
