// Loads and statically lints the rule file. A rule file that fails lint is rejected before any analysis.
import fs from 'node:fs';
import YAML from 'yaml';
import { parseVersion, compareVersions } from './version.mjs';

export class RuleError extends Error { get category() { return 'RULE_ERROR'; } }

export const KIND_LABEL = { mandatory: 'ACTION_REQUIRED', advisory: 'ADVISORY', unverified: 'UNKNOWN' };
export const FAMILIES = {
  F1: 'Environment variables', F2: 'Service architecture', F3: 'Direct-upgrade floor',
  F4: 'Intermediate migration', F5: 'PostgreSQL / VectorChord', F6: 'pgvecto.rs removal',
};
const SERVICES = ['server', 'ml', 'immich', 'any', 'database'];
// The only source of user-facing instructions. Each op: [subjects min,max], [replacements min,max], and its template.
// An op not listed here is rejected at load time; nothing is guessed.
const list = a => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
const OP = {
  upgrade_via: [[0, 9], [1, 9], (s, r) => `Upgrade to ${list(r)} first and confirm Immich starts successfully${s.length ? `; do not upgrade directly to ${list(s)}` : ''}.`],
  rename_env: [[1, 9], [1, 9], (s, r) => `Rename ${s.map((x, i) => `${x} to ${r[i]}`).join(', ')}.`],
  replace_env: [[1, 9], [1, 9], (s, r) => `Remove ${list(s)} and configure ${list(r)} instead (see the cited source for the values).`],
  set_absolute_path: [[1, 1], [2, 2], (s, r) => `Set ${s[0]} to an absolute path, recreate the container, then run \`${r.join(' ')}\`.`],
  remove_env: [[1, 9], [1, 9], (s, r) => `Remove ${list(s)} and configure ${list(r)} in the admin settings instead.`],
  split_env: [[1, 1], [2, 9], (s, r) => `Replace ${s[0]} with ${list(r)}.`],
  remove_command: [[1, 9], [0, 0], s => `Remove the \`command:\` that runs ${list(s)} from the affected services.`],
  remove_service: [[1, 1], [0, 0], s => `Remove the ${s[0]} service, then run \`docker compose down --remove-orphans\`.`],
  change_container_port: [[1, 1], [2, 2], (s, r) => `Change the container side of the port mapping from ${s[0]} to ${r[0]}, or set ${r[1]} on the same service; update reverse proxies that target ${s[0]}.`],
  investigate: [[1, 9], [0, 0], s => `This cannot be decided from the configuration; do not upgrade directly to ${list(s)} until it is checked.`],
  // p (engine-supplied, from parsed tag numbers and the validated db_images table): exact image, components only, or nothing.
  replace_db_image: [[1, 1], [1, 1], (s, r, p) => (p?.image
    ? `Replace the ${s[0]} image with ${p.image} (documented for PostgreSQL ${p.pg} with pgvecto.rs ${p.pgvecto_rs}; keep the PostgreSQL major version), and remove the legacy command/healthcheck overrides.`
    : p?.pg
      ? `Replace the ${s[0]} image with a ${r[0]} image for PostgreSQL ${p.pg} that includes VectorChord and pgvecto.rs ${p.pgvecto_rs}; no documented tag is known for this combination, so verify the exact tag in the cited upgrading docs, never change the PostgreSQL major version, and remove the legacy command/healthcheck overrides.`
      : `Replace the ${s[0]} image with a ${r[0]} image that matches the PostgreSQL major version and pgvecto.rs version of the current image (they could not be read here: verify both in your compose file), and remove the legacy command/healthcheck overrides.`)],
  duplicate_env: [[1, 1], [1, 9], (s, r) => `Set ${list(r)} to the same value as ${s[0]} and keep ${s[0]} as well: until the release that stops reading ${s[0]}, the server still uses it (see the cited sources).`],
  // Engine-generated only (env destination guard): replaces a rename/duplicate whose destination would collide.
  // p.reason (engine-supplied): 'unverified' when the values could not be compared; otherwise a known collision.
  resolve_env_conflict: [[1, 9], [1, 9], (s, r, p) => (p?.reason === 'unverified'
    ? `Verify before renaming ${list(s)} to ${list(r)}: the values involved could not be compared (an unresolved or interpolated value, an existing ${list(r)} in an input that could not be read, or a shared env file that would also change ${list(r)} for a service that has no value of its own), so a conflicting ${list(r)} cannot be ruled out (see the listed conflicts). If they differ, set ${list(r)} once per service, in that service's own \`environment:\`, to the value it needs; if they are equal, rename and remove ${list(s)}.`
    : `Do not rename ${list(s)} to ${list(r)} as is: that would give ${list(r)} more than one value in one configuration scope, or overwrite an existing ${list(r)} that has a different value (see the listed conflicts). Decide which value each affected service needs, set ${list(r)} once per service (in that service's own \`environment:\` when services that share an env file need different values), then remove ${list(s)}.`)],
  unset_env: [[1, 1], [1, 1], (s, r) => `Remove ${s[0]} (auto-detect) or set it to ${r[0]}.`],
  remove_db_command: [[1, 9], [0, 0], s => `Remove the legacy \`command:\` override (${list(s)}) from the database service.`],
};
export const OPS = Object.keys(OP);

