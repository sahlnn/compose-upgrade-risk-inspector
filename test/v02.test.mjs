// v0.2 POST-BLIND DEVELOPMENT REGRESSIONS. Written independently in this project from the summarized findings of
// the first blind evaluation; they are NOT blind cases and must never be reported as independent evaluation.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { analyze } from '../src/engine.mjs';
import { renderText } from '../src/report.mjs';
import { mkProject } from './helpers.mjs';

const CLI = path.resolve('bin/cri.mjs');
const SERVER = 'ghcr.io/immich-app/immich-server:release';
const PG14 = 'ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0';
const compose = services => YAML.stringify({ services });
const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, 'analyze', dir, ...args], { encoding: 'utf8' });
const findings = r => Object.values(r.families).flatMap(f => f.findings);
const simple = () => mkProject({ 'docker-compose.yml': compose({ 'immich-server': { image: SERVER }, database: { image: PG14 } }) });

// ---------- A: honest result and coverage semantics ----------
test('A1: a mandatory intermediate stop is never reported as an OK direct path', () => {
  const r = analyze({ dir: simple(), current: 'v1.131.3', target: 'v1.137.0' });
  assert.deepEqual(r.upgrade_path.stops.map(s => s.version), ['v1.132.3']);
  assert.equal(r.upgrade_path.status, 'INTERMEDIATE_REQUIRED');
  assert.equal(r.assessment.status, 'ACTION_REQUIRED');
  const t = renderText(r);
  assert.ok(!/Path\s*:\s*OK/.test(t) && t.includes('INTERMEDIATE_REQUIRED'));
});
test('A2: no matching rule is "no known risk in covered rules", never OK/safe, with coverage stated in JSON and text', () => {
  const r = analyze({ dir: simple(), current: 'v2.7.5', target: 'v3.0.0' });
  assert.ok(Object.values(r.families).every(f => f.label === 'NOT_APPLICABLE'));
  assert.equal(r.upgrade_path.status, 'NO_KNOWN_STOP');
  assert.equal(r.assessment.status, 'NO_KNOWN_RISK_IN_COVERED_RULES');
  assert.match(r.assessment.meaning, /not a statement that the upgrade is safe/);
  assert.deepEqual(r.coverage.families, ['F1', 'F2', 'F3', 'F4', 'F5', 'F6']);
  const t = renderText(r);
  assert.ok(t.includes('NO_KNOWN_RISK_IN_COVERED_RULES') && t.includes('not a statement that the upgrade is safe'));
  assert.ok(!/\b(safe to upgrade|upgrade is safe)\b/i.test(t.replace('not a statement that the upgrade is safe', '')));
});
test('A3: overall status precedence: ACTION_REQUIRED over UNKNOWN over ADVISORY', () => {
  const unknown = analyze({ dir: simple(), target: 'v1.137.0' });
  assert.equal(unknown.assessment.status, 'UNKNOWN');
  assert.equal(unknown.upgrade_path.status, 'UNKNOWN');
  const advisory = analyze({ dir: mkProject({ 'docker-compose.yml': compose({ 'immich-server': { image: SERVER }, database: { image: 'docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0' } }) }), current: 'v2.6.3', target: 'v2.7.5' });
  assert.equal(advisory.assessment.status, 'ADVISORY');
});

