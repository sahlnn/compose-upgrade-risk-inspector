// Scores the engine and the baseline against the development set.
// The dataset is generated into a temp directory (no side effects on the project), each case runs on a temporary
// copy of its input/ folder only, and expectations are read here, never by the engine.
// Usage: node tools/score.mjs [--evidence <dir>]   (default evidence/phase1.1)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { analyze } from '../src/engine.mjs';
import { baselineAnalyze } from './baseline.mjs';
import { splitFixtures } from './split-fixtures.mjs';

const FAMS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GOLDEN = YAML.parse(fs.readFileSync(path.join(ROOT, 'test/golden/rules.yaml'), 'utf8'));
// EVIDENCE.md rows with backticks removed, keyed by evidence ID: the expected record for source URL and revision.
export const EVIDENCE_ROWS = Object.fromEntries([...fs.readFileSync(path.join(ROOT, 'EVIDENCE.md'), 'utf8').matchAll(/^\| (E\d\d) \|(.*)$/gm)].map(m => [m[1], m[2].replace(/`/g, '')]));

// Checks one emitted finding against the hand-written golden record of its rule (not against the rule file).
export function checkAgainstGolden(f) {
  const g = GOLDEN[f.rule_id], errs = [];
  if (!g) return [`${f.rule_id}: no golden record`];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (g.family !== f.family) errs.push(`${f.rule_id}: family ${f.family} != golden ${g.family}`);
  if (f.label !== 'UNKNOWN' && f.label !== g.label) errs.push(`${f.rule_id}: label ${f.label} != golden ${g.label}`);
  if (f.action_key !== g.action_key) errs.push(`${f.rule_id}: action_key ${f.action_key} != golden ${g.action_key}`);
  if (!eq(f.evidence.map(e => e.id), g.evidence)) errs.push(`${f.rule_id}: evidence ${JSON.stringify(f.evidence.map(e => e.id))} != golden ${JSON.stringify(g.evidence)}`);
  const m = f.remediation ?? {};
  if (!eq([m.op, m.subjects, m.replacements, m.backup ?? false, m.before ?? null], [g.op, g.subjects, g.replacements, g.backup ?? false, g.before ?? null])) errs.push(`${f.rule_id}: remediation differs from golden`);
  // Each cited source must match the human-written EVIDENCE.md row: URL, and every revision token that carries a digit.
  for (const e of f.evidence) {
    const row = EVIDENCE_ROWS[e.id];
    if (!row || !row.includes(e.url)) errs.push(`${f.rule_id}: ${e.id} URL does not match EVIDENCE.md`);
    for (const tok of String(e.revision).split(/[\s,()]+/).filter(t => /\d/.test(t))) if (!row?.includes(tok)) errs.push(`${f.rule_id}: ${e.id} revision '${tok}' not in EVIDENCE.md`);
  }
  if (f.label === 'ADVISORY' && (f.recommended_stop ?? null) !== (g.recommended_stop ?? null)) errs.push(`${f.rule_id}: recommended_stop ${f.recommended_stop} != golden ${g.recommended_stop}`);
  if (f.evidence.some(e => !e.url)) errs.push(`${f.rule_id}: evidence without URL`);
  return errs;
}
const servicesOf = f => [...new Set(f.config.map(c => c.service).filter(Boolean))].sort();

// expected -> got outcome classes. "unsafe" outcomes are the hard gates.
export function classify(exp, got) {
  if (exp === got) return 'correct';
  if (exp === 'UNKNOWN') return `unsafe:unknown->${got}`; // any certain answer where the inputs cannot decide is unsafe
  if (got === 'UNKNOWN') return 'unknown-instead-of-certain';
  if (exp === 'ACTION_REQUIRED') return `unsafe:false-negative->${got}`;
  if (exp === 'ADVISORY') return got === 'NOT_APPLICABLE' ? 'false-negative:advisory-missed' : 'false-positive:over-severity';
  return `false-positive:${got}`; // expected NOT_APPLICABLE
}

// Full-report check: all six families, certain action keys, upgrade path, and what a scored UNKNOWN must cite.
export function compareReport(exp, out, scoredFamily) {
  const mismatches = [], unsafe = [];
  if (!exp) return { mismatches: ['no expected_report'], unsafe };
  const label = f => (out.families ? out.families[f].label : out[f]);
  for (const f of FAMS) {
    const o = classify(exp.families[f], label(f));
    if (o !== 'correct') { mismatches.push(`${f}: expected ${exp.families[f]}, got ${label(f)}`); if (o.startsWith('unsafe')) unsafe.push(`${f}:${o}`); }
  }
  if (!out.families) return { mismatches: [...mismatches, 'no findings (baseline)'], unsafe };
  const all = Object.values(out.families).flatMap(f => f.findings);
  const keys = [...new Set(all.filter(f => f.label !== 'UNKNOWN').map(f => f.action_key))].sort();
  if (JSON.stringify(keys) !== JSON.stringify([...exp.action_keys].sort())) mismatches.push(`action keys: expected ${JSON.stringify(exp.action_keys)}, got ${JSON.stringify(keys)}`);
  const p = out.upgrade_path;
  if (p.status !== exp.upgrade_path.status || JSON.stringify(p.stops.map(s => s.version)) !== JSON.stringify(exp.upgrade_path.stops))
    mismatches.push(`upgrade path: expected ${exp.upgrade_path.status} ${JSON.stringify(exp.upgrade_path.stops)}, got ${p.status} ${JSON.stringify(p.stops.map(s => s.version))}`);
  const scored = out.families[scoredFamily].findings;
  const cited = scored.filter(f => f.label === 'UNKNOWN').flatMap(f => f.missing_inputs).join(' | ');
  for (const t of exp.missing_tokens) if (!cited.includes(t)) mismatches.push(`missing input '${t}' not cited in ${scoredFamily}`);
  for (const r of exp.unknown_rules) if (!scored.some(f => f.rule_id === r && f.label === 'UNKNOWN')) mismatches.push(`UNKNOWN rule ${r} not reported`);
  const details = all.flatMap(f => f.config.map(c => c.detail ?? '')).join(' | ');
  for (const t of exp.config_details) if (!details.includes(t)) mismatches.push(`config detail '${t}' not reported`);

  // Per finding: identity (rule, label, services), reason of every UNKNOWN, and golden evidence/remediation.
  const key = (rule, label, services) => `${rule}|${label}|${[...services].sort().join(',')}`;
  const gotKeys = new Set(all.map(f => key(f.rule_id, f.label, servicesOf(f))));
  const expKeys = new Set((exp.findings ?? []).map(e => key(e.rule, e.label, e.services)));
  for (const e of exp.findings ?? []) {
    if (gotKeys.has(key(e.rule, e.label, e.services))) continue;
    mismatches.push(`finding missing: ${key(e.rule, e.label, e.services)}`);
    const got = all.find(f => f.rule_id === e.rule);
    // Losing a mandatory or UNKNOWN finding (or answering an expected UNKNOWN with certainty) is unsafe even if the family label survives.
    if (e.label === 'ACTION_REQUIRED' && (!got || got.label !== 'ACTION_REQUIRED')) unsafe.push(`finding ${e.rule}: ACTION_REQUIRED lost`);
    if (e.label === 'UNKNOWN' && (!got || got.label !== 'UNKNOWN')) unsafe.push(`finding ${e.rule}: UNKNOWN lost`);
  }
  for (const k of gotKeys) if (!expKeys.has(k)) mismatches.push(`unexpected finding: ${k}`);
  for (const e of exp.findings ?? []) {
    const f = all.find(x => x.rule_id === e.rule && x.label === e.label);
    if (!f) continue;
    if (e.label === 'UNKNOWN') {
      if (e.why === 'unverified') { if (GOLDEN[e.rule]?.label !== 'UNKNOWN') mismatches.push(`${e.rule}: expected an unverified rule`); }
      else if (!f.missing_inputs.join(' | ').includes(e.why)) { mismatches.push(`${e.rule}: UNKNOWN reason '${e.why}' not cited`); unsafe.push(`finding ${e.rule}: UNKNOWN without its reason`); }
    }
  }
  for (const f of all) mismatches.push(...checkAgainstGolden(f));
  const eqv = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!eqv(p.advisory_stops.map(s => s.version), exp.upgrade_path.advisory_stops ?? [])) mismatches.push(`advisory stops: expected ${JSON.stringify(exp.upgrade_path.advisory_stops)}, got ${JSON.stringify(p.advisory_stops.map(s => s.version))}`);
  if (!eqv(p.open_risks, exp.upgrade_path.open_risks ?? [])) { mismatches.push(`open path risks: expected ${JSON.stringify(exp.upgrade_path.open_risks)}, got ${JSON.stringify(p.open_risks)}`); if ((exp.upgrade_path.open_risks ?? []).length) unsafe.push('open path risk lost'); }
  return { mismatches, unsafe };
}

export function runCases(engine, dataset) {
  const ids = fs.readdirSync(path.join(dataset, 'cases')).sort();
  return ids.map(id => {
    const expected = JSON.parse(fs.readFileSync(path.join(dataset, 'expected', `${id}.json`), 'utf8'));
    const request = JSON.parse(fs.readFileSync(path.join(dataset, 'cases', id, 'request.json'), 'utf8'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cri-case-'));
    try {
      fs.cpSync(path.join(dataset, 'cases', id, 'input'), tmp, { recursive: true });
      const out = engine({ dir: tmp, current: request.current, target: request.target });
      const got = out.families ? out.families[expected.family].label : out[expected.family];
      return { id, set: expected.set, family: expected.family, strength: expected.evidence_strength, expected: expected.label, got,
        outcome: classify(expected.label, got), report: compareReport(expected.report, out, expected.family), full: out };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
}

// Generates the dev set into a fresh temp dir and returns its path (caller may delete it).
export function tempDataset() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cri-dataset-')), 'dev');
  splitFixtures(dir);
  return dir;
}

export function summarize(rows) {
  const count = (pred) => rows.filter(pred).length;
  const groups = { 'strong': r => r.strength === 'strong', 'medium/weak': r => r.strength !== 'strong' };
  const by = {};
  for (const [g, f] of Object.entries(groups)) { const rs = rows.filter(f); by[g] = { n: rs.length, correct: rs.filter(r => r.outcome === 'correct').length, full_report_ok: rs.filter(r => r.report && !r.report.mismatches.length).length }; }
  const labels = ['ACTION_REQUIRED', 'ADVISORY', 'NOT_APPLICABLE', 'UNKNOWN'];
  const matrix = Object.fromEntries(labels.map(e => [e, Object.fromEntries(labels.map(g => [g, count(r => r.expected === e && r.got === g)]))]));
  return {
    n: rows.length, correct: count(r => r.outcome === 'correct'),
    full_report_ok: count(r => r.report && !r.report.mismatches.length),
    false_positive: rows.filter(r => r.outcome.startsWith('false-positive')).map(r => r.id),
    false_negative: rows.filter(r => r.outcome.startsWith('false-negative') || r.outcome.startsWith('unsafe:false-negative')).map(r => r.id),
    unknown_expected_but_certain: rows.filter(r => r.outcome.startsWith('unsafe:unknown')).map(r => r.id),
    unknown_but_certain_expected: rows.filter(r => r.outcome === 'unknown-instead-of-certain').map(r => r.id),
    // Hard gates over ALL six families of every case, not just the scored one.
    hard_gate_violations: [...new Set([
      ...rows.filter(r => r.outcome.startsWith('unsafe')).map(r => `${r.id}:${r.family}:${r.outcome}`),
      ...rows.flatMap(r => (r.report?.unsafe ?? []).map(u => `${r.id}:${u}`)),
    ])],
    report_mismatches: Object.fromEntries(rows.filter(r => r.report?.mismatches.length).map(r => [r.id, r.report.mismatches])),
    by_strength: by, matrix,
  };
}

function table(rows) {
  return rows.map(r => `${r.id.padEnd(6)} ${r.family} ${r.strength.padEnd(6)} expected=${r.expected.padEnd(15)} got=${String(r.got).padEnd(15)} ${r.outcome}${r.report?.mismatches.length ? `  [full report: ${r.report.mismatches.length} mismatch]` : ''}`).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--evidence');
  const outDir = i > 0 ? process.argv[i + 1] : 'evidence/phase1.1';
  fs.mkdirSync(outDir, { recursive: true });
  const dataset = tempDataset();
  const report = [], results = {};
  try {
    for (const [name, engine] of [['engine', analyze], ['baseline', baselineAnalyze]]) {
      const rows = runCases(engine, dataset);
      const s = summarize(rows);
      results[name] = { summary: s, rows: rows.map(({ full, ...r }) => r) };
      report.push(`=== ${name} (development set only, NOT a general accuracy claim) ===`, table(rows), '', JSON.stringify(s, null, 2), '');
    }
  } finally { fs.rmSync(path.dirname(dataset), { recursive: true, force: true }); }
  fs.writeFileSync(path.join(outDir, 'score.txt'), report.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'score.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(report.join('\n'));
}
