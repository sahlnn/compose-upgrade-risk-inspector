// v0.2.2 POST-CLOSURE-AUDIT DEVELOPMENT REGRESSIONS. Written in this project from the three findings of the
// independent Codex closure audit of v0.2.1; synthetic inputs only. Not blind cases, not an independent evaluation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { analyze, DEFAULTS } from '../src/engine.mjs';
import { renderText } from '../src/report.mjs';
import { mkProject } from './helpers.mjs';

const CLI = path.resolve('bin/cri.mjs');
const SERVER = 'ghcr.io/immich-app/immich-server:release';
const MLIMG = 'ghcr.io/immich-app/immich-machine-learning:release';
const PG14 = 'ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0';
const S = 'immich-server', MS = 'immich-microservices', ML = 'immich-machine-learning';
const API = ['start.sh', 'immich'], MICRO = ['start.sh', 'microservices'];
const compose = services => YAML.stringify({ services: { ...services, database: { image: PG14 } } });
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const findings = r => Object.values(r.families).flatMap(f => f.findings);
const certain = r => findings(r).filter(f => f.label !== 'UNKNOWN');
const plainInto = (r, dest) => certain(r).filter(f => ['rename_env', 'duplicate_env'].includes(f.remediation.op) && f.remediation.replacements.includes(dest));
const conflictsInto = (r, dest) => findings(r).filter(f => f.remediation.op === 'resolve_env_conflict' && f.remediation.replacements.includes(dest));
const servicesOf = f => [...new Set(f.config.map(c => c.service).filter(Boolean))].sort();
// Certain findings that name `key` as a subject on service `svc`.
const certainOn = (r, key, svc) => certain(r).filter(f => f.remediation.subjects.includes(key) && f.config.some(c => c.service === svc && c.field === `environment.${key}`));
const noValues = (r, ...values) => { const out = JSON.stringify(r) + renderText(r); for (const v of values) assert.ok(!out.includes(v), `value ${v} echoed`); };

