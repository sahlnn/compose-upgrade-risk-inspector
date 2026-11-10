// Regression tests for the second Codex audit (Phase 1.2): H1 extends env, H2 multi-server port, H3 leaks, P3 gaps.
// Repros were rebuilt from the audit summary (the full report text was not available here). Disk-based temp projects only.
import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { analyze } from '../src/engine.mjs';
import { renderText } from '../src/report.mjs';
import { mkProject } from './helpers.mjs';

const V3 = { current: 'v2.7.5', target: 'v3.0.0' };
const PG = 'ghcr.io/immich-app/postgres:14-vectorchord0.4.3';
const SERVER = 'ghcr.io/immich-app/immich-server:release';
const compose = services => YAML.stringify({ services });
const finding = (r, id) => Object.values(r.families).flatMap(f => f.findings).find(f => f.rule_id === id);

// ---------- H1: inherited environment via extends ----------
test('H1a: extends base environment may override a local env_file value -> UNKNOWN, not NOT_APPLICABLE', () => {
  const dir = mkProject({
    'docker-compose.yml': compose({ 'immich-server': { extends: { file: 'base.yml', service: 'immich-server' }, image: SERVER, env_file: ['app.env'] }, database: { image: PG } }),
    'base.yml': compose({ 'immich-server': { environment: { DB_VECTOR_EXTENSION: 'pgvecto.rs' } } }),
    'app.env': 'DB_VECTOR_EXTENSION=vectorchord\n',
  });
  assert.equal(finding(analyze({ dir, ...V3 }), 'F6-300-env-pgvectors-rejected')?.label, 'UNKNOWN');
});
test('H1b: a local env_file match is not certain either when a base may override it', () => {
  const dir = mkProject({
    'docker-compose.yml': compose({ 'immich-server': { extends: { file: 'base.yml', service: 'immich-server' }, image: SERVER, env_file: ['app.env'] }, database: { image: PG } }),
    'base.yml': compose({ 'immich-server': { environment: { DB_VECTOR_EXTENSION: 'vectorchord' } } }),
    'app.env': 'DB_VECTOR_EXTENSION=pgvecto.rs\n',
  });
  assert.equal(finding(analyze({ dir, ...V3 }), 'F6-300-env-pgvectors-rejected')?.label, 'UNKNOWN');
});
test('H1c: a local `environment:` value stays certain under extends (local environment wins)', () => {
  const dir = mkProject({
    'docker-compose.yml': compose({ 'immich-server': { extends: { file: 'base.yml', service: 'immich-server' }, image: SERVER, environment: { DB_VECTOR_EXTENSION: 'pgvecto.rs' } }, database: { image: PG } }),
    'base.yml': compose({ 'immich-server': { environment: { DB_VECTOR_EXTENSION: 'vectorchord' } } }),
  });
  assert.equal(finding(analyze({ dir, ...V3 }), 'F6-300-env-pgvectors-rejected')?.label, 'ACTION_REQUIRED');
});

// ---------- H2: port and IMMICH_PORT are judged per service ----------
test('H2: IMMICH_PORT on one server service cannot suppress the port warning of another', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({
    'immich-server': { image: SERVER, ports: ['2283:3001'] },
    'immich-server-b': { image: SERVER, environment: { IMMICH_PORT: '3001' }, ports: ['2284:3001'] },
  }) });
  const f = finding(analyze({ dir, current: 'v1.117.0', target: 'v1.118.0' }), 'F2-118-port-alignment');
  assert.equal(f?.label, 'ACTION_REQUIRED');
  assert.deepEqual(f.config.filter(c => c.field === 'ports').map(c => c.service), ['immich-server']);
});

// ---------- H3: no secret leaks through unsupported syntax or raw specs ----------
test('H3: nested/unclosed interpolation and port defaults never echo their contents', () => {
  const dir = mkProject({
    'docker-compose.yml': compose({
      'immich-server': {
        image: SERVER,
        environment: { DB_VECTOR_EXTENSION: '${A:-${B:-AUDIT_NESTED_SECRET}}', IMMICH_MEDIA_LOCATION: '${AUDIT_UNCLOSED_SECRET' },
        ports: ['${P:-AUDIT_PORT_SECRET}:3001'],
      },
      database: { image: PG, command: 'postgres -c x=${Q:-${R:-AUDIT_CMD_SECRET}} -c shared_preload_libraries=vectors.so' },
    }),
  });
  for (const req of [V3, { current: 'v1.117.0', target: 'v1.118.0' }, { current: 'v1.135.3', target: 'v1.136.0' }]) {
    const r = analyze({ dir, ...req });
    const out = JSON.stringify(r) + renderText(r);
    for (const s of ['AUDIT_NESTED_SECRET', 'AUDIT_UNCLOSED_SECRET', 'AUDIT_PORT_SECRET', 'AUDIT_CMD_SECRET']) assert.ok(!out.includes(s), `${s} leaked for ${req.target}`);
  }
  // The location and kind of the problem are still reported.
  const r = analyze({ dir, ...V3 });
  assert.ok(finding(r, 'F6-300-env-pgvectors-rejected').missing_inputs.some(m => m.includes('unsupported interpolation') && m.includes('DB_VECTOR_EXTENSION')));
});

// ---------- P3: retained uncertainty and DB network indirection ----------
test('P3a: a certain finding on one service keeps the UNKNOWN of another service visible', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({
    'immich-server': { image: SERVER, command: ['start.sh', 'immich'] },
    'immich-worker': { image: SERVER, extends: { file: 'gone.yml', service: 'w' } },
  }) });
  const f = finding(analyze({ dir, current: 'v1.117.0', target: 'v1.118.0' }), 'F2-118-start-sh-removed');
  assert.equal(f.label, 'ACTION_REQUIRED');
  assert.ok(f.missing_inputs.some(m => m.includes('immich-worker')), 'the unchecked service must still be reported');
});
test('P3b: links / extra_hosts on the server make the database service UNKNOWN', () => {
  for (const extra of [{ links: ['pg:database'] }, { extra_hosts: ['database:10.0.0.5'] }, { network_mode: 'host' }]) {
    const dir = mkProject({ 'docker-compose.yml': compose({ 'immich-server': { image: SERVER, ...extra }, pg: { image: 'docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0' }, database: { image: PG } }) });
    assert.equal(analyze({ dir, ...V3 }).families.F5.label, 'UNKNOWN', JSON.stringify(extra));
  }
});

test('P3c: a profile-gated service is not treated as certainly active', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({ 'immich-server': { image: SERVER }, database: { image: 'docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0', profiles: ['legacy'] } }) });
  assert.equal(analyze({ dir, ...V3 }).families.F5.label, 'UNKNOWN');
});