// Own-property lookup only: names inherited from Object.prototype (constructor, toString, __proto__) never match.
const has = (o, k) => typeof k === 'string' && Object.hasOwn(o, k);
const REMEDIATION_KEYS = ['op', 'subjects', 'replacements', 'backup', 'before'];

// Validates a remediation against its op schema and returns a NEW object with only the documented fields.
// Throws RuleError (never a TypeError) on anything else; rejected values are not echoed in the message.
export function validateRemediation(id, m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new RuleError(`${id}: remediation must be a mapping`);
  if (Object.keys(m).some(k => !REMEDIATION_KEYS.includes(k))) throw new RuleError(`${id}: remediation has an undocumented field (allowed: ${REMEDIATION_KEYS.join(', ')})`);
  if (!has(OP, m.op)) throw new RuleError(`${id}: remediation op is not supported (one of ${OPS.join(', ')})`);
  const [[smin, smax], [rmin, rmax]] = OP[m.op];
  // Tokens are single words (no whitespace), so no sentence can be smuggled into a generated instruction.
  const ok = (a, min, max) => Array.isArray(a) && a.length >= min && a.length <= max && a.every(x => typeof x === 'string' && TOKEN.test(x));
  if (!ok(m.subjects, smin, smax) || !ok(m.replacements, rmin, rmax)) throw new RuleError(`${id}: remediation ${m.op} needs ${smin}-${smax} subjects and ${rmin}-${rmax} replacements (single-word tokens)`);
  if (m.op === 'rename_env' && m.subjects.length !== m.replacements.length) throw new RuleError(`${id}: rename_env needs one replacement per subject`);
  if (m.backup !== undefined && typeof m.backup !== 'boolean') throw new RuleError(`${id}: remediation.backup must be true/false`);
  if (m.before !== undefined && !parseVersion(m.before)) throw new RuleError(`${id}: remediation.before is not a version`);
  return { op: m.op, subjects: [...m.subjects], replacements: [...m.replacements], ...(m.backup ? { backup: true } : {}), ...(m.before !== undefined ? { before: parseVersion(m.before).raw } : {}) };
}

// Renders the instruction from a validated remediation; the only source of user-facing instructions.
export function renderAction(id, m0, params) {
  const m = validateRemediation(id, m0);
  let text = OP[m.op][2](m.subjects, m.replacements, params);
  if (m.backup) text = `Back up the database, then ${text[0].toLowerCase()}${text.slice(1)}`;
  if (m.before) text = `Before upgrading to ${m.before}: ${text[0].toLowerCase()}${text.slice(1)}`;
  return text;
}

