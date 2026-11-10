// Splits authoring fixtures into engine inputs and hidden expectations.
//   fixtures/*.yaml, fixtures-advisory/*.yaml  (authoring source, labels included)
//   -> <out>/cases/<ID>/input/<files>     (only what a user would provide)
//   -> <out>/cases/<ID>/request.json      (current/target only; no family, no label)
//   -> <out>/expected/<ID>.json           (answer key; never given to the engine)
// Usage: node tools/split-fixtures.mjs [--out <dir>]   (default dataset/dev)
// Side effect: <out> is deleted and regenerated, but only if it is absent or carries the marker file
// written by a previous run, so an unrelated directory can never be wiped. Tests pass a temp --out.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

const SOURCES = ['fixtures', 'fixtures-advisory'];
const MARKER = '.generated-by-split-fixtures';

export function splitFixtures(out = 'dataset/dev', root = '.') {
  if (fs.existsSync(out)) {
    if (!fs.existsSync(path.join(out, MARKER))) throw new Error(`refusing to delete ${out}: no ${MARKER} marker`);
    fs.rmSync(out, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(out, 'expected'), { recursive: true });
  fs.writeFileSync(path.join(out, MARKER), 'generated; safe to delete\n');
  let n = 0;
  for (const src of SOURCES) {
    const dir = path.join(root, src);
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).sort()) {
      const c = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8'), { uniqueKeys: true });
      const caseDir = path.join(out, 'cases', c.id);
      for (const [name, content] of Object.entries(c.files)) {
        const p = path.join(caseDir, 'input', name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      }
      const request = { target: c.target_version };
      if (c.current_version !== 'unknown') request.current = c.current_version;
      fs.writeFileSync(path.join(caseDir, 'request.json'), JSON.stringify(request, null, 2) + '\n');
      const expected = {
        id: c.id, set: src, family: c.family, label: c.expected_label,
        evidence_strength: c.evidence_strength, evidence: c.evidence,
        missing_inputs: c.missing_inputs, expected_actions: c.expected_actions, report: c.expected_report,
      };
      fs.writeFileSync(path.join(out, 'expected', `${c.id}.json`), JSON.stringify(expected, null, 2) + '\n');
      n++;
    }
  }
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : 'dataset/dev';
  console.log(`split ${splitFixtures(out)} cases into ${out}`);
}
