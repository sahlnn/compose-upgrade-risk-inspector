// Negative tests: missing env_file, broken YAML, wrong versions, conflicting rules, missing evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { analyze, InputError, ConflictError, DEFAULTS } from '../src/engine.mjs';
import { loadRules, RuleError } from '../src/rules.mjs';
import { loadKnownVersions } from '../src/version.mjs';
import { mkProject, SERVER } from './helpers.mjs';

const CLI = path.resolve('bin/cri.mjs');
const known = loadKnownVersions(DEFAULTS.versionsFile);
const baseRules = () => YAML.parse(fs.readFileSync(DEFAULTS.rulesFile, 'utf8'));
const writeRules = obj => { const d = mkProject({ 'r.yaml': YAML.stringify(obj) }); return path.join(d, 'r.yaml'); };

test('missing env_file -> UNKNOWN with the file named, never NOT_APPLICABLE', () => {
  const dir = mkProject({ 'docker-compose.yml': SERVER() }); // .env referenced but absent
  const r = analyze({ dir, current: 'v2.7.5', target: 'v3.0.0' });
  assert.equal(r.families.F6.label, 'UNKNOWN');
  assert.ok(r.inputs.missing.some(m => m.startsWith('.env')));
  assert.ok(r.families.F6.findings[0].missing_inputs.some(m => m.includes('.env')));
});

test('broken YAML is an input error (no findings, exit 2)', () => {
  const dir = mkProject({ 'docker-compose.yml': 'services:\n  a:\n   image: x\n  b: [unclosed\n' });
  assert.throws(() => analyze({ dir, current: 'v2.7.5', target: 'v3.0.0' }), InputError);
  const res = spawnSync(process.execPath, [CLI, 'analyze', dir, '--current', 'v2.7.5', '--target', 'v3.0.0']);
  assert.equal(res.status, 2);
  assert.match(res.stderr.toString(), /invalid YAML/);
});

test('duplicate YAML keys are rejected', () => {
  const dir = mkProject({ 'docker-compose.yml': 'services:\n  a:\n    image: x\n    image: y\n' });
  assert.throws(() => analyze({ dir, current: 'v2.7.5', target: 'v3.0.0' }), InputError);
});

test('wrong versions are rejected', () => {
  const dir = mkProject({ 'docker-compose.yml': SERVER(), '.env': 'A=1\n' });
  const bad = [
    [{ current: 'v2.7.5', target: 'v3.0' }, /invalid target/],
    [{ current: 'v2.7', target: 'v3.0.0' }, /invalid current/],
    [{ current: 'v2.7.5', target: 'v1.999.0' }, /not a known Immich release/],
    [{ current: 'v2.7.9', target: 'v3.0.0' }, /not a known Immich release/],
    [{ current: 'v3.0.0', target: 'v2.7.5' }, /downgrades are not supported/],
    [{ current: 'v3.0.0', target: 'v3.0.0' }, /not lower than target/],
  ];
  for (const [req, re] of bad) assert.throws(() => analyze({ dir, ...req }), re, JSON.stringify(req));
  const res = spawnSync(process.execPath, [CLI, 'analyze', dir, '--target', 'latest']);
  assert.equal(res.status, 2);
});

test('missing --current makes version-dependent checks UNKNOWN, not safe', () => {
  const dir = mkProject({ 'docker-compose.yml': SERVER(), '.env': 'A=1\n' });
  const r = analyze({ dir, target: 'v3.0.0' });
  for (const f of ['F3', 'F4']) assert.equal(r.families[f].label, 'UNKNOWN', f);
  assert.equal(r.upgrade_path.status, 'UNKNOWN');
});

