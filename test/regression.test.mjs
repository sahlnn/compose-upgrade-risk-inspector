// Regression over the 41 development cases (36 core + 5 advisory) and determinism.
// Development-set agreement only; rules and cases share an author, so this is not a general accuracy claim.
// Side effects: the dataset is generated into a temp directory and deleted afterwards; the project is not touched.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { analyze, DEFAULTS } from '../src/engine.mjs';
import { runCases, summarize, tempDataset } from '../tools/score.mjs';

const dataset = tempDataset();
after(() => fs.rmSync(path.dirname(dataset), { recursive: true, force: true }));
const rows = runCases(analyze, dataset);
const kinds = Object.fromEntries(YAML.parse(fs.readFileSync(DEFAULTS.rulesFile, 'utf8')).rules.map(r => [r.id, r.kind]));

test('41 development cases are present', () => assert.equal(rows.length, 41));

test('hard gates over all six families: no UNKNOWN->certain, no ACTION_REQUIRED->NOT_APPLICABLE/ADVISORY', () => {
  assert.deepEqual(summarize(rows).hard_gate_violations, []);
});

test('every scored family label matches the development expectation', () => {
  const wrong = rows.filter(r => r.outcome !== 'correct').map(r => `${r.id}: expected ${r.expected}, got ${r.got}`);
  assert.deepEqual(wrong, []);
});

test('full report matches: six family labels, action keys, upgrade path, cited UNKNOWN reasons, DB details', () => {
  assert.deepEqual(summarize(rows).report_mismatches, {});
});

test('every certain finding cites a source and a config field; every UNKNOWN says why', () => {
  for (const r of rows) for (const fam of Object.values(r.full.families)) for (const f of fam.findings) {
    assert.ok(f.evidence.length && f.evidence.every(e => e.url), `${r.id} ${f.rule_id} has no source`);
    if (f.label === 'ACTION_REQUIRED' || f.label === 'ADVISORY') assert.ok(f.config.length, `${r.id} ${f.rule_id} has no config field`);
    if (f.label === 'UNKNOWN') assert.ok(f.missing_inputs.length || kinds[f.rule_id] === 'unverified', `${r.id} ${f.rule_id} UNKNOWN without reason`);
  }
});

test('overlapping findings are kept: F4-U1 shows the UNKNOWN and the separate avoid-v1.136.0 ADVISORY', () => {
  const r = rows.find(x => x.id === 'F4-U1').full;
  assert.equal(r.families.F4.label, 'UNKNOWN');
  assert.deepEqual(r.families.F4.findings.map(f => f.label).sort(), ['ADVISORY', 'UNKNOWN']);
  assert.equal(r.upgrade_path.status, 'UNKNOWN');
});

test('a finding lists every matching config field, not just the first (F2-A1 start.sh in two services)', () => {
  const f = rows.find(r => r.id === 'F2-A1').full.families.F2.findings.find(x => x.rule_id === 'F2-118-start-sh-removed');
  assert.deepEqual(f.config.filter(c => c.field === 'command').map(c => c.service), ['immich-microservices', 'immich-server']);
});

test('F6-N2: F6 stays NOT_APPLICABLE while the F5 advisory is shown independently', () => {
  const r = rows.find(x => x.id === 'F6-N2').full.families;
  assert.equal(r.F6.label, 'NOT_APPLICABLE');
  assert.equal(r.F5.label, 'ADVISORY');
});

test('determinism: same input twice -> identical JSON, and CLI bytes are identical', () => {
  const again = runCases(analyze, dataset);
  assert.deepEqual(again.map(r => JSON.stringify(r.full)), rows.map(r => JSON.stringify(r.full)));
  const dir = path.join(dataset, 'cases/F5-A1/input');
  const run = () => execFileSync(process.execPath, ['bin/cri.mjs', 'analyze', dir, '--current', 'v1.132.3', '--target', 'v3.0.0', '--json']).toString();
  const a = run();
  assert.equal(a, run());
  assert.ok(!a.includes(path.resolve('.')) && !a.includes(dataset), 'output must not embed absolute paths');
});
