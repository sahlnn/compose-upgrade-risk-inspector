// Regression tests for the Codex independent audit (findings C1-C10). Disk-based temp projects only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, InputError } from '../src/engine.mjs';
import { renderText } from '../src/report.mjs';
import { classify, summarize } from '../tools/score.mjs';
import { mkProject } from './helpers.mjs';

const V3 = { current: 'v2.7.5', target: 'v3.0.0' };
const SRV = (env = '', extra = '') => `  immich-server:
    image: ghcr.io/immich-app/immich-server:v2.7.5
${env ? `    environment:\n${env}\n` : ''}${extra}`;
const ids = (r, fam) => r.families[fam].findings.map(f => `${f.rule_id}:${f.label}`);
const both = r => JSON.stringify(r) + renderText(r);

// ---------- C1: database selection ----------
test('C1a: DB_HOSTNAME selects the configured database, not the first postgres-looking service', () => {
  const dir = mkProject({ 'docker-compose.yml': `services:\n${SRV('      DB_HOSTNAME: database')}  aaa:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0\n  database:\n    image: docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0\n` });
  const r = analyze({ dir, ...V3 });
  assert.equal(r.families.F5.label, 'ACTION_REQUIRED');
  assert.ok(r.families.F5.findings[0].config.some(c => c.service === 'database' && c.field === 'image'));
});

test('C1b: external DB_HOSTNAME with an unused local VectorChord service -> UNKNOWN', () => {
  const dir = mkProject({ 'docker-compose.yml': `services:\n${SRV('      DB_HOSTNAME: pg.example.internal')}  spare:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3\n` });
  assert.equal(analyze({ dir, ...V3 }).families.F5.label, 'UNKNOWN');
});

test('C1c: lookalike repository names are not recognised database images', () => {
  const dir = mkProject({ 'docker-compose.yml': `services:\n${SRV()}  database:\n    image: example/pgvector/pgvector-custom:latest\n` });
  const r = analyze({ dir, ...V3 });
  assert.equal(r.families.F5.label, 'UNKNOWN');
});

test('C1d: DB_URL host wins over DB_HOSTNAME; the password never appears in output', () => {
  const dir = mkProject({ 'docker-compose.yml': `services:\n${SRV('      DB_HOSTNAME: database\n      DB_URL: postgresql://immich:AUDIT_DB_PASSWORD@aaa:5432/immich')}  aaa:\n    image: docker.io/tensorchord/pgvecto-rs:pg16-v0.3.0\n  database:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3\n` });
  const r = analyze({ dir, ...V3 });
  assert.equal(r.families.F5.label, 'ACTION_REQUIRED');
  assert.ok(!both(r).includes('AUDIT_DB_PASSWORD'));
});

// ---------- C2: env syntax ----------
test('C2a: quoted value with an inline comment', () => {
  const dir = mkProject({ 'docker-compose.yml': `services:\n${SRV('', '    env_file: [app.env]\n')}  database:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3\n`, 'app.env': 'DB_VECTOR_EXTENSION="pgvecto.rs" # comment\n' });
  assert.deepEqual(ids(analyze({ dir, ...V3 }), 'F6'), ['F6-300-env-pgvectors-rejected:ACTION_REQUIRED']);
});

test('C2b: project .env values are interpolated in order', () => {
  const dir = mkProject({ 'docker-compose.yml': `services:\n${SRV('      DB_VECTOR_EXTENSION: ${EXT}')}  database:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3\n`, '.env': 'BASE=pgvecto.rs\nEXT=${BASE}\n' });
  const f = analyze({ dir, ...V3 }).families.F6.findings;
  assert.deepEqual(f.map(x => `${x.rule_id}:${x.label}`), ['F6-300-env-pgvectors-rejected:ACTION_REQUIRED']);
  assert.equal(f[0].config.find(c => c.field === 'environment.DB_VECTOR_EXTENSION').value, 'pgvecto.rs');
});

