# Example 3: an external database makes the v3 database checks UNKNOWN (v2.7.5 → v3.0.0)

A synthetic Immich setup running v2.7.5 whose PostgreSQL server is outside this Compose project (`DB_HOSTNAME=db.example.internal`, a placeholder). Immich v3.0.0 removed pgvecto.rs support (E10, E12), so whether this upgrade is affected depends on the database's image and installed extension. A static, offline tool cannot see either. All values are placeholders.

```bash
node bin/cri.mjs analyze examples/03-external-database-unknown --current v2.7.5 --target v3.0.0
node bin/cri.mjs analyze examples/03-external-database-unknown --current v2.7.5 --target v3.0.0 --json
```

Saved outputs: [report.txt](report.txt) and [report.json](report.json), both checked by `test/examples.test.mjs`.

## What the report says

- **Result `UNKNOWN`**, with families F5 and F6 `UNKNOWN`. `UNKNOWN` means the inputs cannot decide the question. **It is not a pass.**
- **Reason, given on each finding:** `database host 'db.example.internal' is not a service in this compose (external database?)`. The tool resolves the database the way Immich does (`DB_URL`, else `DB_HOSTNAME`, default `database`). No service here answers to that host name.
- **`F5-300-no-supported-extension`:** "Cannot decide without the missing inputs. If it applies: back up the database, then replace the tensorchord/pgvecto-rs image …". Without the image, no concrete tag is suggested; the instruction asks you to match the PostgreSQL major and pgvecto.rs versions yourself.
- **`F6-300-legacy-vectors-command`:** the same conditional form, for the legacy `vectors.so` command override.
- **What to do with this result:** check the external database yourself against the cited sources before upgrading. The tool never connects to a database.