test('conflicting rules: same action_key, different labels, both firing -> ConflictError', () => {
  const rules = baseRules();
  rules.rules.push({ ...rules.rules.find(r => r.id === 'F6-300-env-pgvectors-rejected'), id: 'F6-test-conflict', kind: 'advisory' });
  const dir = mkProject({ 'docker-compose.yml': SERVER(), '.env': 'DB_VECTOR_EXTENSION=pgvecto.rs\n' });
  assert.throws(() => analyze({ dir, current: 'v2.7.5', target: 'v3.0.0' }, { rulesFile: writeRules(rules) }), ConflictError);
  const res = spawnSync(process.execPath, [CLI, 'analyze', dir, '--current', 'v2.7.5', '--target', 'v3.0.0', '--rules', writeRules(rules)]);
  assert.equal(res.status, 2);
  assert.match(res.stderr.toString(), /both fired/);
});

test('overlapping-but-consistent rules keep separate findings (F3 + F4 on one path)', () => {
  const dir = mkProject({ 'docker-compose.yml': SERVER().replace("'2283:2283'", "'2283:2283'"), '.env': 'A=1\n' });
  const r = analyze({ dir, current: 'v1.105.1', target: 'v3.0.0' });
  assert.deepEqual(r.upgrade_path.stops.map(s => s.version), ['v1.107.2', 'v1.132.3']);
  assert.equal(r.families.F3.label, 'ACTION_REQUIRED');
  assert.equal(r.families.F4.label, 'ACTION_REQUIRED');
  assert.equal(r.families.F3.findings.length, 1);
  assert.equal(r.families.F4.findings.length, 1);
});

test('rule lint: duplicate id, missing evidence, unknown evidence, bad predicate, bad path stop', () => {
  const lint = mutate => { const r = baseRules(); mutate(r); return () => loadRules(writeRules(r), DEFAULTS.evidenceFile, known); };
  assert.throws(lint(r => r.rules.push({ ...r.rules[0] })), /duplicate rule id/);
  assert.throws(lint(r => { r.rules[0].evidence = []; }), /no evidence/);
  assert.throws(lint(r => { delete r.rules[0].evidence; }), /no evidence/);
  assert.throws(lint(r => { r.rules[0].evidence = ['E99']; }), /not a valid id in the evidence registry/);
  assert.throws(lint(r => { r.rules[0].when = { all: [{ crosses_maybe: 'v1.0.0' }] }; }), /unknown predicate/);
  assert.throws(lint(r => { r.rules[0].when = { all: [{ crosses: 'soon' }] }; }), /invalid argument/);
  assert.throws(lint(r => { r.rules[0].kind = 'maybe'; }), /unknown kind/);
  assert.throws(lint(r => { r.path_constraints[1].stop = 'v1.131.3'; }), /does not satisfy/);
  assert.throws(lint(r => { r.path_constraints[1].stop = 'v1.137.0'; }), /is not below/);
  assert.throws(lint(r => { r.path_constraints[1].stop = 'v1.132.9'; }), /not a known Immich release/);
  assert.throws(lint(r => { r.rules[0].family = 'F9'; }), RuleError);
});

test('unresolved image makes role-dependent checks UNKNOWN', () => {
  const dir = mkProject({ 'docker-compose.yml': `services:\n  app:\n    image: \${MY_IMAGE}\n  database:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3\n` });
  const r = analyze({ dir, current: 'v2.7.5', target: 'v3.0.0' });
  assert.equal(r.families.F6.label, 'UNKNOWN');
  assert.ok(r.families.F6.findings[0].missing_inputs.some(m => m.includes('MY_IMAGE')));
});

test('override files and include: are reported as unsupported and make checks UNKNOWN', () => {
  const dir = mkProject({ 'docker-compose.yml': SERVER(), '.env': 'A=1\n', 'docker-compose.override.yml': 'services: {}\n' });
  const r = analyze({ dir, current: 'v2.7.5', target: 'v3.0.0' });
  assert.ok(r.inputs.unsupported.some(u => u.includes('override')));
  assert.equal(r.families.F6.label, 'UNKNOWN');
});

test('CLI lint and help', () => {
  assert.match(execFileSync(process.execPath, [CLI, 'lint']).toString(), /rules OK/);
  assert.equal(spawnSync(process.execPath, [CLI]).status, 2);
});