test('C2c: env_file format raw is not interpolated', () => {
  const dir = mkProject({ 'docker-compose.yml': `services:\n${SRV('', '    env_file:\n      - path: app.env\n        format: raw\n')}  database:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3\n`, 'app.env': 'DB_VECTOR_EXTENSION=$EXT\n', '.env': 'EXT=pgvecto.rs\n' });
  assert.ok(!ids(analyze({ dir, ...V3 }), 'F6').includes('F6-300-env-pgvectors-rejected:ACTION_REQUIRED'));
});

test('C2d: unknown env_file format is unsupported -> UNKNOWN', () => {
  const dir = mkProject({ 'docker-compose.yml': `services:\n${SRV('', '    env_file:\n      - path: app.env\n        format: yaml\n')}  database:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3\n`, 'app.env': 'X: 1\n' });
  assert.equal(analyze({ dir, ...V3 }).families.F6.label, 'UNKNOWN');
});

// ---------- C3: override / include ----------
test('C3a: an override file makes explicit env and DB image UNKNOWN', () => {
  const dir = mkProject({
    'docker-compose.yml': `services:\n${SRV('      DB_VECTOR_EXTENSION: vectorchord')}  database:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3\n`,
    'compose.override.yaml': 'services:\n  database:\n    image: docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0\n',
  });
  const r = analyze({ dir, ...V3 });
  assert.equal(r.families.F5.label, 'UNKNOWN');
  assert.ok(ids(r, 'F6').includes('F6-300-env-pgvectors-rejected:UNKNOWN'));
});

test('C3b: an ML service that may come from include: keeps ML rules UNKNOWN', () => {
  const dir = mkProject({ 'docker-compose.yml': `include: [ml.yaml]\nservices:\n${SRV()}  database:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3\n`, 'ml.yaml': 'services: {}\n' });
  assert.ok(ids(analyze({ dir, ...V3 }), 'F1').includes('F1-300-preload-clip-removed:UNKNOWN'));
});

// ---------- C4: link containment ----------
function linkOrSkip(t, target, link, type) {
  try { fs.symlinkSync(target, link, type); return true; } catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip(`cannot create ${type} link here (${e.code})`); return false; } throw e; }
}
test('C4a: a directory junction/link leading outside the input is not followed', t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cri-outside-'));
  fs.writeFileSync(path.join(outside, 'app.env'), 'DB_VECTOR_EXTENSION=pgvecto.rs\nSENTINEL=AUDIT_OUTSIDE\n');
  const dir = mkProject({ 'docker-compose.yml': `services:\n${SRV('', '    env_file: [linked/app.env]\n')}  database:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3\n` });
  if (!linkOrSkip(t, outside, path.join(dir, 'linked'), 'junction')) return;
  const r = analyze({ dir, ...V3 });
  assert.ok(!r.inputs.files_read.includes('linked/app.env'));
  assert.ok(r.inputs.missing.some(m => m.includes('linked/app.env') && m.includes('outside')));
  assert.equal(r.families.F6.label, 'UNKNOWN');
});
test('C4b: a file symlink for .env or the compose file is refused', t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cri-outside-'));
  fs.writeFileSync(path.join(outside, 'x.env'), 'A=1\n');
  fs.writeFileSync(path.join(outside, 'c.yml'), `services:\n${SRV()}`);
  const dir = mkProject({ 'docker-compose.yml': `services:\n${SRV()}` });
  if (!linkOrSkip(t, path.join(outside, 'x.env'), path.join(dir, '.env'), 'file')) return;
  assert.throws(() => analyze({ dir, ...V3 }), /outside the input directory/);
  const dir2 = mkProject({});
  if (!linkOrSkip(t, path.join(outside, 'c.yml'), path.join(dir2, 'docker-compose.yml'), 'file')) return;
  assert.throws(() => analyze({ dir: dir2, ...V3 }), InputError);
});

