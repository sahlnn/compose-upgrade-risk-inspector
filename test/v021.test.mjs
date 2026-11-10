// v0.2.1 POST-AUDIT DEVELOPMENT REGRESSIONS. Written in this project from the five findings of the independent
// Codex audit after v0.2; synthetic inputs only. They are NOT blind cases and are not an independent evaluation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { analyze, DEFAULTS } from '../src/engine.mjs';
import { parseVersion, loadKnownVersions } from '../src/version.mjs';
import { loadRules } from '../src/rules.mjs';
import { renderText } from '../src/report.mjs';
import { mkProject } from './helpers.mjs';

const CLI = path.resolve('bin/cri.mjs');
const SERVER = 'ghcr.io/immich-app/immich-server:release';
const MLIMG = 'ghcr.io/immich-app/immich-machine-learning:release';
const PG14 = 'ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0';
const S = 'immich-server', ML = 'immich-machine-learning';
const IH = 'IMMICH_HOST';
const compose = services => YAML.stringify({ services });
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const findings = r => Object.values(r.families).flatMap(f => f.findings);
const envText = env => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
// Server and ML both read one shared env file (the layout of the official compose example).
const shared = (env, extraServer = {}) => mkProject({
  'docker-compose.yml': compose({ [S]: { image: SERVER, env_file: ['.env'], ...extraServer }, [ML]: { image: MLIMG, env_file: ['.env'] }, database: { image: PG14 } }),
  '.env': envText(env),
});
// Service-specific `environment:` blocks.
const scoped = (serverEnv, mlEnv) => mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER, environment: serverEnv }, ...(mlEnv ? { [ML]: { image: MLIMG, environment: mlEnv } } : {}), database: { image: PG14 } }) });
// Certain instructions that write IMMICH_HOST by plain copy (rename/duplicate).
const plainHost = r => findings(r).filter(f => f.label !== 'UNKNOWN' && ['rename_env', 'duplicate_env'].includes(f.remediation.op) && f.remediation.replacements.includes(IH));
const conflictHost = r => findings(r).filter(f => f.remediation.op === 'resolve_env_conflict' && f.remediation.replacements.includes(IH));
const servicesOf = f => [...new Set(f.config.map(c => c.service).filter(Boolean))].sort();
const noValues = (r, ...values) => {
  const out = JSON.stringify(r) + renderText(r);
  for (const v of values) assert.ok(!out.includes(v), `value ${v} must not be echoed`);
};