// ---------- 1 (HIGH): an unchecked destination never receives an unconditional write ----------
const codexU = () => mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER, environment: { HOST: '0.0.0.0' }, env_file: ['missing.env'] } }) });
test('U1 (Codex repro): HOST in environment:, env_file missing.env, v1.105.1 -> v1.119.0: no unconditional "Rename HOST to IMMICH_HOST"', () => {
  const r = analyze({ dir: codexU(), current: 'v1.105.1', target: 'v1.119.0' });
  assert.deepEqual(plainInto(r, 'IMMICH_HOST'), [], 'no certain plain rename/duplicate into an unchecked IMMICH_HOST');
  const f = findings(r).find(x => x.rule_id === 'F1-119-host-renamed');
  assert.equal(f.remediation.op, 'resolve_env_conflict');
  assert.equal(f.label, 'UNKNOWN');
  assert.deepEqual(f.conflicts.map(c => [c.destination, c.reason, c.services]), [['IMMICH_HOST', 'existing_value_unchecked', [S]]]);
  assert.match(f.action, /^Verify before renaming HOST to IMMICH_HOST/);
  assert.ok(f.missing_inputs.some(m => m.includes('missing.env')), f.missing_inputs.join(' | '));
  // The version-boundary fact is kept: the crossing and the legacy variable stay cited.
  assert.ok(f.config.some(c => c.field === 'request' && c.value.includes('crosses v1.119.0')));
  assert.ok(f.config.some(c => c.service === S && c.field === 'environment.HOST'));
  assert.deepEqual(f.evidence.map(e => e.id), ['E03']);
  noValues(r, '0.0.0.0');
});
test('U2: the same unchecked destination before v1.119 (transition advisory) is conditional too', () => {
  const r = analyze({ dir: codexU(), current: 'v1.105.1', target: 'v1.118.0' });
  assert.deepEqual(plainInto(r, 'IMMICH_HOST'), []);
  const f = findings(r).find(x => x.rule_id === 'F1-106-host-transition');
  assert.deepEqual([f.remediation.op, f.label, f.conflicts[0].reason], ['resolve_env_conflict', 'UNKNOWN', 'existing_value_unchecked']);
});
test('U3: the same invariant for IMMICH_PORT (SERVER_PORT in environment:, env_file missing)', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER, command: API, environment: { SERVER_PORT: '3001' }, env_file: ['missing.env'] } }) });
  const r = analyze({ dir, current: 'v1.105.1', target: 'v1.106.1' });
  assert.deepEqual(plainInto(r, 'IMMICH_PORT'), []);
  const [f] = conflictsInto(r, 'IMMICH_PORT');
  assert.deepEqual([f.rule_id, f.label, f.conflicts[0].reason], ['F1-106-port-host-renamed', 'UNKNOWN', 'existing_value_unchecked']);
  noValues(r, '3001');
});
test('U4: a shared .env reader whose own destination cannot be checked blocks the unconditional write as well', () => {
  const dir = mkProject({
    'docker-compose.yml': compose({ [S]: { image: SERVER, env_file: ['.env'] }, [ML]: { image: MLIMG, env_file: ['.env', 'ml-missing.env'] } }),
    '.env': 'HOST=0.0.0.0\n',
  });
  const r = analyze({ dir, current: 'v1.118.2', target: 'v1.119.0' });
  assert.deepEqual(plainInto(r, 'IMMICH_HOST'), []);
  const [f] = conflictsInto(r, 'IMMICH_HOST');
  assert.deepEqual([f.label, f.conflicts[0].reason, f.conflicts[0].services], ['UNKNOWN', 'existing_value_unchecked', [ML, S]]);
});
test('U5 (control): checked and compatible destination keeps the ordinary deterministic rename', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER, environment: { HOST: '0.0.0.0' }, env_file: ['present.env'] } }), 'present.env': 'TZ=UTC\n' });
  const r = analyze({ dir, current: 'v1.105.1', target: 'v1.119.0' });
  assert.deepEqual(plainInto(r, 'IMMICH_HOST').map(f => [f.rule_id, f.action]), [['F1-119-host-renamed', 'Rename HOST to IMMICH_HOST.']]);
  assert.deepEqual(conflictsInto(r, 'IMMICH_HOST'), []);
});
test('U6 (control): a known conflicting destination still uses resolve_env_conflict with the rule label', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER, environment: { HOST: '0.0.0.0', IMMICH_HOST: '127.0.0.1' } } }) });
  const [f] = conflictsInto(analyze({ dir, current: 'v1.118.2', target: 'v1.119.0' }), 'IMMICH_HOST');
  assert.deepEqual([f.label, f.conflicts[0].reason], ['ACTION_REQUIRED', 'existing_value_differs']);
});
test('U7 (control): an unresolved destination value is not treated as absent', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER, environment: { HOST: '0.0.0.0', IMMICH_HOST: '${BIND}' } } }) });
  const r = analyze({ dir, current: 'v1.118.2', target: 'v1.119.0' });
  assert.deepEqual(plainInto(r, 'IMMICH_HOST'), []);
  assert.equal(conflictsInto(r, 'IMMICH_HOST')[0].conflicts[0].reason, 'unresolved_value');
});
test('U8: terminal and JSON agree for the Codex reproduction', () => {
  const dir = codexU();
  const j = run('analyze', dir, '--current', 'v1.105.1', '--target', 'v1.119.0', '--json');
  const t = run('analyze', dir, '--current', 'v1.105.1', '--target', 'v1.119.0');
  assert.equal(j.status, 0);
  const f = findings(JSON.parse(j.stdout)).find(x => x.rule_id === 'F1-119-host-renamed');
  assert.ok(t.stdout.includes(f.action) && t.stdout.includes('conflict: IMMICH_HOST existing_value_unchecked'), t.stdout);
  assert.ok(!t.stdout.includes('action : Rename HOST to IMMICH_HOST.'));
});

