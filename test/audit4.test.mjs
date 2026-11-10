// Output-boundary regression tests (final Codex probes A-D). Rule/evidence metadata that is not schema-valid
// must be rejected with a RuleError; valid metadata must still produce the same citation and instruction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { analyze, DEFAULTS } from '../src/engine.mjs';
import { RuleError } from '../src/rules.mjs';
import { renderText } from '../src/report.mjs';
import { mkProject } from './helpers.mjs';

export const CODEX = 'Operators must keep DB_VECTOR_EXTENSION as it is and should never use vectorchord.';
const F6 = 'F6-300-env-pgvectors-rejected';
const V3 = { current: 'v2.7.5', target: 'v3.0.0' };
const project = () => mkProject({ 'docker-compose.yml': YAML.stringify({ services: {
  'immich-server': { image: 'ghcr.io/immich-app/immich-server:release', environment: { DB_VECTOR_EXTENSION: 'pgvecto.rs' } },
  database: { image: 'ghcr.io/immich-app/postgres:14-vectorchord0.4.3' } } }) });
const write = (name, obj) => { const p = path.join(mkProject({}), name); fs.writeFileSync(p, YAML.stringify(obj)); return p; };
const rulesWith = mutate => { const r = YAML.parse(fs.readFileSync(DEFAULTS.rulesFile, 'utf8')); mutate(r); return write('r.yaml', r); };
const evidenceWith = mutate => { const e = YAML.parse(fs.readFileSync(DEFAULTS.evidenceFile, 'utf8')); mutate(e); return write('e.yaml', e); };

// Runs one probe; returns { error } or { out } (JSON + terminal text).
export function probe(opts) {
  try { const r = analyze({ dir: project(), ...V3 }, opts); return { out: JSON.stringify(r) + '\n' + renderText(r) }; }
  catch (e) { return { error: e }; }
}
export const PROBES = {
  'A: sentence in remediation.note': () => ({ rulesFile: rulesWith(r => { r.rules.find(x => x.id === F6).remediation.note = CODEX; }) }),
  'B: sentence as a referenced evidence ID': () => ({
    evidenceFile: evidenceWith(e => { e[CODEX] = e.E11; }),
    rulesFile: rulesWith(r => { r.rules.find(x => x.id === F6).evidence = [CODEX]; }) }),
  'C: sentence after a newline in an HTTPS URL fragment': () => ({ evidenceFile: evidenceWith(e => { e.E11.url = `https://immich.app/blog/v3-migration#x\n${CODEX}`; }) }),
  'C2: sentence after a U+2028 line separator in a URL': () => ({ evidenceFile: evidenceWith(e => { e.E11.url = `https://immich.app/blog/v3-migration#x${String.fromCharCode(0x2028)}${CODEX}`; }) }),
  'D: constructor as remediation op': () => ({ rulesFile: rulesWith(r => { r.rules.find(x => x.id === F6).remediation.op = 'constructor'; }) }),
};

for (const [name, opts] of Object.entries(PROBES)) {
  test(`probe ${name}: rejected with a controlled RuleError and absent from both outputs`, () => {
    const r = probe(opts());
    assert.ok(r.error instanceof RuleError, `expected RuleError, got ${r.error ? r.error.constructor.name : 'a report'}`);
    assert.ok(!r.error.message.includes(CODEX) && !r.error.message.includes('Operators must'), 'error message must not echo the metadata');
  });
}

test('inherited property names are rejected as family, kind, predicate and evidence id', () => {
  for (const mutate of [
    r => { r.rules.find(x => x.id === F6).family = 'constructor'; },
    r => { r.rules.find(x => x.id === F6).kind = 'toString'; },
    r => { r.rules.find(x => x.id === F6).when = { all: [{ constructor: 'v1.0.0' }] }; },
    r => { r.rules.find(x => x.id === F6).evidence = ['__proto__']; },
  ]) assert.ok(probe({ rulesFile: rulesWith(mutate) }).error instanceof RuleError);
});

test('prose cannot enter through predicate arguments that are printed in findings', () => {
  for (const mutate of [
    r => { r.rules.find(x => x.id === 'F2-118-start-sh-removed').when.all[1].command_argv.argv = [CODEX]; },
    r => { r.rules.find(x => x.id === F6).when.all[1].env_equals.value = CODEX; },
    r => { r.rules.find(x => x.id === F6).when.all[1].env_equals.key = 'keep it'; },
  ]) assert.ok(probe({ rulesFile: rulesWith(mutate) }).error instanceof RuleError);
});

test('valid metadata: exact citation, instruction and validated remediation shape', () => {
  const r = analyze({ dir: project(), ...V3 });
  const f = r.families.F6.findings.find(x => x.rule_id === F6);
  assert.equal(f.action, 'Back up the database, then remove DB_VECTOR_EXTENSION (auto-detect) or set it to vectorchord.');
  assert.deepEqual(f.evidence, [
    { id: 'E11', url: 'https://immich.app/blog/v3-migration', revision: 'immich-app/static-pages @ 5801b598' },
    { id: 'E12', url: 'https://github.com/immich-app/immich/pull/28159', revision: 'merge 97c62136' },
    { id: 'E21', url: 'https://github.com/immich-app/immich/blob/v3.0.0/server/src/dtos/env.dto.ts', revision: 'tags v2.7.5 and v3.0.0' },
  ]);
  assert.deepEqual(f.remediation, { op: 'unset_env', subjects: ['DB_VECTOR_EXTENSION'], replacements: ['vectorchord'], backup: true });
  assert.ok(renderText(r).includes('source : E11 <https://immich.app/blog/v3-migration> (immich-app/static-pages @ 5801b598)'));
});
