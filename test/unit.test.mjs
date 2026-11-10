import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions } from '../src/version.mjs';
import { interpolate, parseEnvFile, loadProject } from '../src/compose.mjs';
import { mkProject } from './helpers.mjs';

test('version parsing and ordering', () => {
  assert.equal(parseVersion('1.2.3').raw, 'v1.2.3');
  for (const bad of ['v1.2', 'v01.2.3', 'latest', 'v1.2.3.4', '', null]) assert.equal(parseVersion(bad), null, String(bad));
  const ordered = ['v1.9.9', 'v1.10.0', 'v1.107.1', 'v1.107.2', 'v1.131.3', 'v1.132.0', 'v3.0.0-rc.0', 'v3.0.0-rc.3', 'v3.0.0-rc.10', 'v3.0.0', 'v3.0.1'];
  for (let i = 1; i < ordered.length; i++) assert.ok(compareVersions(ordered[i - 1], ordered[i]) < 0, `${ordered[i - 1]} < ${ordered[i]}`);
  assert.equal(compareVersions('v1.132.3', '1.132.3'), 0);
});

test('interpolation forms', () => {
  const vars = { A: 'x', E: '' };
  const v = s => interpolate(s, vars);
  assert.equal(v('${A}').value, 'x');
  assert.equal(v('$A/y').value, 'x/y');
  assert.equal(v('$$A').value, '$A');
  assert.equal(v('${B:-d}').value, 'd');
  assert.equal(v('${E:-d}').value, 'd');
  assert.equal(v('${E-d}').value, '');
  assert.equal(v('${A:+r}').value, 'r');
  assert.equal(v('${B}').value, null);
  assert.deepEqual(v('${B}').unresolved, ['B']);
  assert.deepEqual(v('${B:?need B}').unresolved, ['B']);
  const nested = v('${B:-${A}}');
  assert.equal(nested.value, null, 'nested defaults are reported, not guessed');
  assert.equal(nested.unsupported.length, 1);
});

test('env file parsing', () => {
  const { vars, invalid } = parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'$x\'\nD=val # note\nnot a line\n');
  assert.equal(vars.A.value, '1');
  assert.equal(vars.B.value, 'two words');
  assert.equal(vars.C.value, '$x');
  assert.equal(vars.D.value, 'val');
  assert.deepEqual(invalid, [6]);
});

test('environment overrides env_file; pass-through and missing files are unknown', () => {
  const dir = mkProject({
    'docker-compose.yml': `services:\n  s:\n    image: x\n    env_file: [a.env, gone.env]\n    environment:\n      K: from-env\n      P:\n`,
    'a.env': 'K=from-file\nL=file-only\n',
  });
  const s = loadProject(dir).services[0];
  assert.equal(s.env.K.value, 'from-env');
  assert.equal(s.env.P.value, null, 'shell pass-through is not read');
  assert.ok(s.envIncomplete.some(w => w.includes('gone.env')));
});

test('env_file outside the input directory is never read', () => {
  const dir = mkProject({ 'docker-compose.yml': `services:\n  s:\n    image: x\n    env_file: [../secret.env]\n` });
  const p = loadProject(dir);
  assert.ok(p.missing.some(m => m.includes('outside the input directory')));
  assert.ok(!p.filesRead.includes('../secret.env'));
});