// ---------- 1 (HIGH): HOST / IMMICH_HOST collision safety ----------
test('H1: shared .env with HOST and MACHINE_LEARNING_HOST of different values (v1.105.1 -> v1.119.0) gives a collision diagnostic, never two IMMICH_HOST values', () => {
  const r = analyze({ dir: shared({ HOST: '0.0.0.0', MACHINE_LEARNING_HOST: '127.0.0.1' }), current: 'v1.105.1', target: 'v1.119.0' });
  assert.deepEqual(plainHost(r), [], 'no plain rename/duplicate into IMMICH_HOST may remain');
  const c = conflictHost(r);
  assert.ok(c.length >= 1, 'a collision diagnostic is required');
  for (const f of c) {
    assert.equal(f.label, 'ACTION_REQUIRED');
    const k = f.conflicts.find(x => x.destination === IH);
    assert.equal(k.reason, 'different_values');
    assert.deepEqual(k.services, [ML, S]); // sorted
    assert.ok(k.locations.includes('.env'));
  }
  assert.deepEqual(c.flatMap(f => f.remediation.subjects).sort(), ['HOST', 'MACHINE_LEARNING_HOST']);
  assert.equal(r.families.F1.label, 'ACTION_REQUIRED');
  assert.ok(renderText(r).includes(`conflict: ${IH}`));
  noValues(r, '127.0.0.1', '0.0.0.0');
});
test('H1b: the same shared .env before v1.119 (v1.105.1 -> v1.118.0): the ML rename and the server HOST transition do not both write IMMICH_HOST', () => {
  const r = analyze({ dir: shared({ HOST: '0.0.0.0', MACHINE_LEARNING_HOST: '127.0.0.1' }), current: 'v1.105.1', target: 'v1.118.0' });
  assert.deepEqual(plainHost(r), []);
  const byRule = Object.fromEntries(conflictHost(r).map(f => [f.rule_id, f.label]));
  assert.deepEqual(byRule, { 'F1-106-host-transition': 'ADVISORY', 'F1-106-ml-host-renamed': 'ACTION_REQUIRED' });
});
test('H2: an existing IMMICH_HOST that differs from HOST is never silently overwritten (at v1.119)', () => {
  const r = analyze({ dir: scoped({ HOST: '0.0.0.0', IMMICH_HOST: '127.0.0.1' }), current: 'v1.118.2', target: 'v1.119.0' });
  assert.deepEqual(plainHost(r), []);
  const [f] = conflictHost(r);
  assert.equal(f.rule_id, 'F1-119-host-renamed');
  assert.equal(f.label, 'ACTION_REQUIRED');
  assert.equal(f.conflicts[0].reason, 'existing_value_differs');
  assert.deepEqual(f.conflicts[0].services, [S]);
  noValues(r, '127.0.0.1');
});
test('H2b: an existing, different IMMICH_HOST before v1.119 (v1.105.1 -> v1.118.0): the transition advisory does not overwrite it', () => {
  const r = analyze({ dir: scoped({ HOST: '0.0.0.0', IMMICH_HOST: '127.0.0.1' }), current: 'v1.105.1', target: 'v1.118.0' });
  assert.deepEqual(plainHost(r), []);
  const [f] = conflictHost(r);
  assert.equal(f.rule_id, 'F1-106-host-transition');
  assert.equal(f.label, 'ADVISORY');
  assert.equal(f.conflicts[0].reason, 'existing_value_differs');
});
test('H2c: an existing IMMICH_HOST in a shared .env that differs from HOST (v1.118.2 -> v1.119.0) is a collision', () => {
  const r = analyze({ dir: shared({ HOST: '0.0.0.0', IMMICH_HOST: '127.0.0.1' }), current: 'v1.118.2', target: 'v1.119.0' });
  assert.deepEqual(plainHost(r), []);
  assert.equal(conflictHost(r)[0].conflicts[0].reason, 'existing_value_differs');
});
test('H2d: an IMMICH_HOST whose value cannot be resolved makes the collision check UNKNOWN, with verification guidance', () => {
  const r = analyze({ dir: scoped({ HOST: '0.0.0.0', IMMICH_HOST: '${BIND_ADDR}' }), current: 'v1.118.2', target: 'v1.119.0' });
  assert.deepEqual(plainHost(r), []);
  const [f] = conflictHost(r);
  assert.equal(f.label, 'UNKNOWN');
  assert.equal(f.conflicts[0].reason, 'unresolved_value');
  assert.match(f.action, /[Vv]erify/);
  assert.ok(f.missing_inputs.some(m => m.includes('BIND_ADDR')));
});
test('H3: equal source and destination values need no collision handling', () => {
  const a = analyze({ dir: shared({ HOST: '0.0.0.0', MACHINE_LEARNING_HOST: '0.0.0.0' }), current: 'v1.105.1', target: 'v1.119.0' });
  assert.deepEqual(conflictHost(a), []);
  assert.deepEqual(plainHost(a).map(f => f.rule_id).sort(), ['F1-106-ml-host-renamed', 'F1-119-host-renamed']);
  const b = analyze({ dir: scoped({ HOST: '0.0.0.0', IMMICH_HOST: '0.0.0.0' }), current: 'v1.118.2', target: 'v1.119.0' });
  assert.deepEqual(conflictHost(b), []);
  assert.deepEqual(plainHost(b).map(f => f.rule_id), ['F1-119-host-renamed']);
});
test('H4: only one legacy variable present gives exactly one plain instruction, on the service that reads it', () => {
  const a = analyze({ dir: scoped({ HOST: '0.0.0.0' }, { TZ: 'UTC' }), current: 'v1.118.2', target: 'v1.119.0' });
  assert.deepEqual(plainHost(a).map(f => [f.rule_id, servicesOf(f)]), [['F1-119-host-renamed', [S]]]);
  const b = analyze({ dir: scoped({ TZ: 'UTC' }, { MACHINE_LEARNING_HOST: '0.0.0.0' }), current: 'v1.105.1', target: 'v1.106.1' });
  assert.deepEqual(plainHost(b).map(f => [f.rule_id, servicesOf(f)]), [['F1-106-ml-host-renamed', [ML]]]);
  assert.deepEqual(conflictHost(a).concat(conflictHost(b)), []);
});
test('H5: different server and ML scopes (service-specific environment:) are renamed independently, without a collision', () => {
  const r = analyze({ dir: scoped({ HOST: '0.0.0.0' }, { MACHINE_LEARNING_HOST: '127.0.0.1' }), current: 'v1.105.1', target: 'v1.119.0' });
  assert.deepEqual(conflictHost(r), []);
  assert.deepEqual(plainHost(r).map(f => [f.rule_id, servicesOf(f)]).sort(), [['F1-106-ml-host-renamed', [ML]], ['F1-119-host-renamed', [S]]]);
});
test('H6: MACHINE_LEARNING_HOST in the server container is not turned into the server IMMICH_HOST (server vs ML semantics)', () => {
  const r = analyze({ dir: scoped({ HOST: '0.0.0.0', MACHINE_LEARNING_HOST: '127.0.0.1' }), current: 'v1.105.1', target: 'v1.119.0' });
  assert.deepEqual(plainHost(r).map(f => [f.rule_id, f.remediation.subjects, servicesOf(f)]), [['F1-119-host-renamed', ['HOST'], [S]]]);
  assert.ok(!findings(r).some(f => f.label !== 'UNKNOWN' && f.remediation.subjects.includes('MACHINE_LEARNING_HOST')));
});
// Expectation changed in v0.2.2: the shared reader without its own value is no longer only listed as unchecked next to
// an unconditional rename; the rename becomes conditional (reaches_other_service), see CHANGELOG.md (0.2.2).
test('H7: shared .env, HOST only: the server finding stays, but the write is conditional because it also reaches the ML service', () => {
  const r = analyze({ dir: shared({ HOST: '0.0.0.0' }), current: 'v1.118.2', target: 'v1.119.0' });
  assert.deepEqual(plainHost(r), []);
  const [f] = conflictHost(r);
  assert.equal(f.rule_id, 'F1-119-host-renamed');
  assert.deepEqual(servicesOf(f), [S]);
  assert.deepEqual([f.label, f.conflicts[0].reason, f.conflicts[0].services], ['UNKNOWN', 'reaches_other_service', [ML, S]]);
  assert.ok(f.missing_inputs.some(m => m.includes(IH) && m.includes(ML) && m.includes('.env')), f.missing_inputs.join(' | '));
});
test('H8: an IMMICH_HOST set in the ML service environment: is not affected by renaming HOST in a shared .env (no false collision)', () => {
  const dir = mkProject({
    'docker-compose.yml': compose({ [S]: { image: SERVER, env_file: ['.env'] }, [ML]: { image: MLIMG, env_file: ['.env'], environment: { IMMICH_HOST: '127.0.0.1' } }, database: { image: PG14 } }),
    '.env': envText({ HOST: '0.0.0.0' }),
  });
  const r = analyze({ dir, current: 'v1.118.2', target: 'v1.119.0' });
  assert.deepEqual(conflictHost(r), []);
  assert.deepEqual(plainHost(r).map(f => f.rule_id), ['F1-119-host-renamed']);
});
test('H9: the Codex scenario through the CLI: JSON and terminal agree, deterministic, no contradictory IMMICH_HOST instructions', () => {
  const dir = shared({ HOST: '0.0.0.0', MACHINE_LEARNING_HOST: '127.0.0.1' });
  const j1 = run('analyze', dir, '--current', 'v1.105.1', '--target', 'v1.119.0', '--json');
  const j2 = run('analyze', dir, '--current', 'v1.105.1', '--target', 'v1.119.0', '--json');
  const t = run('analyze', dir, '--current', 'v1.105.1', '--target', 'v1.119.0');
  assert.equal(j1.status, 0);
  assert.equal(j1.stdout, j2.stdout, 'deterministic');
  const r = JSON.parse(j1.stdout);
  for (const f of findings(r)) assert.ok(t.stdout.includes(f.action), `terminal shows ${f.rule_id}`);
  const actions = findings(r).filter(f => f.label !== 'UNKNOWN').map(f => f.action).join('\n');
  assert.ok(!/Rename (HOST|MACHINE_LEARNING_HOST) to IMMICH_HOST/.test(actions), actions);
});
test('H10: shared .env with different legacy port values: the same guard prevents two IMMICH_PORT values', () => {
  const r = analyze({ dir: shared({ SERVER_PORT: '3001', MACHINE_LEARNING_PORT: '3003' }), current: 'v1.105.1', target: 'v1.106.1' });
  const f = findings(r).find(x => x.rule_id === 'F1-106-port-host-renamed');
  assert.equal(f.remediation.op, 'resolve_env_conflict');
  assert.deepEqual(f.remediation.replacements, ['IMMICH_PORT']);
  assert.equal(f.conflicts[0].reason, 'different_values');
});

