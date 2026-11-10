// Dataset quality gate: parses every fixture strictly with the project's pinned `yaml` package and checks structure/consistency.
// Usage: node tools/validate-fixtures.mjs <fixtures-dir> [cross-check-lib-dir]
// Optional [cross-check-lib-dir] must contain the npm package `js-yaml`; it adds an independent second parse.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import YAML from 'yaml';

const [dir = 'fixtures', libDir] = process.argv.slice(2);
const jsyaml = libDir ? createRequire(path.resolve(libDir) + '/')('js-yaml') : null;

const root = path.resolve(dir, '..');
const tags = new Set(fs.readFileSync(path.join(root, 'data/immich-release-tags.txt'), 'utf8').split('\n').filter(l => /^v\d/.test(l)));
const evidenceIds = new Set([...fs.readFileSync(path.join(root, 'EVIDENCE.md'), 'utf8').matchAll(/^\| (E\d\d) \|/gm)].map(m => m[1]));
const LABELS = ['ACTION_REQUIRED', 'NOT_APPLICABLE', 'UNKNOWN', 'ADVISORY'];
const REQUIRED = { id: 'string', family: 'string', current_version: 'string', target_version: 'string', expected_label: 'string',
  evidence: 'array', evidence_strength: 'string', rationale: 'string', expected_actions: 'array', missing_inputs: 'array', expected_report: 'object', files: 'object' };

const semver = v => v.slice(1).split('.').map(Number);
const cmp = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

// Strict parse with both parsers; returns value or pushes errors.
function parseBoth(text, label, errs) {
  const doc = YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  for (const e of doc.errors) errs.push(`${label}: yaml error: ${e.message.split('\n')[0]}`);
  for (const w of doc.warnings) errs.push(`${label}: yaml warning: ${w.message.split('\n')[0]}`);
  let a, b;
  try { a = doc.toJSON(); } catch (e) { errs.push(`${label}: yaml toJSON: ${e.message}`); }
  if (jsyaml) try { b = jsyaml.load(text); } catch (e) { errs.push(`${label}: js-yaml: ${e.message.split('\n')[0]}`); }
  if (a !== undefined && b !== undefined && JSON.stringify(a) !== JSON.stringify(b)) errs.push(`${label}: parsers disagree on content`);
  return a ?? b;
}

