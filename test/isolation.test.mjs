// Leakage and registry consistency: the engine cannot see expectations; evidence IDs stay in sync with EVIDENCE.md.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { tempDataset } from '../tools/score.mjs';
import { splitFixtures } from '../tools/split-fixtures.mjs';
import { mkProject } from './helpers.mjs';

const dataset = tempDataset();
after(() => fs.rmSync(path.dirname(dataset), { recursive: true, force: true }));

test('engine sources never reference the dataset, fixtures or expectations', () => {
  for (const f of [...fs.readdirSync('src').map(f => path.join('src', f)), 'bin/cri.mjs']) {
    const text = fs.readFileSync(f, 'utf8');
    for (const word of ['dataset', 'fixtures', 'expected/', 'expected_label', 'expected_report', 'evidence_strength']) assert.ok(!text.includes(word), `${f} mentions ${word}`);
  }
});

test('case inputs and requests carry no labels, rationale or answer keys', () => {
  const root = path.join(dataset, 'cases');
  for (const id of fs.readdirSync(root)) {
    const files = fs.readdirSync(path.join(root, id), { recursive: true }).map(f => path.join(root, id, f)).filter(f => fs.statSync(f).isFile());
    for (const f of files) {
      const t = fs.readFileSync(f, 'utf8');
      for (const w of ['ACTION_REQUIRED', 'NOT_APPLICABLE', 'ADVISORY', 'UNKNOWN', 'expected_', 'rationale', 'missing_inputs', 'action_keys']) assert.ok(!t.includes(w), `${f} contains ${w}`);
    }
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, id, 'request.json'), 'utf8'))).filter(k => !['current', 'target'].includes(k)), []);
  }
});

test('split refuses to delete a directory it did not generate', () => {
  const victim = mkProject({ 'keep.txt': 'important' });
  assert.throws(() => splitFixtures(victim), /refusing to delete/);
  assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'important');
});

test('evidence registry matches EVIDENCE.md and every rule cites registered evidence', () => {
  const md = new Set([...fs.readFileSync('EVIDENCE.md', 'utf8').matchAll(/^\| (E\d\d) \|/gm)].map(m => m[1]));
  const reg = new Set(Object.keys(YAML.parse(fs.readFileSync('rules/evidence.yaml', 'utf8'))));
  assert.deepEqual([...reg].sort(), [...md].sort());
});

test('evidence registry text matches EVIDENCE.md: each URL appears in the row of its own ID', () => {
  const rows = Object.fromEntries([...fs.readFileSync('EVIDENCE.md', 'utf8').matchAll(/^\| (E\d\d) \|(.*)$/gm)].map(m => [m[1], m[2]]));
  const reg = YAML.parse(fs.readFileSync('rules/evidence.yaml', 'utf8'));
  for (const [id, e] of Object.entries(reg)) {
    assert.ok(rows[id]?.includes(e.url), `${id}: registry URL ${e.url} is not in its EVIDENCE.md row`);
    const row = rows[id].replace(/`/g, '');
    for (const tok of String(e.revision).split(/[\s,()]+/).filter(t => /\d/.test(t))) assert.ok(row.includes(tok), `${id}: registry revision token '${tok}' is not in its EVIDENCE.md row`);
  }
});