// ---------- 2 (MEDIUM): nested Compose schema ----------
test('S1: malformed nested Compose fields are SCHEMA_ERRORs naming the field, never the value', async () => {
  const { SchemaError } = await import('../src/compose.mjs');
  const f = k => `services.${S}.${k}`;
  for (const [svc, field] of [
    [{ ports: [{ published: 2283 }] }, f('ports[0].target')],
    [{ ports: [{ target: { a: 'AUDIT_SECRET' } }] }, f('ports[0].target')],
    [{ ports: [{ target: 2283.5 }] }, f('ports[0].target')],
    [{ ports: [{ target: 2283, published: { x: 'AUDIT_SECRET' } }] }, f('ports[0].published')],
    [{ ports: [{ target: 2283, protocol: 6 }] }, f('ports[0].protocol')],
    [{ ports: [{ target: 2283, host_ip: ['AUDIT_SECRET'] }] }, f('ports[0].host_ip')],
    [{ ports: [{ target: 2283, mode: true }] }, f('ports[0].mode')],
    [{ volumes: [{ type: 'bind', source: './a', target: { path: 'AUDIT_SECRET' } }] }, f('volumes[0].target')],
    [{ volumes: [{ type: 'bind', source: './a' }] }, f('volumes[0].target')],
    [{ volumes: [{ type: 'bind', source: ['AUDIT_SECRET'], target: '/a' }] }, f('volumes[0].source')],
    [{ volumes: [{ type: 7, target: '/a' }] }, f('volumes[0].type')],
    [{ env_file: [{ path: '.env', required: 'false' }] }, f('env_file[0].required')],
    [{ env_file: [{ path: '.env', format: 42 }] }, f('env_file[0].format')],
    [{ env_file: [{ path: '.env', format: ['raw'] }] }, f('env_file[0].format')],
  ]) {
    const dir = mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER, ...svc } }), '.env': 'A=1\n' });
    assert.throws(() => analyze({ dir, current: 'v2.7.5', target: 'v3.0.0' }), e => e instanceof SchemaError && e.field === field && !e.message.includes('AUDIT_SECRET'), field);
  }
});
test('S2: a nested schema error through the CLI exits 2 with SCHEMA_ERROR and the field, text and JSON, no value', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER, env_file: [{ path: '.env', required: 'AUDIT_SECRET' }] } }), '.env': 'A=1\n' });
  const t = run('analyze', dir, '--current', 'v2.7.5', '--target', 'v3.0.0');
  assert.equal(t.status, 2);
  assert.match(t.stderr, /SCHEMA_ERROR/);
  assert.ok(t.stderr.includes(`services.${S}.env_file[0].required`));
  const j = run('analyze', dir, '--current', 'v2.7.5', '--target', 'v3.0.0', '--json');
  assert.equal(j.status, 2);
  const out = JSON.parse(j.stdout);
  assert.deepEqual([out.error.category, out.error.field, out.families], ['SCHEMA_ERROR', `services.${S}.env_file[0].required`, undefined]);
  assert.ok(!(t.stdout + t.stderr + j.stdout + j.stderr).includes('AUDIT_SECRET'));
});
test('S3: valid short and long forms of the consumed nested fields are still accepted', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({
    [S]: { image: SERVER,
      ports: ['2283:2283', '127.0.0.1:8080:80/tcp', '8000-8001:8000-8001', 2284, { target: 2283, published: 2285 }, { target: '2283', published: '2286', protocol: 'tcp', mode: 'host', host_ip: '127.0.0.1', name: 'web' }, { target: '${PORT}' }],
      volumes: ['./a:/a:ro', { type: 'bind', source: './b', target: '/b', read_only: true }, { type: 'tmpfs', target: '/tmp' }, { type: 'volume', source: 'data', target: '/data' }],
      env_file: ['.env', { path: '.env', required: true }, { path: 'opt.env', required: false }, { path: 'raw.env', format: 'raw', required: false }] },
  }), '.env': 'PORT=3001\n' });
  const r = analyze({ dir, current: 'v2.7.5', target: 'v3.0.0' });
  assert.equal(r.tool, 'compose-upgrade-risk-inspector');
});