// ---------- B: basic Compose schema rejection ----------
test('B1: wrong Compose field types are a SCHEMA_ERROR with field and category, exit 2, no values echoed', () => {
  for (const [services, field] of [
    [{ 'immich-server': { image: SERVER, ports: '2283:AUDIT_SECRET_PORT' }, database: { image: PG14 } }, 'services.immich-server.ports'],
    [{ 'immich-server': { image: SERVER }, database: { image: PG14, volumes: { data: 'AUDIT_SECRET_VOL' } } }, 'services.database.volumes'],
  ]) {
    const dir = mkProject({ 'docker-compose.yml': compose(services) });
    const res = cli(dir, '--current', 'v2.7.5', '--target', 'v3.0.0');
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /SCHEMA_ERROR/);
    assert.ok(res.stderr.includes(field), `field ${field} must be named`);
    assert.ok(!(res.stdout + res.stderr).includes('AUDIT_SECRET'), 'values must not be echoed');
    const json = cli(dir, '--current', 'v2.7.5', '--target', 'v3.0.0', '--json');
    assert.equal(json.status, 2);
    const e = JSON.parse(json.stdout).error;
    assert.equal(e.category, 'SCHEMA_ERROR');
    assert.equal(e.field, field);
  }
});
test('B2: valid Compose variants of the consumed fields are accepted', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({
    'immich-server': { image: SERVER, ports: ['2283:2283', 2284, { target: 2283, published: 2285 }], environment: ['TZ=UTC', 'A'], env_file: ['.env', { path: 'x.env', required: false }], command: 'start.sh immich', volumes: ['./a:/a', { type: 'bind', source: './b', target: '/b' }] },
    'immich-machine-learning': { image: 'ghcr.io/immich-app/immich-machine-learning:release', environment: { A: 1, B: null, C: true }, env_file: '.env', command: ['python', 'x'] },
    database: { image: PG14, volumes: ['./pg:/var/lib/postgresql/data'], networks: { default: { aliases: ['db'] } } },
  }), '.env': 'A=1\n' });
  assert.equal(analyze({ dir, current: 'v2.7.5', target: 'v3.0.0' }).tool, 'compose-upgrade-risk-inspector');
});