// ---------- 2 (HIGH): legacy port variables follow service identity (E01, E02) ----------
const at106 = services => analyze({ dir: mkProject({ 'docker-compose.yml': compose(services) }), current: 'v1.105.1', target: 'v1.106.1' });
test('P1 (Codex repro): SERVER_PORT only in the ML service environment: is never renamed there', () => {
  const r = at106({ [S]: { image: SERVER, command: API }, [ML]: { image: MLIMG, environment: { SERVER_PORT: '3001' } } });
  assert.deepEqual(certainOn(r, 'SERVER_PORT', ML), []);
  assert.ok(!findings(r).some(f => f.config.some(c => c.service === ML && c.field === 'environment.SERVER_PORT')));
});
test('P2: MACHINE_LEARNING_PORT in the server environment: is never renamed there', () => {
  const r = at106({ [S]: { image: SERVER, command: API, environment: { MACHINE_LEARNING_PORT: '3003' } } });
  assert.deepEqual(certainOn(r, 'MACHINE_LEARNING_PORT', S), []);
});
test('P3 (positive): SERVER_PORT in the API server (start.sh immich) is renamed there', () => {
  const r = at106({ [S]: { image: SERVER, command: API, environment: { SERVER_PORT: '3001' } } });
  assert.deepEqual(plainInto(r, 'IMMICH_PORT').map(f => [f.rule_id, f.remediation.subjects, servicesOf(f)]), [['F1-106-port-host-renamed', ['SERVER_PORT'], [S]]]);
});
test('P4: MACHINE_LEARNING_PORT in the ML service is renamed there, by the ML port rule', () => {
  const r = at106({ [S]: { image: SERVER, command: API }, [ML]: { image: MLIMG, environment: { MACHINE_LEARNING_PORT: '3003' } } });
  assert.deepEqual(plainInto(r, 'IMMICH_PORT').map(f => [f.rule_id, f.remediation.subjects, servicesOf(f)]), [['F1-106-ml-port-renamed', ['MACHINE_LEARNING_PORT'], [ML]]]);
});
test('P5: MICROSERVICES_PORT in a separate start.sh microservices container is renamed there (v1.106-v1.117)', () => {
  const r = at106({ [S]: { image: SERVER, command: API }, [MS]: { image: SERVER, command: MICRO, environment: { MICROSERVICES_PORT: '3002' } } });
  assert.deepEqual(plainInto(r, 'IMMICH_PORT').map(f => [f.rule_id, f.remediation.subjects, servicesOf(f)]), [['F1-106-microservices-port-renamed', ['MICROSERVICES_PORT'], [MS]]]);
});
test('P6: MICROSERVICES_PORT in the API server and SERVER_PORT in the microservices container are never renamed', () => {
  const r = at106({ [S]: { image: SERVER, command: API, environment: { MICROSERVICES_PORT: '3002' } }, [MS]: { image: SERVER, command: MICRO, environment: { SERVER_PORT: '3001' } } });
  assert.deepEqual(certainOn(r, 'MICROSERVICES_PORT', S), []);
  assert.deepEqual(certainOn(r, 'SERVER_PORT', MS), []);
});
test('P7: from v1.118 the microservices container must be removed, so its port is not renamed', () => {
  const r = analyze({ dir: mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER, command: API }, [MS]: { image: SERVER, command: MICRO, environment: { MICROSERVICES_PORT: '3002' } } }) }), current: 'v1.105.1', target: 'v1.118.0' });
  assert.deepEqual(certainOn(r, 'MICROSERVICES_PORT', MS), []);
  assert.ok(certain(r).some(f => f.rule_id === 'F2-118-microservices-removed'));
});
test('P8: an ambiguous server-image identity (shell-wrapped command) gives UNKNOWN, not a definite rename', () => {
  const r = at106({ [S]: { image: SERVER, command: ['sh', '-c', 'start.sh microservices'], environment: { SERVER_PORT: '3001' } } });
  assert.deepEqual(certainOn(r, 'SERVER_PORT', S), []);
  const f = findings(r).find(x => x.rule_id === 'F1-106-port-host-renamed');
  assert.equal(f?.label, 'UNKNOWN');
  assert.ok(f.missing_inputs.some(m => m.includes(S)), f.missing_inputs.join(' | '));
});
test('P9: official pre-v1.106 layout with a shared .env and three different ports: one guarded finding per owner, no plain IMMICH_PORT', () => {
  const dir = mkProject({
    'docker-compose.yml': compose({ [S]: { image: SERVER, command: API, env_file: ['.env'] }, [MS]: { image: SERVER, command: MICRO, env_file: ['.env'] }, [ML]: { image: MLIMG, env_file: ['.env'] } }),
    '.env': 'SERVER_PORT=3001\nMICROSERVICES_PORT=3002\nMACHINE_LEARNING_PORT=3003\n',
  });
  const r = analyze({ dir, current: 'v1.105.1', target: 'v1.106.1' });
  assert.deepEqual(plainInto(r, 'IMMICH_PORT'), []);
  assert.deepEqual(conflictsInto(r, 'IMMICH_PORT').map(f => [f.rule_id, f.remediation.subjects, f.conflicts[0].reason]).sort(),
    [['F1-106-microservices-port-renamed', ['MICROSERVICES_PORT'], 'different_values'], ['F1-106-ml-port-renamed', ['MACHINE_LEARNING_PORT'], 'different_values'], ['F1-106-port-host-renamed', ['SERVER_PORT'], 'different_values']]);
});
test('P10: SERVER_PORT alone in a shared .env: owned by the API server only, and the write is conditional because it would also change the port of the other readers', () => {
  const dir = mkProject({
    'docker-compose.yml': compose({ [S]: { image: SERVER, command: API, env_file: ['.env'] }, [MS]: { image: SERVER, command: MICRO, env_file: ['.env'] }, [ML]: { image: MLIMG, env_file: ['.env'] } }),
    '.env': 'SERVER_PORT=3001\n',
  });
  const r = analyze({ dir, current: 'v1.105.1', target: 'v1.106.1' });
  assert.deepEqual(plainInto(r, 'IMMICH_PORT'), []);
  const [f] = conflictsInto(r, 'IMMICH_PORT');
  assert.deepEqual([f.rule_id, servicesOf(f), f.label], ['F1-106-port-host-renamed', [S], 'UNKNOWN']);
  assert.deepEqual(f.conflicts.map(c => [c.reason, c.services]), [['reaches_other_service', [MS, S]], ['reaches_other_service', [ML, S]]].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  for (const other of [MS, ML]) assert.ok(f.missing_inputs.some(m => m.includes('IMMICH_PORT') && m.includes(other)), other);
  noValues(r, '3001');
});
test('P11 (control): SERVER_PORT in the API server own environment: is not a shared write, so the rename stays ordinary', () => {
  const r = at106({ [S]: { image: SERVER, command: API, environment: { SERVER_PORT: '3001' } }, [ML]: { image: MLIMG } });
  assert.deepEqual(plainInto(r, 'IMMICH_PORT').map(f => f.action), ['Rename SERVER_PORT to IMMICH_PORT.']);
});

// ---------- 3 (MEDIUM): a missing explicit --rules file is a user-correctable INPUT_ERROR ----------
const CANARY = 'AUDIT_CANARY_NOT_FOUND';
const isStack = s => /\n\s+at .+[:(]/.test(s) || /Error: ENOENT|ENOENT|EISDIR/.test(s);
test('L1 (Codex repro): lint --json --rules <missing> is INPUT_ERROR, exit 2, JSON shape, no path, no stack', () => {
  const j = run('lint', '--json', '--rules', `${CANARY}.yaml`);
  assert.equal(j.status, 2, j.stdout + j.stderr);
  assert.equal(j.stderr, '');
  const out = JSON.parse(j.stdout);
  assert.deepEqual([out.tool, out.schema, out.error.category, out.error.field], ['compose-upgrade-risk-inspector', 3, 'INPUT_ERROR', '--rules']);
  assert.ok(!j.stdout.includes(CANARY));
  const t = run('lint', '--rules', `${CANARY}.yaml`);
  assert.equal(t.status, 2);
  assert.match(t.stderr, /^error \[INPUT_ERROR\]/);
  assert.ok(!t.stderr.includes(CANARY) && !isStack(t.stderr), t.stderr);
});
test('L2: analyze with a missing --rules file, and --rules naming a directory, are INPUT_ERRORs too', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER } }) });
  for (const rules of [path.join(dir, `${CANARY}.yaml`), dir]) for (const json of [true, false]) {
    const res = run('analyze', dir, '--current', 'v2.7.5', '--target', 'v3.0.0', '--rules', rules, ...(json ? ['--json'] : []));
    assert.equal(res.status, 2, res.stdout + res.stderr);
    const cat = json ? JSON.parse(res.stdout).error.category : /error \[(\w+)\]/.exec(res.stderr)?.[1];
    assert.equal(cat, 'INPUT_ERROR');
    assert.ok(!(res.stdout + res.stderr).includes(CANARY) && !isStack(res.stdout + res.stderr));
  }
});
test('L3 (control): an existing --rules file is still loaded and validated as before (RULE_ERROR for an invalid one)', () => {
  const dir = mkProject({ 'ok.yaml': fs.readFileSync(DEFAULTS.rulesFile, 'utf8'), 'bad.yaml': 'schema: 2\n' });
  const ok = run('lint', '--rules', path.join(dir, 'ok.yaml'));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /rules OK/);
  const bad = run('lint', '--json', '--rules', path.join(dir, 'bad.yaml'));
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).error.category, 'RULE_ERROR');
});

