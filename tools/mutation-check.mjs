// Mutation check: applies one deliberate defect at a time to a COPY of the project (fresh temp dir, plain file
// copies, no links) and runs the full test suite there. A mutation is "caught" when the suite fails.
// The project itself is never modified. Usage: node tools/mutation-check.mjs [--evidence <dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY = ['bin', 'src', 'rules', 'data', 'tools', 'test', 'fixtures', 'fixtures-advisory', 'examples', 'EVIDENCE.md', 'README.md', 'package.json', 'node_modules/yaml'];

const rulesEdit = fn => dir => {
  const p = path.join(dir, 'rules/immich.rules.yaml');
  const r = YAML.parse(fs.readFileSync(p, 'utf8')); fn(r); fs.writeFileSync(p, YAML.stringify(r));
};
const textEdit = (file, from, to) => dir => {
  const p = path.join(dir, file), t = fs.readFileSync(p, 'utf8');
  if (!t.includes(from)) throw new Error(`mutation anchor not found in ${file}: ${from}`);
  fs.writeFileSync(p, t.replace(from, to));
};
const rule = (r, id) => r.rules.find(x => x.id === id);

export const MUTATIONS = {
  'none (sanity: must PASS)': () => {},
  'Codex 1: remove the facial-recognition v3 rule': rulesEdit(r => { r.rules = r.rules.filter(x => x.id !== 'F1-300-preload-face-removed'); }),
  'Codex 2a: corrupt a rule evidence list (F6 env rule cites only E11)': rulesEdit(r => { rule(r, 'F6-300-env-pgvectors-rejected').evidence = ['E11']; }),
  'Codex 2b: corrupt evidence registry text (E03 URL)': textEdit('rules/evidence.yaml', 'releases/tag/v1.119.0', 'releases/tag/v1.119.9'),
  'Codex 2b2: corrupt evidence registry revision (E04 tag)': textEdit('rules/evidence.yaml', 'revision: "tag v1.133.0"', 'revision: "tag v1.133.9"'),
  'Codex 2c: reintroduce a free-text action with a wrong replacement name': rulesEdit(r => { rule(r, 'F1-119-metrics-removed').action = 'Replace IMMICH_METRICS with IMMICH_TELEMETRY_IGNORE.'; }),
  'Codex 2d: corrupt structured remediation (F2 port replacement)': rulesEdit(r => { rule(r, 'F2-118-port-alignment').remediation.replacements = ['2283', 'IMMICH_PORT=2283']; }),
  'Codex 2e: meaning-flip "Keep DB_VECTOR_EXTENSION…" as free-text action': rulesEdit(r => { rule(r, 'F6-300-env-pgvectors-rejected').action = 'Keep DB_VECTOR_EXTENSION as it is; vectorchord is not needed.'; }),
  'Codex 2e2: loader keeps and engine re-emits the rule summary ("Operators must keep…" channel)': dir => { textEdit("src/rules.mjs", "return { id: r.id, family: r.family,", "return { summary: r.summary, id: r.id, family: r.family,")(dir); textEdit("src/engine.mjs", "remediation: rule.remediation,", "remediation: rule.remediation, summary: rule.summary,")(dir); },
  'Codex 2e3: engine re-emits evidence titles': textEdit('src/engine.mjs', 'const cite = ids => ids.map(id => ({ id, url: evidence[id].url,', 'const cite = ids => ids.map(id => ({ id, title: evidence[id].title, url: evidence[id].url,'),
  'Codex 2f: drop the backup precondition': rulesEdit(r => { delete rule(r, 'F6-300-env-pgvectors-rejected').remediation.backup; }),
  'Codex 2g: generator ignores backup preconditions': textEdit('src/rules.mjs', 'if (m.backup) text =', 'if (false) text ='),
  'Codex 3a: delete the advisory recommended_stop': rulesEdit(r => { delete rule(r, 'F4-136-avoid-from-old').recommended_stop; }),
  'Codex 3b: engine drops open path risks': textEdit('src/engine.mjs', "open_risks: pathFindings.filter(f => f.label === 'UNKNOWN').map(f => f.rule_id).sort(),", 'open_risks: [],'),
  'Codex 3c: engine drops advisory stops': textEdit('src/engine.mjs', 'advisory_stops: pathFindings.filter(f => f.recommended_stop)', 'advisory_stops: [].filter(f => f.recommended_stop)'),
  'Codex 4a: UNKNOWN reasons lost for incomplete env files': textEdit('src/engine.mjs', 'if (svc.envIncomplete.length) return why(svc.envIncomplete);', 'if (svc.envIncomplete.length) return why([]);'),
  'Codex 4b: UNKNOWN reasons lost for database resolution': textEdit('src/engine.mjs', 'if (reasons.length) return unknown(reasons);', 'if (reasons.length) return unknown([]);'),
  'Codex 4c: UNKNOWN reason lost for missing --current': textEdit('src/engine.mjs', 'evidence: cite(c.evidence), config: [], missing_inputs: [versionMissing] });', 'evidence: cite(c.evidence), config: [], missing_inputs: [] });'),
  'extra: certain finding drops other-service UNKNOWNs': textEdit('src/engine.mjs', 'if (facts.length) return res(true, facts, unknown ? missing : []);', 'if (facts.length) return res(true, facts);'),
  'extra: per-service IMMICH_PORT exemption removed': textEdit('src/engine.mjs', 'if (l.found && l.found.value === val) return { v: false };', ''),
  'P1.3-1: doubt from unidentified services dropped': textEdit('src/engine.mjs', 'if (ctx.db.extra.length) return v ?', 'if (false) return v ?'),
  'P1.3-2a: resolved image reference printed': textEdit('src/engine.mjs', "const imageLabel = img => (img.interpolated ? 'an interpolated image reference' : parseImage(img.value).repo);", 'const imageLabel = img => img.value;'),
  'P1.3-2b: interpolated host printed': textEdit('src/engine.mjs', "const hostLabel = h => (h.interpolated ? 'an interpolated host' : `'${h.host}'`);", "const hostLabel = h => `'${h.host}'`;"),
  'P1.3.2-A: loader keeps undocumented remediation fields (pass-through)': textEdit('src/rules.mjs', "if (Object.keys(m).some(k => !REMEDIATION_KEYS.includes(k)))", 'if (false)'),
  'P1.3.2-B: evidence id grammar dropped for registry keys AND references': dir => { textEdit("src/rules.mjs", "if (!EVIDENCE_ID.test(id)) throw", "if (false) throw")(dir); textEdit("src/rules.mjs", "!EVIDENCE_ID.test(e) || ", "")(dir); },
  'P1.3.2-C: URL whitespace/control AND canonical-form checks dropped': dir => { textEdit("src/rules.mjs", "URL_FORBIDDEN.test(e.url)", "false")(dir); textEdit("src/rules.mjs", "if (u.href !== e.url) throw", "if (false) throw")(dir); },
  'P1.3.2-D: prototype lookup for remediation op': textEdit('src/rules.mjs', 'if (!has(OP, m.op))', 'if (!OP[m.op])'),
  "v0.2-A: mandatory stops reported with a non-intermediate path status": textEdit("src/engine.mjs", "status: stops.size ? 'INTERMEDIATE_REQUIRED' : ", "status: false ? 'INTERMEDIATE_REQUIRED' : "),
  "v0.2-B: Compose schema layer disabled": textEdit("src/compose.mjs", "  validateComposeShape(raw);\n", ""),
  "v0.2-C1: official git-tag registry ignored": textEdit("src/engine.mjs", "const known = new Set([...releases, ...tags]);", "const known = new Set([...releases]);"),
  "v0.2-C2: researched upper bound dropped": textEdit("src/engine.mjs", "if (compareVersions(v, VERSION_POLICY.newest_researched) > 0) throw", "if (false) throw"),
  "v0.2-C3: researched lower bound dropped": textEdit("src/engine.mjs", "if (compareVersions(v, VERSION_POLICY.oldest_supported) < 0) throw", "if (false) throw"),
  "v0.2-C4: UNSUPPORTED_VERSION exits like an input error": textEdit("bin/cri.mjs", "e.category === 'UNSUPPORTED_VERSION' ? 3 : 2", "2"),
  "v0.2-D1: HOST transition rule removed": rulesEdit(r => { r.rules = r.rules.filter(x => x.id !== 'F1-106-host-transition'); }),
  "v0.2-D2: DB image lookup ignores the PostgreSQL major": textEdit("src/engine.mjs", "dbImages.find(d => d.pg === img.pg_major && d.pgvecto_rs === img.pgvecto_rs)", "dbImages[0]"),
  // v0.2.1 post-audit safeguards
  "v0.2.1-H1: env destination guard disabled": textEdit("src/engine.mjs", "  guardEnvDestinations(ctx, findings);\n", ""),
  "v0.2.1-H2: guard ignores an existing, different destination": textEdit("src/engine.mjs", "!writeVals.has(ex.found.value)", "false"),
  "v0.2.1-H3: guard ignores environment: precedence (false collisions)": textEdit("src/engine.mjs", "const involved = ex.found?.fromEnvironment ? own : reach;", "const involved = reach;"),
  "v0.2.1-H4: guard treats unresolved values as equal": textEdit("src/engine.mjs", "values.some(v => v.value === null) ? 'unresolved_value'", "false ? 'unresolved_value'"),
  "v0.2.1-H5: HOST rename applied to the ML service again": rulesEdit(r => { rule(r, 'F1-119-host-renamed').when.all[1].env_set.service = 'immich'; }),
  "v0.2.1-H6: MACHINE_LEARNING_HOST rename applied to the server again": rulesEdit(r => { rule(r, 'F1-106-ml-host-renamed').when.all[1].env_set.service = 'immich'; }),
  "v0.2.1-S1: long-form port target not required": textEdit("src/compose.mjs", "target: [portNum, 'an integer or string', true]", "target: [portNum, 'an integer or string']"),
  "v0.2.1-S2: long-form volume target unchecked": textEdit("src/compose.mjs", "target: [str, 'a string', true], source", "source"),
  "v0.2.1-S3: env_file.required type unchecked": textEdit("src/compose.mjs", "{ required: [v => typeof v === 'boolean', 'a boolean'], ", "{ "),
  "v0.2.1-J1: YAML alias errors escape as stack traces": textEdit("src/compose.mjs", "try { raw = doc.toJS({ maxAliasCount: 100 }); } catch { throw", "raw = doc.toJS({ maxAliasCount: 100 }); if (false) { throw"),
  "v0.2.1-J2: option errors ignore --json and echo the option": textEdit("bin/cri.mjs", "  fail({ category: 'INPUT_ERROR', message: e.code ===", "  console.error(e.message); process.exit(2);\n  fail({ category: 'INPUT_ERROR', message: e.code ==="),
  "v0.2.1-R1: invalid version echoed": textEdit("src/engine.mjs", "`invalid ${role} version (expected", "`invalid ${role} version ${raw} (expected"),
  "v0.2.1-R2: unknown version echoed": textEdit("src/engine.mjs", "`${role} version is not a known Immich release", "`${role} ${v.raw} is not a known Immich release"),
  "v0.2.1-R3: YAML parser message quoted": textEdit("src/compose.mjs", "invalid YAML (${e.code})", "invalid YAML (${e.code}: ${e.message})"),
  "v0.2.1-R4: input path echoed": textEdit("src/compose.mjs", "'input directory not found or not a directory (the path is not repeated here)'", "`input directory not found: ${dir}`"),
  // v0.2.2 closure-audit safeguards
  "v0.2.2-U1: unchecked destination treated as absent": textEdit("src/engine.mjs", ": ex.unknown ? 'existing_value_unchecked'", ": false ? 'existing_value_unchecked'"),
  "v0.2.2-U2: unchecked destination counted as a known collision": textEdit("src/engine.mjs", "c.reason === 'different_values' || c.reason === 'existing_value_differs'", "c.reason !== 'unresolved_value'"),
  "v0.2.2-U3: reasons for an unchecked destination dropped": textEdit("src/engine.mjs", "        : unchecked;", "        : [];"),
  "v0.2.2-U4: shared reader without its own value gets an unconditional write": textEdit("src/engine.mjs", ": shared ? 'reaches_other_service'", ": false ? 'reaches_other_service'"),
  "v0.2.2-P1: SERVER_PORT rule back to every Immich service": rulesEdit(r => { rule(r, 'F1-106-port-host-renamed').when.all[1].env_set = { service: 'immich', keys: ['SERVER_PORT'] }; }),
  "v0.2.2-P2: command identity filter ignored": textEdit("src/engine.mjs", "      if (m.v !== cmd.match) continue;\n", ""),
  "v0.2.2-P3: ambiguous identity treated as a non-match": textEdit("src/engine.mjs", "if (keys.some(k => !envLookup(s, k).absent)) { anyUnknown = true; missing.push(...m.why); }", ""),
  "v0.2.2-P4: microservices port renamed after the container's removal": rulesEdit(r => { const x = rule(r, 'F1-106-microservices-port-renamed'); x.when.all = x.when.all.filter(c => !c.target_lt); }),
  "v0.2.2-P5: MACHINE_LEARNING_PORT rule widened to the server": rulesEdit(r => { rule(r, 'F1-106-ml-port-renamed').when.all[1].env_set.service = 'immich'; }),
  "v0.2.2-L1: missing --rules file escapes as INTERNAL_ERROR": textEdit("bin/cri.mjs", "  if (v.rules) {\n    try {", "  if (false) {\n    try {"),
  "v0.2.2-E1: no-command early return before the entrypoint check (restored defect)": textEdit("src/engine.mjs", "  if (s.entrypointSet) return { v: U, why: [`command of ${s.name} (custom entrypoint; not interpreted)`] };\n  const c = s.command;", "  if (!s.command && !s.extendsFrom.length) return { v: false };\n  if (s.entrypointSet) return { v: U, why: [`command of ${s.name} (custom entrypoint; not interpreted)`] };\n  const c = s.command;"),
  "v0.2.1-V1: empty prerelease identifiers accepted": textEdit("src/version.mjs", "[A-Za-z-][0-9A-Za-z-]*)'", "[A-Za-z-][0-9A-Za-z-]*|)'"),
};

