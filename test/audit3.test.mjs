// Regression tests for the third Codex audit (Phase 1.3). Disk-based temp projects only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { analyze, DEFAULTS } from '../src/engine.mjs';
import { loadRules, RuleError } from '../src/rules.mjs';
import { loadKnownVersions } from '../src/version.mjs';
import { renderText } from '../src/report.mjs';
import { mkProject } from './helpers.mjs';

const V3 = { current: 'v2.7.5', target: 'v3.0.0' };
const SERVER = 'ghcr.io/immich-app/immich-server:release';
const PG = 'ghcr.io/immich-app/postgres:14-vectorchord0.4.3';
const compose = services => YAML.stringify({ services });
const finding = (r, id) => Object.values(r.families).flatMap(f => f.findings).find(f => f.rule_id === id);

// ---------- 1: unidentified service that may be another Immich server ----------
test('1a: an unresolved-image service pointing to another DB host keeps F5 UNKNOWN (Codex repro)', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({
    'immich-server': { image: SERVER }, database: { image: PG },
    other: { image: '${OTHER_IMAGE}', environment: { DB_HOSTNAME: 'external.test' } },
  }) });
  const r = analyze({ dir, ...V3 });
  assert.equal(r.families.F5.label, 'UNKNOWN');
  assert.ok(finding(r, 'F5-300-no-supported-extension').missing_inputs.some(m => m.includes('other')));
});
test('1b: certain findings of the known server survive next to the unresolved service', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({
    'immich-server': { image: SERVER, environment: { DB_VECTOR_EXTENSION: 'pgvecto.rs' } }, database: { image: PG },
    other: { image: '${OTHER_IMAGE}', environment: { DB_HOSTNAME: 'external.test' } },
  }) });
  const r = analyze({ dir, ...V3 });
  assert.equal(finding(r, 'F6-300-env-pgvectors-rejected').label, 'ACTION_REQUIRED');
  assert.equal(r.families.F5.label, 'UNKNOWN');
});
test('1c: no extra noise when the unidentified service uses the same database', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({ 'immich-server': { image: SERVER }, database: { image: PG }, sidecar: { build: '.' } }) });
  assert.equal(analyze({ dir, ...V3 }).families.F5.label, 'NOT_APPLICABLE');
});