// Evidence: IDs, URLs and revisions all have strict grammars; only {id, url, revision} is ever emitted.
const EVIDENCE_ID = /^E\d{2}$/;
// Any whitespace, C0/C1 control or Unicode line/paragraph separator is rejected BEFORE parsing,
// because the URL parser silently strips some of them (tab, newline) and would hide the payload.
const URL_FORBIDDEN = new RegExp('[\\s\\x00-\\x1F\\x7F-\\x9F' + String.fromCharCode(0x2028, 0x2029) + ']');
export function validateEvidenceEntry(id, e) {
  if (!EVIDENCE_ID.test(id)) throw new RuleError('evidence: an evidence id does not match E<nn>');
  if (!e || typeof e !== 'object' || typeof e.url !== 'string' || URL_FORBIDDEN.test(e.url)) throw new RuleError(`evidence ${id}: url is missing or contains whitespace/control characters`);
  let u;
  try { u = new URL(e.url); } catch { throw new RuleError(`evidence ${id}: url is not a URL`); }
  if (u.protocol !== 'https:') throw new RuleError(`evidence ${id}: url must be https`);
  if (u.href !== e.url) throw new RuleError(`evidence ${id}: url is not in canonical form`);
  if (typeof e.revision !== 'string' || !REVISION.test(e.revision)) throw new RuleError(`evidence ${id}: revision does not match the revision grammar`);
  return { id, url: u.href, revision: e.revision };
}
const TOKEN = /^[A-Za-z0-9_.:=/@<>-]+$/;
const V = 'v\\d+\\.\\d+\\.\\d+', SHA = '[0-9a-f]{7,40}', DATE = '\\d{4}-\\d{2}-\\d{2}';
const REVISION = new RegExp(`^(tag ${V}|tags ${V}((, | and )${V})+|merge ${SHA}|merged ${DATE}|[A-Za-z0-9_./-]+ @ ${SHA}|\\d+ results ${DATE})$`);
const isToken = x => typeof x === 'string' && TOKEN.test(x);
const isEnvKey = x => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x);
// predicate name -> validator of its argument
const PREDICATES = {
  crosses: a => parseVersion(a), target_gte: a => parseVersion(a), target_lt: a => parseVersion(a),
  target_eq: a => parseVersion(a), current_lt: a => parseVersion(a), current_lte: a => parseVersion(a),
  // Arguments that are printed in findings (env keys/values, argv, text) must match token grammars.
  env_set: a => SERVICES.includes(a?.service) && Array.isArray(a.keys) && a.keys.length && a.keys.every(isEnvKey)
    // optional service-identity filter by command prefix (see envPredicate)
    && (a.command === undefined || (a.command && typeof a.command === 'object' && Object.keys(a.command).every(k => k === 'argv' || k === 'match')
      && Array.isArray(a.command.argv) && a.command.argv.length > 0 && a.command.argv.every(isToken) && typeof a.command.match === 'boolean')),
  env_equals: a => SERVICES.includes(a?.service) && isEnvKey(a.key) && isToken(a.value),
  env_relative_path: a => SERVICES.includes(a?.service) && isEnvKey(a.key),
  command_contains: a => SERVICES.includes(a?.service) && isToken(a.text),
  command_argv: a => SERVICES.includes(a?.service) && Array.isArray(a.argv) && a.argv.length && a.argv.every(isToken),
  container_port: a => SERVICES.includes(a?.service) && Number.isInteger(a.equals)
    && (a.unless_env === undefined || (a.unless_env && typeof a.unless_env === 'object' && !Array.isArray(a.unless_env)
      && Object.entries(a.unless_env).every(([k, v]) => isEnvKey(k) && isToken(v)))),
  db_kind: a => Array.isArray(a?.in) && a.in.length && a.in.every(k => ['pgvecto-rs', 'immich-postgres', 'pgvector'].includes(k)),
};

function lintCondition(c, where) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new RuleError(`${where}: condition must be a mapping`);
  const keys = Object.keys(c);
  if (keys.length !== 1) throw new RuleError(`${where}: condition must have exactly one key, got ${keys.join(', ')}`);
  const [k] = keys;
  if (k === 'all' || k === 'any') {
    if (!Array.isArray(c[k]) || !c[k].length) throw new RuleError(`${where}: ${k} needs a non-empty list`);
    c[k].forEach((x, i) => lintCondition(x, `${where}.${k}[${i}]`));
  } else if (k === 'not') lintCondition(c.not, `${where}.not`);
  else if (!has(PREDICATES, k)) throw new RuleError(`${where}: unknown predicate`);
  else if (!PREDICATES[k](c[k])) throw new RuleError(`${where}: invalid argument for '${k}'`);
}