// ---------- 3 (MEDIUM): JSON error contract ----------
const isStack = s => /\n\s+at .+[:(]/.test(s) || /ReferenceError|TypeError/.test(s);
test('J1: an undefined YAML alias is a controlled INPUT_ERROR (exit 2), text and JSON, without a stack trace or the alias name', () => {
  const dir = mkProject({ 'docker-compose.yml': 'services: {app: *AUDIT_SECRET_ALIAS}\n' });
  const t = run('analyze', dir, '--current', 'v2.7.5', '--target', 'v3.0.0');
  assert.equal(t.status, 2, t.stderr);
  assert.match(t.stderr, /^error \[INPUT_ERROR\]/);
  assert.ok(!isStack(t.stderr) && !t.stderr.includes('AUDIT_SECRET'), t.stderr);
  const j = run('analyze', dir, '--current', 'v2.7.5', '--target', 'v3.0.0', '--json');
  assert.equal(j.status, 2);
  assert.equal(j.stderr, '');
  const out = JSON.parse(j.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['error', 'schema', 'tool']);
  assert.equal(out.error.category, 'INPUT_ERROR');
  assert.ok(!j.stdout.includes('AUDIT_SECRET'));
});
test('J2: an alias bomb over the alias limit is a controlled INPUT_ERROR', () => {
  const lines = ['x0: &a0 [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]'];
  for (let i = 1; i < 6; i++) lines.push(`x${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]`);
  const dir = mkProject({ 'docker-compose.yml': `${lines.join('\n')}\nservices: {app: {image: x}}\n` });
  const j = run('analyze', dir, '--current', 'v2.7.5', '--target', 'v3.0.0', '--json');
  assert.equal(j.status, 2, j.stderr);
  assert.equal(JSON.parse(j.stdout).error.category, 'INPUT_ERROR');
});
test('J3: an unknown option with --json returns the structured JSON error (exit 2), without echoing the option', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER } }) });
  for (const args of [['analyze', dir, '--json', '--wat'], ['analyze', dir, '--json', '--AUDIT_SECRET'], ['analyze', '--AUDIT_SECRET=x', dir, '--json'], ['analyze', dir, '--json', '--target']]) {
    const j = run(...args);
    assert.equal(j.status, 2, args.join(' '));
    assert.equal(j.stderr, '', args.join(' '));
    const out = JSON.parse(j.stdout);
    assert.equal(out.error.category, 'INPUT_ERROR');
    assert.equal(out.families, undefined);
    assert.ok(!j.stdout.includes('AUDIT_SECRET') && !j.stdout.includes('wat'), j.stdout);
  }
  const t = run('analyze', dir, '--AUDIT_SECRET');
  assert.equal(t.status, 2);
  assert.match(t.stderr, /^error \[INPUT_ERROR\]/);
  assert.ok(!t.stderr.includes('AUDIT_SECRET') && t.stdout === '');
});
test('J4: exit codes and error shape are preserved: unsupported version 3, input error 2, no partial report', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER } }) });
  const u = run('analyze', dir, '--current', 'v1.125.9', '--target', 'v1.132.3', '--json');
  assert.equal(u.status, 3);
  const e = JSON.parse(u.stdout);
  assert.deepEqual([e.tool, e.schema, e.error.category, e.families, e.assessment], ['compose-upgrade-risk-inspector', 3, 'UNSUPPORTED_VERSION', undefined, undefined]);
  const i = run('analyze', dir, '--target', 'v3.0.0', '--current', 'v3.0.0', '--json');
  assert.equal(i.status, 2);
  assert.equal(JSON.parse(i.stdout).error.category, 'INPUT_ERROR');
  const missing = run('analyze', '--json');
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).error.category, 'INPUT_ERROR');
});