// ---------- 2: interpolated values never reach the output ----------
const SECRETS = ['AUDIT_SECRET', 'AUDIT_HOST_SECRET', 'AUDIT_PATH_SECRET'];
const leakProject = image => mkProject({
  'docker-compose.yml': compose({
    'immich-server': { image: SERVER, environment: { DB_HOSTNAME: '${DBH}', IMMICH_MEDIA_LOCATION: '${MEDIA}' } },
    db: { image, container_name: '${DBH}' },
  }),
  '.env': 'TOKEN=AUDIT_SECRET\nDBH=AUDIT_HOST_SECRET\nMEDIA=./AUDIT_PATH_SECRET\n',
});
test('2a: resolved image references, hosts and paths from interpolation are not printed (JSON and text)', () => {
  for (const image of ['private.example/postgres:${TOKEN}', 'docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0-${TOKEN}']) {
    const dir = leakProject(image);
    for (const req of [V3, { current: 'v1.135.3', target: 'v1.136.0' }]) {
      const r = analyze({ dir, ...req });
      const out = JSON.stringify(r) + renderText(r);
      for (const s of SECRETS) assert.ok(!out.includes(s), `${s} leaked (${image}, ${req.target})`);
    }
  }
});
test('2b: the technical classification and locations are kept', () => {
  const r = analyze({ dir: leakProject('docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0'), ...V3 });
  const img = finding(r, 'F5-300-no-supported-extension').config.find(c => c.field === 'image');
  assert.equal(img.service, 'db');
  assert.match(img.value, /tensorchord\/pgvecto-rs/);
  assert.match(img.source, /docker-compose\.yml:\d+/);
  const media = finding(analyze({ dir: leakProject(PG), current: 'v1.135.3', target: 'v1.136.0' }), 'F1-136-media-location-relative');
  assert.equal(media.label, 'ACTION_REQUIRED');
});
test('2c: CLI error messages do not echo file contents', () => {
  const dir = mkProject({ 'docker-compose.yml': 'services:\n  a:\n    image: x\n    image: AUDIT_SECRET\n' });
  const res = spawnSync(process.execPath, [path.resolve('bin/cri.mjs'), 'analyze', dir, '--current', 'v2.7.5', '--target', 'v3.0.0'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.ok(!(res.stdout + res.stderr).includes('AUDIT_SECRET'));
});

// ---------- 3: instructions come only from the structured remediation ----------
const rulesWith = mutate => { const r = YAML.parse(fs.readFileSync(DEFAULTS.rulesFile, 'utf8')); mutate(r); const p = path.join(mkProject({}), 'r.yaml'); fs.writeFileSync(p, YAML.stringify(r)); return p; };
const known = loadKnownVersions(DEFAULTS.versionsFile);
const envProject = () => mkProject({ 'docker-compose.yml': compose({ 'immich-server': { image: SERVER, environment: { DB_VECTOR_EXTENSION: 'pgvecto.rs' } }, database: { image: PG } }) });
test('3a: the published action is generated from remediation', () => {
  const f = finding(analyze({ dir: envProject(), ...V3 }), 'F6-300-env-pgvectors-rejected');
  assert.equal(f.action, 'Back up the database, then remove DB_VECTOR_EXTENSION (auto-detect) or set it to vectorchord.');
});
test('3b: the Codex meaning-flip cannot become an instruction', () => {
  const flip = 'Keep DB_VECTOR_EXTENSION as it is; vectorchord is not needed.';
  // as free-text action: rejected, there is no free-text action channel any more
  assert.throws(() => loadRules(rulesWith(r => { r.rules.find(x => x.id === 'F6-300-env-pgvectors-rejected').action = flip; }), DEFAULTS.evidenceFile, known), RuleError);
  // as summary text: it may load (summary is internal metadata), but it is never emitted and the action is unchanged
  const p = rulesWith(r => { r.rules.find(x => x.id === 'F6-300-env-pgvectors-rejected').summary = flip; });
  const r = analyze({ dir: envProject(), ...V3 }, { rulesFile: p });
  assert.ok(!(JSON.stringify(r) + renderText(r)).includes(flip));
  assert.equal(finding(r, 'F6-300-env-pgvectors-rejected').action, 'Back up the database, then remove DB_VECTOR_EXTENSION (auto-detect) or set it to vectorchord.');
});
test('3c: unsupported remediation ops and malformed remediations are rejected, not guessed', () => {
  assert.throws(() => loadRules(rulesWith(r => { r.rules[0].remediation.op = 'frobnicate'; }), DEFAULTS.evidenceFile, known), RuleError);
  assert.throws(() => loadRules(rulesWith(r => { r.rules.find(x => x.id === 'F1-106-port-host-renamed').remediation.replacements.pop(); }), DEFAULTS.evidenceFile, known), RuleError);
});

// ---------- 4 (Phase 1.3.1): rule-authored free text never reaches a report ----------
const CODEX = 'Operators must keep DB_VECTOR_EXTENSION as it is and should never use vectorchord.';
const evidenceWith = mutate => { const e = YAML.parse(fs.readFileSync(DEFAULTS.evidenceFile, 'utf8')); mutate(e); const p = path.join(mkProject({}), 'e.yaml'); fs.writeFileSync(p, YAML.stringify(e)); return p; };
const GENERATED = 'Back up the database, then remove DB_VECTOR_EXTENSION (auto-detect) or set it to vectorchord.';
test('4a: a contradicting rule summary (Codex sentence) is absent from JSON and terminal output', () => {
  const rulesFile = rulesWith(r => { r.rules.find(x => x.id === 'F6-300-env-pgvectors-rejected').summary = CODEX; });
  const r = analyze({ dir: envProject(), ...V3 }, { rulesFile });
  const out = JSON.stringify(r) + renderText(r);
  assert.ok(!out.includes(CODEX), 'the contradicting sentence must not be emitted');
  assert.equal(finding(r, 'F6-300-env-pgvectors-rejected').action, GENERATED);
  assert.ok(renderText(r).includes(GENERATED), 'the structured remediation stays visible');
});
test('4b: the same sentence planted in an evidence title is absent; a non-grammatical revision is rejected', () => {
  const evidenceFile = evidenceWith(e => { e.E11.title = CODEX; });
  const r = analyze({ dir: envProject(), ...V3 }, { evidenceFile });
  assert.ok(!(JSON.stringify(r) + renderText(r)).includes(CODEX));
  assert.ok(finding(r, 'F6-300-env-pgvectors-rejected').evidence.every(e => e.id && e.url && e.revision), 'source references stay');
  assert.throws(() => analyze({ dir: envProject(), ...V3 }, { evidenceFile: evidenceWith(e => { e.E11.revision = CODEX; }) }), RuleError);
});
test('4c: a redacted DB image never comes with an instruction that implies its versions are visible', () => {
  const dir = mkProject({ 'docker-compose.yml': compose({ 'immich-server': { image: SERVER }, database: { image: 'docker.io/tensorchord/pgvecto-rs:${PGTAG}' } }), '.env': 'PGTAG=pg14-v0.2.0\n' });
  const f = finding(analyze({ dir, ...V3 }), 'F5-300-no-supported-extension');
  assert.equal(f.label, 'ACTION_REQUIRED');
  assert.equal(f.config.find(c => c.field === 'image').detail, 'versions not shown (interpolated tag)');
  assert.ok(!/shown in config/.test(f.action) && /verify both in your compose file/.test(f.action));
});
test('4d: no other rule field can carry prose into a report (remediation tokens, action_key, rule id)', () => {
  const F6 = 'F6-300-env-pgvectors-rejected';
  for (const mutate of [
    r => { r.rules.find(x => x.id === F6).remediation.replacements = ['never use vectorchord']; },
    r => { r.rules.find(x => x.id === F6).action_key = 'keep DB_VECTOR_EXTENSION as it is'; },
    r => { r.rules.find(x => x.id === F6).id = 'F6 keep the setting'; },
  ]) assert.throws(() => loadRules(rulesWith(mutate), DEFAULTS.evidenceFile, known), RuleError);
});