export function loadRules(rulesFile, evidenceFile, knownVersions) {
  const parse = f => {
    const doc = YAML.parseDocument(fs.readFileSync(f, 'utf8'), { uniqueKeys: true });
    if (doc.errors.length) throw new RuleError(`${f}: ${doc.errors[0].message.split('\n')[0]}`);
    return doc.toJS();
  };
  const rawEvidence = parse(evidenceFile) ?? {};
  if (typeof rawEvidence !== 'object' || Array.isArray(rawEvidence)) throw new RuleError('evidence: registry must be a mapping');
  // Explicit projection: only validated {id, url, revision} survive; titles stay internal and are never emitted.
  const evidence = Object.fromEntries(Object.entries(rawEvidence).map(([id, e]) => [id, validateEvidenceEntry(id, e)]));
  const set = parse(rulesFile) ?? {};
  if (set.schema !== 1) throw new RuleError('rules: unsupported schema (expected 1)');
  const ids = new Set();
  const version = (id, k, v) => { const p = parseVersion(v); if (!p) throw new RuleError(`${id}: ${k} is not a version`); return p.raw; };
  // Shared checks; returns the validated fields common to rules and path constraints (a NEW object, no pass-through).
  const common = (r, where) => {
    if (!r || typeof r !== 'object') throw new RuleError(`${where}: must be a mapping`);
    if (typeof r.id !== 'string' || !/^F[1-6]-[A-Za-z0-9.-]+$/.test(r.id)) throw new RuleError(`${where}: id must match F<n>-<token>`);
    if (ids.has(r.id)) throw new RuleError(`${where}: duplicate rule id ${r.id}`);
    ids.add(r.id);
    if (!has(FAMILIES, r.family)) throw new RuleError(`${r.id}: unknown family`);
    if (!Array.isArray(r.evidence) || !r.evidence.length) throw new RuleError(`${r.id}: no evidence`);
    // Referenced IDs pass the same grammar as registry keys before any lookup.
    for (const e of r.evidence) if (typeof e !== 'string' || !EVIDENCE_ID.test(e) || !has(evidence, e)) throw new RuleError(`${r.id}: an evidence reference is not a valid id in the evidence registry`);
    // summary is internal, non-authoritative metadata: it is never emitted, so it cannot act as an instruction.
    if (!r.summary) throw new RuleError(`${r.id}: summary is required`);
    if (r.action !== undefined) throw new RuleError(`${r.id}: free-text 'action' is not allowed; the instruction is generated from remediation`);
    const remediation = validateRemediation(r.id, r.remediation);
    return { id: r.id, family: r.family, evidence: [...r.evidence], remediation, action: renderAction(r.id, remediation) };
  };
  const constraints = (set.path_constraints ?? []).map((c, i) => {
    const out = common(c, `path_constraints[${i}]`);
    const [applies, requires, stop] = ['applies_if_target_gte', 'requires_current_gte', 'stop'].map(k => version(c.id, k, c[k]));
    if (compareVersions(stop, requires) < 0) throw new RuleError(`${c.id}: stop ${stop} does not satisfy requires_current_gte ${requires}`);
    if (compareVersions(stop, applies) >= 0) throw new RuleError(`${c.id}: stop ${stop} is not below applies_if_target_gte ${applies}`);
    if (knownVersions && !knownVersions.has(stop)) throw new RuleError(`${c.id}: stop ${stop} is not a known Immich release`);
    return { ...out, applies_if_target_gte: applies, requires_current_gte: requires, stop };
  });
  const rules = (set.rules ?? []).map((r, i) => {
    const out = common(r, `rules[${i}]`);
    if (!has(KIND_LABEL, r.kind)) throw new RuleError(`${r.id}: unknown kind`);
    if (typeof r.action_key !== 'string' || !/^[a-z]+(\.[a-z-]+)*(:[A-Za-z0-9_.=-]+)?$/.test(r.action_key)) throw new RuleError(`${r.id}: action_key must be a structured key (no prose)`);
    let recommended_stop;
    if (r.recommended_stop !== undefined) {
      if (r.kind !== 'advisory') throw new RuleError(`${r.id}: recommended_stop is only allowed on advisory rules`);
      recommended_stop = version(r.id, 'recommended_stop', r.recommended_stop);
      if (knownVersions && !knownVersions.has(recommended_stop)) throw new RuleError(`${r.id}: recommended_stop ${recommended_stop} is not a known Immich release`);
    }
    lintCondition(r.when, `${r.id}.when`);
    return { ...out, kind: r.kind, action_key: r.action_key, when: r.when, ...(recommended_stop ? { recommended_stop } : {}) };
  });
  // Documented VectorChord image per (PostgreSQL major, pgvecto.rs version). The tag must encode the same PostgreSQL
  // major and pgvecto.rs version, so a PostgreSQL 14 image can never be suggested for a PostgreSQL 16 data directory.
  const dbImages = (set.db_images ?? []).map((d, i) => {
    const where = `db_images[${i}]`;
    if (!d || typeof d !== 'object' || Object.keys(d).some(k => !['pg', 'pgvecto_rs', 'image', 'evidence'].includes(k))) throw new RuleError(`${where}: only pg, pgvecto_rs, image, evidence are allowed`);
    if (!/^\d{2}$/.test(String(d.pg)) || !/^\d+\.\d+\.\d+$/.test(String(d.pgvecto_rs))) throw new RuleError(`${where}: pg must be a major version and pgvecto_rs a version`);
    const m = /^ghcr\.io\/immich-app\/postgres:(\d{2})-vectorchord\d+\.\d+\.\d+-pgvectors(\d+\.\d+\.\d+)$/.exec(String(d.image));
    if (!m || m[1] !== String(d.pg) || m[2] !== String(d.pgvecto_rs)) throw new RuleError(`${where}: image tag must encode the same PostgreSQL major and pgvecto.rs version`);
    if (!Array.isArray(d.evidence) || !d.evidence.length || d.evidence.some(e => !EVIDENCE_ID.test(e) || !has(evidence, e))) throw new RuleError(`${where}: evidence must reference the registry`);
    return { pg: String(d.pg), pgvecto_rs: String(d.pgvecto_rs), image: d.image, evidence: [...d.evidence] };
  });
  return { rules, constraints, evidence, dbImages };
}
