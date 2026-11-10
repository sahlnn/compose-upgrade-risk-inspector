// One isolated positive case per rule and path constraint. Expectations come from the hand-written golden record
// (test/golden/rules.yaml) and the service named in each case below, NOT from the rule file; deleting a rule must
// make its case fail, so a lost rule can no longer keep a perfect score.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { analyze, DEFAULTS } from '../src/engine.mjs';
import { GOLDEN, checkAgainstGolden } from '../tools/score.mjs';
import { mkProject } from './helpers.mjs';

const PG = 'ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0';
const OLD = 'docker.io/tensorchord/pgvecto-rs:pg14-v0.2.0';
const project = ({ env = {}, server = {}, ml, db = PG, dbExtra = {} }) => {
  const services = { 'immich-server': { image: 'ghcr.io/immich-app/immich-server:release', environment: env, ...server } };
  if (ml) services['immich-machine-learning'] = { image: 'ghcr.io/immich-app/immich-machine-learning:release', environment: ml };
  services.database = { image: db, ...dbExtra };
  return mkProject({ 'docker-compose.yml': YAML.stringify({ services }) });
};
const S = 'immich-server', ML = 'immich-machine-learning', DB = 'database';

// rule id -> [request, project spec, services the finding must point to]
const CASES = {
  'F3-floor-1.107.2': [['v1.105.1', 'v1.133.0'], {}, []],
  'F4-typeorm-boot': [['v1.131.3', 'v1.137.0'], {}, []],
  'F1-106-port-host-renamed': [['v1.105.1', 'v1.106.1'], { env: { SERVER_PORT: '3001' } }, [S]],
  'F1-106-microservices-port-renamed': [['v1.105.1', 'v1.106.1'], { env: { MICROSERVICES_PORT: '3002' }, server: { command: ['start.sh', 'microservices'] } }, [S]],
  'F1-106-ml-port-renamed': [['v1.105.1', 'v1.106.1'], { ml: { MACHINE_LEARNING_PORT: '3003' } }, [ML]],
  'F1-106-ml-host-renamed': [['v1.105.1', 'v1.106.1'], { ml: { MACHINE_LEARNING_HOST: '0.0.0.0' } }, [ML]],
  'F1-119-host-renamed': [['v1.118.2', 'v1.119.0'], { env: { HOST: '0.0.0.0' } }, [S]],
  'F1-106-host-transition': [['v1.105.1', 'v1.118.0'], { env: { HOST: '0.0.0.0' } }, [S]],
  'F1-119-metrics-removed': [['v1.118.2', 'v1.119.0'], { env: { IMMICH_METRICS: 'true' } }, [S]],
  'F1-136-media-location-relative': [['v1.135.3', 'v1.136.0'], { env: { IMMICH_MEDIA_LOCATION: './library' } }, [S]],
  'F1-300-ping-timeout-removed': [['v2.7.5', 'v3.0.0'], { env: { IMMICH_MACHINE_LEARNING_PING_TIMEOUT: '5000' } }, [S]],
  'F1-300-preload-clip-removed': [['v2.7.5', 'v3.0.0'], { ml: { MACHINE_LEARNING_PRELOAD__CLIP: 'ViT-B-32__openai' } }, [ML]],
  'F1-300-preload-face-removed': [['v2.7.5', 'v3.0.0'], { ml: { MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION: 'buffalo_l' } }, [ML]],
  'F1-2x-preload-clip-deprecated': [['v2.6.3', 'v2.7.5'], { ml: { MACHINE_LEARNING_PRELOAD__CLIP: 'ViT-B-32__openai' } }, [ML]],
  'F1-2x-preload-face-deprecated': [['v2.6.3', 'v2.7.5'], { ml: { MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION: 'buffalo_l' } }, [ML]],
  'F2-118-start-sh-removed': [['v1.117.0', 'v1.118.0'], { server: { command: ['start.sh', 'immich'] }, db: OLD }, [S]],
  'F2-118-microservices-removed': [['v1.117.0', 'v1.118.0'], { server: { command: ['start.sh', 'microservices'] }, db: OLD }, [S]],
  'F2-118-port-alignment': [['v1.117.0', 'v1.118.0'], { server: { ports: ['2283:3001'] }, db: OLD }, [S]],
  'F4-136-bug-from-old': [['v1.130.3', 'v1.136.0'], { db: OLD }, []],
  'F4-136-avoid-from-old': [['v1.130.3', 'v1.136.0'], { db: OLD }, []],
  'F5-300-no-supported-extension': [['v2.7.5', 'v3.0.0'], { db: OLD }, [DB]],
  'F5-2x-switch-image': [['v2.6.3', 'v2.7.5'], { db: OLD }, [DB]],
  'F5-2x-explicit-pgvectors': [['v2.6.3', 'v2.7.5'], { env: { DB_VECTOR_EXTENSION: 'pgvecto.rs' } }, [DB, S]],
  'F6-300-env-pgvectors-rejected': [['v2.7.5', 'v3.0.0'], { env: { DB_VECTOR_EXTENSION: 'pgvecto.rs' } }, [S]],
  'F6-300-legacy-vectors-command': [['v2.7.5', 'v3.0.0'], { dbExtra: { command: 'postgres -c shared_preload_libraries=vectors.so' } }, [DB]],
};
const ruleFile = YAML.parse(fs.readFileSync(DEFAULTS.rulesFile, 'utf8'));
const ruleIds = [...ruleFile.path_constraints, ...ruleFile.rules].map(r => r.id).sort();

test('every rule and path constraint has a golden record and an isolated positive case', () => {
  assert.deepEqual(Object.keys(GOLDEN).sort(), ruleIds);
  assert.deepEqual(Object.keys(CASES).sort(), ruleIds);
});

const findingOf = (id, rulesFile) => {
  const [[current, target], spec] = CASES[id];
  const out = analyze({ dir: project(spec), current, target }, rulesFile ? { rulesFile } : {});
  return Object.values(out.families).flatMap(f => f.findings).find(f => f.rule_id === id);
};

for (const id of ruleIds) {
  test(`rule ${id}: golden label, action key, evidence, remediation, service; deleting it is detected`, () => {
    const f = findingOf(id);
    assert.ok(f, 'rule did not fire on its own positive case');
    assert.equal(f.label, GOLDEN[id].label);
    assert.deepEqual(checkAgainstGolden(f), []);
    assert.deepEqual([...new Set(f.config.map(c => c.service).filter(Boolean))].sort(), [...CASES[id][2]].sort());
    if (f.label !== 'UNKNOWN') assert.ok(f.config.length, 'certain finding without a config field');
    const mutated = YAML.parse(fs.readFileSync(DEFAULTS.rulesFile, 'utf8'));
    mutated.rules = mutated.rules.filter(x => x.id !== id);
    mutated.path_constraints = mutated.path_constraints.filter(x => x.id !== id);
    const tmp = path.join(mkProject({}), 'rules.yaml');
    fs.writeFileSync(tmp, YAML.stringify(mutated));
    assert.equal(findingOf(id, tmp), undefined, 'deleting the rule went unnoticed');
  });
}
