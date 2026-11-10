# Development process

## Roles

The project was developed with AI-assisted engineering tools in two distinct roles:

| Role | Tool | What it did |
|---|---|---|
| Development | **Claude Code** (Anthropic), directed by the project owner | Researched the official sources, wrote the rules, engine, tests, fixtures and documents, and ran the local verification |
| Independent review | **Codex** (OpenAI), run separately from development | Audited code and behaviour in several rounds and reported concrete findings with reproductions, then re-reviewed the fixes |

The project owner set the scope and constraints for each round and decided when a round was closed. **None of this is an external certification, a human security audit or a production approval.** No customer deployments exist.

## Method used in every review round

1. Each review finding was first reproduced as a **failing test** in this repository. Control tests were added that must keep passing.
2. The fix was kept as small as possible and aimed at the root cause.
3. When a rule's contract legitimately changed, the hand-written golden record (`test/golden/rules.yaml`) was updated **by hand** and the change was explained.
4. The 41 development answer keys were never edited to make a fix pass. There was one deliberate, documented migration, in v0.2: the value `OK` of `upgrade_path.status` was replaced by `INTERMEDIATE_REQUIRED` (5 keys) or `NO_KNOWN_STOP` (32 keys). Before the change, all 37 mismatches were confirmed to come from that field alone.
5. Targeted mutations were added for each new safeguard (`tools/mutation-check.mjs`). Each was checked to fail the intended test, not just any test.
6. Then the full suite, lint, fixture validation and development scoring were run again.

## Review rounds (summary)

| Round | Review outcome | Main corrections |
|---|---|---|
| Phase 1.1 – 1.3.2 | Several audit rounds (findings C1–C10, H1–H3, P3, Phase 1.3 probes) | Database resolution like Immich, exact image matching, real-path containment, structured remediation (no free-text actions), validated evidence URLs and revisions, no echo of secrets |
| v0.2 | Informed by a summarized independent blind evaluation | Honest result semantics (`assessment`, `coverage`, no OK/SAFE), narrow Compose schema check, official git-tag registry and version policy, HOST transition advisory, documented database image table |
| v0.2.1 | NO-GO, 5 findings | HOST/`IMMICH_HOST` collision guard, nested schema checks, JSON error contract, no echo of user values in errors, strict SemVer prerelease grammar |
| v0.2.2 | NO-GO, 3 findings; then 1 further HIGH finding | Unchecked or shared destinations make renames conditional; legacy port variables follow the service that read them; a missing `--rules` file is `INPUT_ERROR`; a custom `entrypoint:` makes service identity `UNKNOWN` |
| Final | PASS on the last HIGH finding | — |

The blind evaluation mentioned for v0.2 was authored independently. Because v0.2 was developed in response to its summarized results, those cases are now exposed. They are not reused as evidence and are not published here. Any future accuracy claim needs a new, independently authored blind set.

v0.2, v0.2.1 and v0.2.2 were internal engineering iterations; **v0.2.2 is the first public release**. See [CHANGELOG.md](../CHANGELOG.md).