// ---------- C: version support policy ----------
test('C1: an official git tag without a GitHub release (v1.125.0) is analyzable and flagged as tag-only', () => {
  const r = analyze({ dir: simple(), current: 'v1.125.0', target: 'v1.132.3' });
  assert.ok(r.inputs.notes.some(n => n.includes('v1.125.0') && n.includes('tag')));
});
test('C2: unsupported versions return UNSUPPORTED_VERSION (exit 3) and never a risk report', () => {
  for (const [current, target, why] of [['v1.125.9', 'v1.132.3', 'not an official tag'], ['v3.0.0', 'v9.0.0', 'newer than registry'], ['v1.101.0', 'v1.133.0', 'below researched range']]) {
    const res = cli(simple(), '--current', current, '--target', target, '--json');
    assert.equal(res.status, 3, `${why}: ${res.stdout}${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.error.category, 'UNSUPPORTED_VERSION', why);
    assert.equal(out.families, undefined, 'no risk families may be reported');
  }
  const bad = cli(simple(), '--current', 'v1.2', '--target', 'v3.0.0', '--json');
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).error.category, 'INPUT_ERROR');
});
test('C3: the researched lower boundary v1.102.0 is accepted', () => {
  assert.ok(analyze({ dir: simple(), current: 'v1.102.0', target: 'v1.105.1' }).families);
});

// ---------- D: remediation accuracy ----------
const oldEnv = { SERVER_PORT: '3001', MICROSERVICES_PORT: '3002', MACHINE_LEARNING_PORT: '3003', HOST: '0.0.0.0', MACHINE_LEARNING_HOST: '0.0.0.0' };
const oldProject = () => mkProject({ 'docker-compose.yml': compose({ 'immich-server': { image: SERVER, environment: oldEnv }, database: { image: 'docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0' } }) });
test('D1: crossing v1.106 with HOST set includes the HOST -> IMMICH_HOST transition', () => {
  const f = findings(analyze({ dir: oldProject(), current: 'v1.105.1', target: 'v1.118.0' }));
  const hostSteps = f.filter(x => x.label !== 'UNKNOWN' && x.remediation.subjects.includes('HOST'));
  assert.equal(hostSteps.length, 1, 'exactly one HOST instruction');
  assert.ok(hostSteps[0].remediation.replacements.includes('IMMICH_HOST'));
});
test('D2: crossing v1.106 and v1.119 still yields exactly one HOST instruction (no duplicate or contradiction)', () => {
  const f = findings(analyze({ dir: oldProject(), current: 'v1.105.1', target: 'v1.119.0' }));
  const hostSteps = f.filter(x => x.label !== 'UNKNOWN' && x.remediation.subjects.includes('HOST'));
  assert.equal(hostSteps.length, 1);
  assert.equal(hostSteps[0].rule_id, 'F1-119-host-renamed');
});
const dbAction = image => findings(analyze({ dir: mkProject({ 'docker-compose.yml': compose({ 'immich-server': { image: SERVER }, database: { image } }), '.env': 'PGTAG=pg16-v0.3.0\n' }), current: 'v2.7.5', target: 'v3.0.0' }))
  .find(x => x.rule_id === 'F5-300-no-supported-extension').action;
test('D3: PostgreSQL 16 / pgvecto.rs 0.3.0 gets the exact documented image, never the PostgreSQL 14 default', () => {
  const a = dbAction('docker.io/tensorchord/pgvecto-rs:pg16-v0.3.0');
  assert.ok(a.includes('ghcr.io/immich-app/postgres:16-vectorchord0.3.0-pgvectors0.3.0'), a);
  assert.ok(!a.includes(':14-') && !a.includes('<pg>'), a);
});
test('D4: PostgreSQL 14 / pgvecto.rs 0.2.0 gets the documented default image', () => {
  assert.ok(dbAction('docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0').includes('ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0'));
});
test('D5: an undocumented combination names the components to match and asks for verification, without a concrete tag', () => {
  const a = dbAction('docker.io/tensorchord/pgvecto-rs:pg15-v0.2.0');
  assert.ok(a.includes('PostgreSQL 15') && a.includes('pgvecto.rs 0.2.0') && /verify/i.test(a), a);
  assert.ok(!/postgres:\d+-vectorchord/.test(a), a);
});
test('D6: an interpolated (redacted) tag gets verification guidance and no concrete tag', () => {
  const a = dbAction('docker.io/tensorchord/pgvecto-rs:${PGTAG}');
  assert.ok(/verify/i.test(a) && !/postgres:\d+-vectorchord/.test(a), a);
});

test('B3: other wrong types of consumed fields are SCHEMA_ERRORs naming the field', async () => {
  const { SchemaError } = await import('../src/compose.mjs');
  for (const [svc, field] of [
    [{ image: SERVER, environment: { A: { nested: 'x' } } }, 'services.immich-server.environment.A'],
    [{ image: SERVER, env_file: 42 }, 'services.immich-server.env_file'],
    [{ image: SERVER, command: { a: 1 } }, 'services.immich-server.command'],
    [{ image: SERVER, extends: { file: 'b.yml' } }, 'services.immich-server.extends'],
    [{ image: ['x'] }, 'services.immich-server.image'],
    [{ image: SERVER, networks: { default: { aliases: 'db' } } }, 'services.immich-server.networks.default.aliases'],
  ]) {
    const dir = mkProject({ 'docker-compose.yml': compose({ 'immich-server': svc }) });
    assert.throws(() => analyze({ dir, current: 'v2.7.5', target: 'v3.0.0' }), e => e instanceof SchemaError && e.field === field, field);
  }
  assert.throws(() => analyze({ dir: mkProject({ 'docker-compose.yml': 'services:\n  immich-server: just-a-string\n' }), current: 'v2.7.5', target: 'v3.0.0' }), e => e instanceof SchemaError && e.field === 'services.immich-server');
});
test('C4: an official tag newer than the reviewed range (v3.4.0) is UNSUPPORTED_VERSION', () => {
  const res = cli(simple(), '--current', 'v3.3.6', '--target', 'v3.4.0', '--json');
  assert.equal(res.status, 3);
  assert.match(JSON.parse(res.stdout).error.message, /newer than v3\.4\.0-rc\.3/);
});
test('A4: terminal and JSON agree on result and path status for every development case', async () => {
  const fs = await import('node:fs');
  const { tempDataset } = await import('../tools/score.mjs');
  const ds = tempDataset();
  for (const id of fs.readdirSync(path.join(ds, 'cases'))) {
    const req = JSON.parse(fs.readFileSync(path.join(ds, 'cases', id, 'request.json'), 'utf8'));
    const r = analyze({ dir: path.join(ds, 'cases', id, 'input'), ...req });
    const t = renderText(r);
    assert.ok(t.includes(`Result  : ${r.assessment.status}`) && t.includes(`Path    : ${r.upgrade_path.status}:`), id);
    if (r.upgrade_path.stops.length) assert.equal(r.upgrade_path.status, 'INTERMEDIATE_REQUIRED', id);
    assert.ok(!/\b(OK|SAFE)\b/.test(r.assessment.status + r.upgrade_path.status), id);
  }
});