// ---------- 4 (MEDIUM): diagnostic information disclosure ----------
const CANARY = 'AUDITSECRET';
test('R1: CLI errors never echo user-supplied canary values (versions, commands, options, paths), but keep the category and field', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER } }) });
  const missingDir = path.join(os.tmpdir(), `cri-${CANARY}-does-not-exist`);
  for (const [args, category, code] of [
    [['analyze', dir, '--current', `v${CANARY}`, '--target', 'v3.0.0'], 'INPUT_ERROR', 2],
    [['analyze', dir, '--target', CANARY], 'INPUT_ERROR', 2],
    [['analyze', dir, '--current', 'v2.7.5', '--target', `v3.0.0-${CANARY}`], 'UNSUPPORTED_VERSION', 3],
    [['analyze', dir, '--current', `v1.125.0-${CANARY}.1`, '--target', 'v3.0.0'], 'UNSUPPORTED_VERSION', 3],
    [['analyze', dir, '--current', 'v2.7.5', '--target', `v9.0.0-${CANARY}`], 'UNSUPPORTED_VERSION', 3],
    [['analyze', dir, '--current', `v1.0.0-${CANARY}`, '--target', 'v3.0.0'], 'UNSUPPORTED_VERSION', 3],
    [[CANARY], 'INPUT_ERROR', 2],
    [['analyze', dir, `--${CANARY}`], 'INPUT_ERROR', 2],
    [['analyze', missingDir, '--target', 'v3.0.0'], 'INPUT_ERROR', 2],
  ]) {
    for (const json of [false, true]) {
      const res = run(...args, ...(json ? ['--json'] : []));
      const all = res.stdout + res.stderr;
      assert.equal(res.status, code, `${args.join(' ')}: ${all}`);
      assert.ok(!all.includes(CANARY), `${args.join(' ')} echoed the canary: ${all}`);
      assert.ok(!isStack(all), all);
      const cat = json ? JSON.parse(res.stdout).error.category : /error \[(\w+)\]/.exec(res.stderr)?.[1];
      assert.equal(cat, category, args.join(' '));
    }
  }
  const v = JSON.parse(run('analyze', dir, '--current', `v${CANARY}`, '--target', 'v3.0.0', '--json').stdout).error;
  assert.equal(v.field, '--current', 'the field stays identifiable');
});
test('R2: unsupported env_file.format values and unparsable .env lines are reported without their values', () => {
  const dir = mkProject({
    'docker-compose.yml': compose({ [S]: { image: SERVER, env_file: [{ path: 'svc.env', format: CANARY }] }, database: { image: PG14 } }),
    'svc.env': 'A=1\n', '.env': `${CANARY} without an equals sign\nB=2\n`,
  });
  const r = analyze({ dir, current: 'v2.7.5', target: 'v3.0.0' });
  const out = JSON.stringify(r) + renderText(r);
  assert.ok(!out.includes(CANARY), out);
  assert.ok(r.inputs.unsupported.some(u => u.includes('svc.env') && u.includes('format')), 'the file and the problem stay identifiable');
  assert.ok(r.inputs.unsupported.some(u => u.startsWith('.env: unparsable lines 1')));
});
test('R3: Compose YAML parser errors name the problem and position, never the offending text', () => {
  for (const text of [`services:\n  a: [${CANARY}\n`, `services:\n  ${CANARY}: {image: x}\n  ${CANARY}: {image: y}\n`, `services:\n  a: "${CANARY}\n`, `services:\n\t${CANARY}: 1\n`]) {
    const dir = mkProject({ 'docker-compose.yml': text });
    for (const json of [false, true]) {
      const res = run('analyze', dir, '--current', 'v2.7.5', '--target', 'v3.0.0', ...(json ? ['--json'] : []));
      assert.equal(res.status, 2, res.stdout + res.stderr);
      const msg = json ? JSON.parse(res.stdout).error.message : res.stderr;
      assert.ok(!msg.includes(CANARY), msg);
      assert.match(msg, /invalid YAML/);
      assert.match(msg, /line \d+/);
    }
  }
});