const results = [];
for (const f of fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort()) {
  const errs = [], notes = [];
  const c = parseBoth(fs.readFileSync(path.join(dir, f), 'utf8'), f, errs);
  if (!c || typeof c !== 'object') { results.push({ f, errs: errs.length ? errs : ['not a mapping'], notes }); continue; }

  for (const [k, t] of Object.entries(REQUIRED)) {
    const v = c[k];
    const ok = t === 'array' ? Array.isArray(v) : (v !== null && typeof v === t);
    if (!ok) errs.push(`field ${k}: expected ${t}`);
  }
  if (c.id + '.yaml' !== f) errs.push(`id ${c.id} does not match file name`);
  if (c.family && !String(c.id).startsWith(c.family + '-')) errs.push('family does not match id prefix');
  if (!LABELS.includes(c.expected_label)) errs.push(`bad label ${c.expected_label}`);
  const rep = c.expected_report;
  if (rep && typeof rep === 'object') {
    const fams = rep.families ?? {};
    if (JSON.stringify(Object.keys(fams)) !== JSON.stringify(['F1', 'F2', 'F3', 'F4', 'F5', 'F6'])) errs.push('expected_report.families must list F1..F6 in order');
    for (const [k, l] of Object.entries(fams)) if (!LABELS.includes(l)) errs.push(`expected_report.families.${k}: bad label ${l}`);
    if (fams[c.family] !== c.expected_label) errs.push(`expected_report.families.${c.family} (${fams[c.family]}) contradicts expected_label (${c.expected_label})`);
    for (const k of ['action_keys', 'missing_tokens', 'unknown_rules', 'config_details']) if (!Array.isArray(rep[k])) errs.push(`expected_report.${k} must be a list`);
    if (!['NO_KNOWN_STOP', 'INTERMEDIATE_REQUIRED', 'ADVISORY', 'UNKNOWN'].includes(rep.upgrade_path?.status)) errs.push('expected_report.upgrade_path.status must be NO_KNOWN_STOP|INTERMEDIATE_REQUIRED|ADVISORY|UNKNOWN');
    for (const s of rep.upgrade_path?.stops ?? []) if (!tags.has(s)) errs.push(`expected_report stop ${s} is not a release tag`);
    if (c.expected_label === 'UNKNOWN' && !(rep.missing_tokens?.length || rep.unknown_rules?.length)) errs.push('UNKNOWN case must name the missing token or the unverified rule it expects');
  }
  for (const k of ['current_version', 'target_version']) {
    const v = c[k];
    if (v === 'unknown') continue;
    if (!/^v\d+\.\d+\.\d+$/.test(v ?? '')) errs.push(`${k} not semver: ${v}`);
    else if (!tags.has(v)) errs.push(`${k} ${v} is not an Immich release tag`);
  }
  if (c.current_version !== 'unknown' && /^v/.test(c.current_version ?? '') && /^v/.test(c.target_version ?? '') && cmp(c.current_version, c.target_version) >= 0)
    errs.push('current_version is not lower than target_version');
  for (const e of c.evidence ?? []) if (!evidenceIds.has(e)) errs.push(`unknown evidence id ${e}`);
  if ((c.evidence ?? []).length === 0) errs.push('no evidence');

  // Embedded files
  const files = c.files ?? {};
  const compose = typeof files['docker-compose.yml'] === 'string' ? parseBoth(files['docker-compose.yml'], `${f}#compose`, errs) : null;
  if (!compose?.services || typeof compose.services !== 'object') errs.push('compose has no services mapping');
  const envVars = new Set();
  if (typeof files['.env'] === 'string') {
    files['.env'].split('\n').forEach((l, i) => {
      if (!l.trim() || l.trim().startsWith('#')) return;
      const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) errs.push(`.env line ${i + 1} is not KEY=VALUE`); else envVars.add(m[1]);
    });
  }
  const missing = (c.missing_inputs ?? []).join(' | ');
  const provided = new Set(Object.keys(files));
  // Referenced but absent files must be declared missing
  for (const [name, svc] of Object.entries(compose?.services ?? {})) {
    const ef = svc?.env_file === undefined ? [] : [].concat(svc.env_file).map(x => (typeof x === 'object' ? x.path : x));
    for (const e of ef) if (!provided.has(e) && !missing.includes(e)) errs.push(`service ${name}: env_file ${e} absent but not in missing_inputs`);
    const ext = svc?.extends?.file;
    if (ext && !provided.has(ext) && !missing.includes(ext)) errs.push(`service ${name}: extends file ${ext} absent but not in missing_inputs`);
  }
  // Unresolved interpolation (no default, not defined in provided .env) must be declared, unless .env itself is missing
  if (provided.has('.env')) {
    const text = files['docker-compose.yml'] ?? '';
    for (const m of text.replace(/\$\$/g, '').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?][^}]*)?\}/g)) {
      if (m[2] || envVars.has(m[1])) continue;
      if (!missing.includes(m[1])) errs.push(`\${${m[1]}} unresolved but not in missing_inputs`);
    }
  }
  if (c.expected_label !== 'UNKNOWN' && (c.missing_inputs ?? []).length) errs.push('non-UNKNOWN case declares missing_inputs');
  if (c.expected_label === 'UNKNOWN' && !(c.missing_inputs ?? []).length) errs.push('UNKNOWN case declares no missing_inputs');
  if (!['strong', 'medium', 'weak'].includes(c.evidence_strength)) errs.push('bad evidence_strength');
  if (c.evidence_strength !== 'strong' && !c.evidence_note) errs.push('medium/weak case needs evidence_note');
  results.push({ f, errs, notes });
}

const bad = results.filter(r => r.errs.length);
for (const r of results) console.log(`${r.errs.length ? 'INVALID' : 'VALID  '} ${r.f}${r.errs.length ? '\n    - ' + r.errs.join('\n    - ') : ''}`);
const dist = {};
for (const f of fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f))) {
  try { const l = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')).expected_label; dist[l] = (dist[l] ?? 0) + 1; } catch {}
}
const ver = (base, p) => JSON.parse(fs.readFileSync(path.join(base, p, 'package.json'), 'utf8')).version;
console.log(`\nparsers: yaml ${ver('node_modules', 'yaml')}${jsyaml ? `, js-yaml ${ver(libDir, 'js-yaml')}` : ' (no cross-check)'}`);
console.log(`valid ${results.length - bad.length} / ${results.length}; labels ${JSON.stringify(dist)}`);
process.exit(bad.length ? 1 : 0);