// ---------- C5: oracle ----------
test('C5: UNKNOWN -> ADVISORY / ACTION_REQUIRED are hard-gate failures', () => {
  for (const got of ['ADVISORY', 'ACTION_REQUIRED', 'NOT_APPLICABLE']) {
    assert.equal(summarize([{ id: 'x', strength: 'strong', expected: 'UNKNOWN', got, outcome: classify('UNKNOWN', got) }]).hard_gate_violations.length, 1, got);
  }
});

// ---------- C6: path status ----------
test('C6: an unresolved path risk prevents an unqualified OK path (F4-U1 shape)', () => {
  const dir = mkProject({ 'docker-compose.yml': `services:\n${SRV()}  database:\n    image: docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0\n` });
  const r = analyze({ dir, current: 'v1.130.3', target: 'v1.136.0' });
  assert.equal(r.upgrade_path.status, 'UNKNOWN');
  assert.deepEqual(r.upgrade_path.advisory_stops.map(s => s.version), ['v1.132.3']);
  assert.match(renderText(r), /v1\.132\.3/);
});

// ---------- C7: IMMICH_PORT ----------
test('C7: port advice respects the effective IMMICH_PORT', () => {
  const run = env => analyze({ dir: mkProject({ 'docker-compose.yml': `services:\n${SRV(env, "    ports: ['2283:3001']\n")}` }), current: 'v1.117.0', target: 'v1.118.0' }).families.F2;
  assert.equal(run('      IMMICH_PORT: "3001"').label, 'NOT_APPLICABLE');
  assert.equal(run('      IMMICH_PORT: ${PORT_FROM_SHELL}').label, 'UNKNOWN');
  assert.equal(run('      TZ: UTC').label, 'ACTION_REQUIRED');
});

// ---------- C8: commands ----------
test('C8: unresolved fragments never manufacture a command match; text mentions are not invocations', () => {
  const run = cmd => analyze({ dir: mkProject({ 'docker-compose.yml': `services:\n${SRV('', `    command: ${cmd}\n`)}` }), current: 'v1.117.0', target: 'v1.118.0' }).families.F2;
  assert.equal(run('start.${UNRESOLVED}sh immich').label, 'UNKNOWN');
  assert.equal(run('["echo", "start.sh microservices moved"]').label, 'NOT_APPLICABLE');
  assert.equal(run(`sh -c 'start.sh immich'`).label, 'UNKNOWN');
  assert.equal(run('["start.sh", "immich"]').label, 'ACTION_REQUIRED');
  assert.equal(run('start.sh ${MODE}').label, 'ACTION_REQUIRED', 'start.sh itself is removed whatever MODE is');
});

// ---------- C9: redaction ----------
test('C9: command contents, matched env values and DB_URL credentials are not printed', () => {
  const dir = mkProject({
    'docker-compose.yml': `services:\n${SRV('      IMMICH_METRICS: AUDIT_TOKEN_VALUE', "    command: [\"start.sh\", \"immich\", \"--password=AUDIT_SECRET\"]\n")}  database:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3\n    command: postgres -c password=AUDIT_DB_SECRET -c shared_preload_libraries=vectors.so\n`,
  });
  for (const req of [{ current: 'v1.117.0', target: 'v1.119.0' }, V3]) {
    const out = both(analyze({ dir, ...req }));
    for (const s of ['AUDIT_SECRET', 'AUDIT_DB_SECRET', 'AUDIT_TOKEN_VALUE']) assert.ok(!out.includes(s), `${s} leaked for ${req.target}`);
  }
});

// ---------- C10: build-only ----------
test('C10: a build-only service does not crash the analysis', () => {
  const dir = mkProject({ 'docker-compose.yml': `services:\n${SRV()}  database:\n    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3\n  sidecar:\n    build: .\n` });
  const r = analyze({ dir, ...V3 });
  assert.ok(r.inputs.unsupported.some(u => u.includes('sidecar')));
  assert.ok(r.families.F1);
});