// ---------- 5 (LOW): SemVer and documentation ----------
test('V1: malformed prerelease identifiers are rejected, valid ones are kept', () => {
  for (const bad of ['v1.125.0-..', 'v1.125.0-', 'v1.125.0-rc..1', 'v1.125.0-rc.', 'v1.125.0-.rc', 'v1.125.0-rc.01', 'v1.125.0-00', 'v1.125.0-rc_1']) assert.equal(parseVersion(bad), null, bad);
  for (const good of ['v3.4.0-rc.3', 'v1.0.0-0', 'v1.0.0-alpha-1', 'v1.0.0-x.7.z.92', 'v1.0.0-0a', 'v1.0.0--']) assert.ok(parseVersion(good), good);
  const res = run('analyze', mkProject({ 'docker-compose.yml': compose({ [S]: { image: SERVER } }) }), '--current', 'v1.125.0-..', '--target', 'v1.132.3', '--json');
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stdout).error.category, 'INPUT_ERROR');
});
test('V2: the stricter grammar keeps every registry entry the v0.2 grammar accepted', () => {
  const v02 = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/; // the v0.2 regex, for comparison only
  for (const f of [DEFAULTS.versionsFile, DEFAULTS.tagsFile]) {
    const lines = fs.readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(l => v02.test(l));
    assert.equal(loadKnownVersions(f).size, new Set(lines).size, f);
  }
});
test('V3: README states the actual rule counts, exit codes, error shape and registries', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const { rules, constraints } = loadRules(DEFAULTS.rulesFile, DEFAULTS.evidenceFile);
  assert.ok(readme.includes(`${rules.length} rules + ${constraints.length} path constraints`), 'rule counts');
  assert.ok(!/19 rules/.test(readme));
  assert.ok(!/Exit code `2` means invalid input: bad YAML, an unknown or invalid version/.test(readme), 'outdated exit-code text');
  assert.ok(readme.includes('{"tool": "compose-upgrade-risk-inspector", "schema": 3, "error": {"category"'), 'actual JSON error shape');
  assert.ok(readme.includes('immich-git-tags.txt') && /does not establish that a Docker image/i.test(readme));
});