export function runMutation(name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cri-mutant-'));
  try {
    for (const p of COPY) fs.cpSync(path.join(ROOT, p), path.join(tmp, p), { recursive: true, dereference: true });
    MUTATIONS[name](tmp);
    const r = spawnSync(process.execPath, ['--test'], { cwd: tmp, encoding: 'utf8' });
    const failed = [...(r.stdout ?? '').matchAll(/^✖ (.+?) \(\d/gm)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i && v !== 'failing tests:');
    return { name, exit: r.status, caught: r.status !== 0, failed };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.error(`cleanup of ${tmp} failed: ${e.message}`); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--evidence');
  const outDir = i > 0 ? process.argv[i + 1] : 'evidence/phase1.2';
  const lines = [];
  for (const name of Object.keys(MUTATIONS)) {
    const r = runMutation(name);
    const verdict = name.startsWith('none') ? (r.caught ? 'BROKEN BASELINE' : 'ok (passes)') : (r.caught ? 'CAUGHT' : 'SURVIVED');
    lines.push(`${verdict.padEnd(16)} ${name}${r.failed.length ? `\n                 failing: ${r.failed.slice(0, 4).join(' | ')}${r.failed.length > 4 ? ` (+${r.failed.length - 4} more)` : ''}` : ''}`);
    console.log(lines.at(-1));
  }
  // The sanity run is a control, not a mutation: it is excluded from the rate.
  const real = lines.filter(l => !l.includes('none (sanity'));
  const caught = real.filter(l => l.startsWith('CAUGHT')).length;
  lines.push('', `real mutations caught: ${caught}/${real.length} (control run excluded: ${lines[0].startsWith('ok') ? 'passed' : 'FAILED'})`);
  console.log(lines.at(-1));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'mutation-check.txt'), lines.join('\n') + '\n');
}
