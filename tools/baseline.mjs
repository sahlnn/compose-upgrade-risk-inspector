// Deliberately naive baseline: substring search over raw files + plain version thresholds.
// No YAML parsing, no env resolution, never answers UNKNOWN or ADVISORY. Used only to measure what the engine adds.
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions } from '../src/version.mjs';

const ge = (a, b) => compareVersions(a, b) >= 0;
const lt = (a, b) => compareVersions(a, b) < 0;

export function baselineAnalyze({ dir, current, target }) {
  const text = fs.readdirSync(dir, { recursive: true })
    .filter(f => fs.statSync(path.join(dir, f)).isFile())
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const has = (...words) => words.some(w => text.includes(w));
  const A = 'ACTION_REQUIRED', N = 'NOT_APPLICABLE';
  const label = c => (c ? A : N);
  return {
    F1: label(
      (ge(target, 'v1.119.0') && has('IMMICH_METRICS', 'SERVER_PORT', 'MACHINE_LEARNING_HOST')) ||
      (ge(target, 'v1.136.0') && has('IMMICH_MEDIA_LOCATION')) ||
      (ge(target, 'v3.0.0') && has('MACHINE_LEARNING_PRELOAD__CLIP', 'MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION', 'IMMICH_MACHINE_LEARNING_PING_TIMEOUT'))),
    F2: label(ge(target, 'v1.118.0') && has('start.sh', ':3001', 'microservices')),
    F3: label(!!current && lt(current, 'v1.107.2') && ge(target, 'v1.133.0')),
    F4: label(!!current && lt(current, 'v1.132.0') && ge(target, 'v1.137.0')),
    F5: label(ge(target, 'v3.0.0') && has('pgvecto-rs')),
    F6: label(ge(target, 'v3.0.0') && has('pgvecto.rs')),
  };
}