// ---------- v0.2.2 follow-up (HIGH, Codex v0.2.2 closure audit): a custom entrypoint makes service identity uncertain ----------
const portRules = ['F1-106-port-host-renamed', 'F1-106-microservices-port-renamed'];
const portFindings = r => findings(r).filter(f => portRules.includes(f.rule_id));
const entry = (svc, target = 'v1.106.1') => analyze({ dir: mkProject({ 'docker-compose.yml': compose({ s: { image: SERVER, environment: { SERVER_PORT: '3001', MICROSERVICES_PORT: '3002' }, ...svc } }) }), current: 'v1.105.1', target });
const assertUncertainIdentity = (r, why) => {
  assert.deepEqual(certainOn(r, 'SERVER_PORT', 's'), [], 'no definite API-port rename');
  assert.deepEqual(certainOn(r, 'MICROSERVICES_PORT', 's'), [], 'no definite microservices-port rename');
  const fs_ = portFindings(r);
  assert.ok(fs_.length >= 1, 'the port migration is still reported');
  for (const f of fs_) {
    assert.equal(f.label, 'UNKNOWN', f.rule_id);
    assert.match(f.action, /^Cannot decide without the missing inputs\. If it applies: Rename (SERVER|MICROSERVICES)_PORT to IMMICH_PORT\.$/);
    assert.ok(f.missing_inputs.some(m => m.includes(why)), f.missing_inputs.join(' | '));
    assert.deepEqual(f.config, [], 'an UNKNOWN finding carries no config claim');
  }
};
test('E1 (Codex repro): entrypoint ["start.sh","microservices"] and no command: identity UNKNOWN, no definite SERVER_PORT rename; JSON = terminal', () => {
  const r = entry({ entrypoint: ['start.sh', 'microservices'] });
  assertUncertainIdentity(r, 'command of s (custom entrypoint; not interpreted)');
  assert.deepEqual(portFindings(r).map(f => f.rule_id).sort(), portRules.slice().sort());
  assert.equal(r.families.F1.label, 'UNKNOWN');
  noValues(r, '3001', '3002');
  const dir = mkProject({ 'docker-compose.yml': compose({ s: { image: SERVER, entrypoint: ['start.sh', 'microservices'], environment: { SERVER_PORT: '3001', MICROSERVICES_PORT: '3002' } } }) });
  const j = JSON.parse(run('analyze', dir, '--current', 'v1.105.1', '--target', 'v1.106.1', '--json').stdout);
  const t = run('analyze', dir, '--current', 'v1.105.1', '--target', 'v1.106.1').stdout;
  for (const f of portFindings(j)) assert.ok(t.includes(`[UNKNOWN] ${f.rule_id}`) && t.includes(f.action), f.rule_id);
  assert.ok(!t.includes('[ACTION_REQUIRED] F1-106-port-host-renamed'));
});
test('E2 (control): custom entrypoint plus an explicit start.sh immich command stays UNKNOWN', () => {
  assertUncertainIdentity(entry({ entrypoint: ['/custom.sh'], command: API }), 'custom entrypoint');
});
test('E3 (control): no entrypoint and no command is the API server: plain SERVER_PORT rename only', () => {
  const r = entry({});
  assert.deepEqual(plainInto(r, 'IMMICH_PORT').map(f => [f.rule_id, f.action, servicesOf(f)]), [['F1-106-port-host-renamed', 'Rename SERVER_PORT to IMMICH_PORT.', ['s']]]);
});
test('E4 (control): the documented start.sh microservices command: plain MICROSERVICES_PORT rename only', () => {
  const r = entry({ command: MICRO });
  assert.deepEqual(plainInto(r, 'IMMICH_PORT').map(f => [f.rule_id, f.action, servicesOf(f)]), [['F1-106-microservices-port-renamed', 'Rename MICROSERVICES_PORT to IMMICH_PORT.', ['s']]]);
});
test('E5: shell-wrapped, string, unresolved and null entrypoints without a command are UNKNOWN as well', () => {
  for (const entrypoint of [['sh', '-c', 'start.sh microservices'], 'start.sh microservices', '${CUSTOM_ENTRYPOINT}', null]) {
    assertUncertainIdentity(entry({ entrypoint }), 'custom entrypoint');
  }
});
test('E6: the v1.118 boundary still holds with a custom entrypoint: no microservices rename, API rename UNKNOWN, F2 checks not certain', () => {
  const r = entry({ entrypoint: ['start.sh', 'microservices'] }, 'v1.118.0');
  assert.equal(findings(r).find(f => f.rule_id === 'F1-106-microservices-port-renamed'), undefined);
  assert.equal(findings(r).find(f => f.rule_id === 'F1-106-port-host-renamed').label, 'UNKNOWN');
  for (const id of ['F2-118-microservices-removed', 'F2-118-start-sh-removed']) assert.equal(findings(r).find(f => f.rule_id === id)?.label, 'UNKNOWN', id);
});
