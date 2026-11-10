// The synthetic examples under examples/ and their saved reports must stay reproducible byte for byte.
// The reports contain only relative file names (no absolute paths), and .gitattributes keeps them LF on every platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.resolve('bin/cri.mjs');
const EXAMPLES = [
  ['01-env-variable-migration', 'v1.118.2', 'v1.119.0'],
  ['02-intermediate-upgrade-stop', 'v1.131.3', 'v1.137.0'],
  ['03-external-database-unknown', 'v2.7.5', 'v3.0.0'],
];
for (const [name, current, target] of EXAMPLES) {
  test(`example ${name}: saved terminal and JSON reports match a fresh run`, () => {
    const dir = `examples/${name}`;
    for (const [file, extra] of [['report.txt', []], ['report.json', ['--json']]]) {
      const r = spawnSync(process.execPath, [CLI, 'analyze', dir, '--current', current, '--target', target, ...extra], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, fs.readFileSync(path.join(dir, file), 'utf8'), `${dir}/${file} is out of date`);
    }
  });
}
