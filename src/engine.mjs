// Rule evaluation. Three-valued logic: every predicate returns { v: true|false|'unknown', facts, missing }.
// The engine receives only (input directory, current, target); it has no access to test expectations.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersion, compareVersions, loadKnownVersions } from './version.mjs';
import { loadProject, InputError, UNKNOWN_MARK } from './compose.mjs';
import { loadRules, renderAction, validateRemediation, KIND_LABEL, FAMILIES } from './rules.mjs';

export { InputError };
export class ConflictError extends Error { get category() { return 'RULE_CONFLICT'; } }
export class UnsupportedVersionError extends InputError { get category() { return 'UNSUPPORTED_VERSION'; } }
// Version support policy (see README): official release or git tag, inside the reviewed release-note range.
export const VERSION_POLICY = { oldest_supported: 'v1.102.0', newest_researched: 'v3.4.0-rc.3', registry_fetched: '2026-11-10' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULTS = {
  rulesFile: path.join(ROOT, 'rules/immich.rules.yaml'),
  evidenceFile: path.join(ROOT, 'rules/evidence.yaml'),
  versionsFile: path.join(ROOT, 'data/immich-release-tags.txt'),
  tagsFile: path.join(ROOT, 'data/immich-git-tags.txt'),
};
const PRECEDENCE = ['ACTION_REQUIRED', 'UNKNOWN', 'ADVISORY', 'NOT_APPLICABLE'];
const U = 'unknown';
const SHELLS = new Set(['sh', 'bash', 'ash', 'dash', 'zsh']);
const DEFAULT_DB_HOST = 'database'; // Immich default for DB_HOSTNAME (E09)

// ---------- images ----------
// Normalises a reference to { repo, tag } using Docker's rules (implicit docker.io and library/).
export function parseImage(ref) {
  let s = ref.trim().toLowerCase();
  const at = s.indexOf('@');
  if (at >= 0) s = s.slice(0, at);
  let tag = null;
  const colon = s.lastIndexOf(':');
  if (colon > s.lastIndexOf('/')) { tag = s.slice(colon + 1); s = s.slice(0, colon); }
  const parts = s.split('/');
  if (parts.length === 1 || !(parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) parts.unshift('docker.io');
  if (['registry.hub.docker.com', 'index.docker.io', 'registry-1.docker.io'].includes(parts[0])) parts[0] = 'docker.io';
  if (parts[0] === 'docker.io' && parts.length === 2) parts.splice(1, 0, 'library');
  return { repo: parts.join('/'), tag };
}
const REPO = {
  server: 'ghcr.io/immich-app/immich-server', ml: 'ghcr.io/immich-app/immich-machine-learning',
  pgvectors: 'docker.io/tensorchord/pgvecto-rs', immichPg: 'ghcr.io/immich-app/postgres', pgvector: 'docker.io/pgvector/pgvector',
};
function dbKind(img) {
  const { repo, tag } = parseImage(img.value);
  let m;
  if (repo === REPO.pgvectors) return (m = /^pg(\d+)-v(\d+\.\d+\.\d+)$/.exec(tag ?? ''))
    ? { kind: 'pgvecto-rs', detail: `PostgreSQL ${m[1]}, pgvecto.rs ${m[2]}`, pg: m[1], pgvecto_rs: m[2] }
    : { kind: 'pgvecto-rs', detail: 'versions not readable from tag' };
  if (repo === REPO.immichPg && (m = /^(\d+)-vectorchord([\d.]+)(?:-pgvectors([\d.]+))?$/.exec(tag ?? '')))
    return { kind: 'immich-postgres', detail: `PostgreSQL ${m[1]}, VectorChord ${m[2]}${m[3] ? `, pgvecto.rs ${m[3]}` : ''}` };
  if (repo === REPO.pgvector) return { kind: 'pgvector', detail: tag ? `tag ${tag}` : 'no tag' };
  return { kind: U };
}
const roleUnknownReason = s => s.image.absent
  ? (s.extendsFrom.length ? `image of service ${s.name} (may come from ${s.extendsFrom.join(', ')})` : `role of service ${s.name} (no image; build-only)`)
  : `image of service ${s.name} (unresolved: ${s.image.unresolved.join(', ')})`;
function roles(project) {
  const r = { server: [], ml: [], maybe: [] };
  for (const s of project.services) {
    if (s.image.value === null) { r.maybe.push(s); continue; }
    const { repo } = parseImage(s.image.value);
    if (repo === REPO.server) r.server.push(s);
    else if (repo === REPO.ml) r.ml.push(s);
  }
  return r;
}

// ---------- environment ----------
function envLookup(svc, key) {
  const why = list => ({ unknown: list.map(w => `${w} (service ${svc.name})`) });
  if (svc.overridden.length) return why(svc.overridden);
  const e = svc.env[key];
  if (e?.fromEnvironment) return { found: e };
  if (svc.envIncomplete.length) return why(svc.envIncomplete);
  // Under an unmerged extends, a base `environment:` outranks a local env_file value, so only local `environment:` is certain.
  if (svc.extendsFrom.length) return why(svc.extendsFrom.map(w => `environment from ${w} (not merged)`));
  if (e) return { found: e };
  return { absent: true };
}

// Which compose service is Immich's database? Follows DB_URL, then DB_HOSTNAME (default `database`), like the server does.
// Values that came from interpolation may carry secrets, so they are never printed. Images print as repository only (no tag).
const hostLabel = h => (h.interpolated ? 'an interpolated host' : `'${h.host}'`);
const imageLabel = img => (img.interpolated ? 'an interpolated image reference' : parseImage(img.value).repo);

// The database host one service would use: { host, source, interpolated } or { reasons }.
function hostOf(s) {
  if (s.netIndirection.length) return { reasons: [`database host of ${s.name} (${s.netIndirection.join(', ')} not modeled)`] };
  const url = envLookup(s, 'DB_URL');
  if (url.unknown) return { reasons: url.unknown };
  if (url.found) {
    if (url.found.value === null) return { reasons: [`DB_URL of ${s.name} (unresolved: ${url.found.unresolved.join(', ')})`] };
    try {
      const u = new URL(url.found.value);
      const host = decodeURIComponent(u.hostname);
      if (!host || u.searchParams.has('host')) return { reasons: [`DB_URL of ${s.name} (socket or non-TCP host)`] };
      return { host, source: `DB_URL (${url.found.source})`, interpolated: url.found.interpolated };
    } catch { return { reasons: [`DB_URL of ${s.name} (not a parsable URL)`] }; }
  }
  for (const k of ['DB_URL_FILE', 'DB_HOSTNAME_FILE']) if (envLookup(s, k).found) return { reasons: [`${k} of ${s.name} (secret-file indirection; not read)`] };
  const h = envLookup(s, 'DB_HOSTNAME');
  if (h.unknown) return { reasons: h.unknown };
  if (h.found) return h.found.value === null ? { reasons: [`DB_HOSTNAME of ${s.name} (unresolved: ${h.found.unresolved.join(', ')})`] } : { host: h.found.value, source: `DB_HOSTNAME (${h.found.source})`, interpolated: h.found.interpolated };
  return { host: DEFAULT_DB_HOST, source: 'DB_HOSTNAME default', interpolated: false };
}

// The compose service a host names: { service } or { reasons }.
function serviceFor(project, h) {
  const matches = project.services.filter(s => s.names.some(n => n.value === h.host));
  const unresolvedNames = project.services.filter(s => s.names.some(n => n.unresolved));
  if (matches.length > 1) return { reasons: [`database host ${hostLabel(h)} matches several services (${matches.map(s => s.name).join(', ')})`] };
  if (matches.length === 1 && !unresolvedNames.length) return { service: matches[0] };
  if (unresolvedNames.length) return { reasons: unresolvedNames.map(s => `network names of service ${s.name} (unresolved)`) };
  if (project.hidden.length) return { reasons: [`database host ${hostLabel(h)} may be a service in ${project.hidden.join(', ')} (not merged)`] };
  return { reasons: [`database host ${hostLabel(h)} is not a service in this compose (external database?)`] };
}

// Which compose service is Immich's database? Follows DB_URL, then DB_HOSTNAME (default `database`), like the server does.
// `extra` keeps the doubt raised by services whose image is unknown: they may be Immich servers using another database.
function resolveDatabase(project, r) {
  const unknown = reasons => ({ service: null, unknown: [...new Set(reasons)], extra: [] });
  if (!r.server.length) return unknown(['immich-server service (needed to find the configured database host)']);
  const hosts = [], reasons = [];
  for (const s of r.server) { const h = hostOf(s); if (h.reasons) reasons.push(...h.reasons); else hosts.push(h); }
  if (reasons.length) return unknown(reasons);
  if (new Set(hosts.map(h => h.host)).size > 1) return unknown([`database host (immich-server services disagree on ${hosts.length} hosts)`]);
  const m = serviceFor(project, hosts[0]);
  if (m.reasons) return unknown(m.reasons);
  const extra = [];
  for (const s of r.maybe) {
    const h = hostOf(s);
    const other = h.reasons ?? (serviceFor(project, h).service === m.service ? null : serviceFor(project, h).reasons ?? [`database service ${serviceFor(project, h).service.name}`]);
    if (other) extra.push(`${roleUnknownReason(s)} may be another Immich server with its own database: ${other.join('; ')}`);
  }
  return { service: m.service, host: hosts[0].host, hostSource: hosts[0].source, hostInterpolated: hosts[0].interpolated, unknown: [], extra };
}

function select(ctx, sel) {
  const r = ctx.roles;
  const missing = [];
  if (sel === 'database') {
    if (!ctx.db.service) return { members: [], missing: [...ctx.db.unknown], unknown: true };
    return { members: [ctx.db.service], missing: [...ctx.db.extra], unknown: ctx.db.extra.length > 0 };
  }
  const members = sel === 'server' ? r.server : sel === 'ml' ? r.ml : sel === 'immich' ? [...r.server, ...r.ml] : ctx.project.services;
  // server is required by Immich, so its absence is unknown; ML is optional, so no ML service = nothing to check.
  const absentRequired = (sel === 'server' || sel === 'immich') && !r.server.length;
  if (absentRequired) missing.push('immich-server service (no service with the ghcr.io/immich-app/immich-server image)');
  for (const s of r.maybe) missing.push(roleUnknownReason(s));
  for (const h of ctx.project.hidden) missing.push(`services possibly defined in ${h} (not merged)`);
  return { members, missing, unknown: absentRequired || r.maybe.length > 0 || ctx.project.hidden.length > 0 };
}

// ---------- predicates ----------
const res = (v, facts = [], missing = []) => ({ v, facts, missing });
const versionMissing = 'running Immich version (pass --current)';
const src = (ctx, line) => (line ? `${ctx.project.composeName}:${line}` : ctx.project.composeName);

// test(entry) -> true | false | U. `show` is the printed value: a classification or the rule literal, never the raw value.
// cmd ({argv, match}, optional): only services whose command does (match: true) or does not (match: false) start with
// argv are checked, e.g. the separate `start.sh microservices` container vs the API server of the same image.
// A service whose command cannot be interpreted, and that sets one of the keys, is UNKNOWN.
function envPredicate(ctx, sel, keys, test, show, cmd) {
  const { members, missing: selMissing, unknown: selUnknown } = select(ctx, sel);
  const facts = [], missing = [...selMissing];
  let anyUnknown = selUnknown;
  for (const s of members) {
    if (cmd) {
      const m = s.overridden.length ? { v: U, why: s.overridden.map(o => `service ${s.name} ${o}`) } : argvMatch(ctx, s, cmd.argv);
      if (m.v === U) {
        if (keys.some(k => !envLookup(s, k).absent)) { anyUnknown = true; missing.push(...m.why); }
        continue;
      }
      if (m.v !== cmd.match) continue;
    }
    for (const key of keys) {
      const l = envLookup(s, key);
      if (l.found) {
        const t = test(l.found);
        if (t === true) facts.push({ service: s.name, field: `environment.${key}`, value: show, source: l.found.source });
        else if (t === U) { anyUnknown = true; missing.push(...l.found.unresolved.map(x => `${x} (used by ${s.name}.${key})`)); }
      } else if (l.unknown) { anyUnknown = true; missing.push(...l.unknown); }
    }
  }
  // A certain match on one service must not erase what could not be checked on others.
  if (facts.length) return res(true, facts, anyUnknown ? missing : []);
  return anyUnknown ? res(U, [], missing) : res(false);
}

// Shared walk over a field of the selected services. check(svc) -> { v, fact?, why? }.
function fieldPredicate(ctx, sel, check) {
  const { members, missing, unknown: selUnknown } = select(ctx, sel);
  let unknown = selUnknown;
  const facts = [];
  for (const s of members) {
    if (s.overridden.length) { unknown = true; missing.push(...s.overridden.map(o => `service ${s.name} ${o}`)); continue; }
    const c = check(s);
    if (c.v === true) facts.push(c.fact);
    else if (c.v === U) { unknown = true; missing.push(...c.why); }
  }
  if (facts.length) return res(true, facts, unknown ? missing : []);
  return unknown ? res(U, [], missing) : res(false);
}
const unknownTok = t => t.includes(UNKNOWN_MARK);
// argv prefix match of one service's command: argv[0] by basename. Unknown tokens, shell wrappers and entrypoint
// overrides are UNKNOWN; no command is a non-match. Returns { v, fact?, why? }.
function argvMatch(ctx, s, argv) {
  // Checked first: a custom entrypoint (any value) decides what runs, so a missing command is not evidence of the default.
  if (s.entrypointSet) return { v: U, why: [`command of ${s.name} (custom entrypoint; not interpreted)`] };
  const c = s.command;
  if (!c) return s.extendsFrom.length ? { v: U, why: s.extendsFrom.map(w => `command of ${s.name} (may come from ${w})`) } : { v: false };
  if (c.parseError) return { v: U, why: [`command of ${s.name} (unbalanced quotes)`] };
  const t = c.tokens;
  if (t.length && !unknownTok(t[0]) && SHELLS.has(path.posix.basename(t[0])) && t.includes('-c')) return { v: U, why: [`command of ${s.name} (shell-wrapped; not interpreted)`] };
  for (let i = 0; i < argv.length; i++) {
    if (t[i] === undefined) return { v: false };
    if (unknownTok(t[i])) return { v: U, why: c.unresolved.map(x => `${x} (command of ${s.name})`) };
    if ((i === 0 ? path.posix.basename(t[i]) : t[i]) !== argv[i]) return { v: false };
  }
  return { v: true, fact: { service: s.name, field: 'command', value: `starts with: ${argv.join(' ')}`, source: src(ctx, c.line) } };
}

const P = {
  crosses: (ctx, x) => {
    if (compareVersions(ctx.target, x) < 0) return res(false);
    if (!ctx.current) return res(U, [], [versionMissing]);
    return res(compareVersions(ctx.current, x) < 0, [{ field: 'request', value: `${ctx.current.raw} -> ${ctx.target.raw} crosses ${x}` }]);
  },
  target_gte: (ctx, x) => res(compareVersions(ctx.target, x) >= 0),
  target_lt: (ctx, x) => res(compareVersions(ctx.target, x) < 0),
  target_eq: (ctx, x) => res(compareVersions(ctx.target, x) === 0, [{ field: 'request.target', value: ctx.target.raw }]),
  current_lt: (ctx, x) => ctx.current ? res(compareVersions(ctx.current, x) < 0, [{ field: 'request.current', value: ctx.current.raw }]) : res(U, [], [versionMissing]),
  current_lte: (ctx, x) => ctx.current ? res(compareVersions(ctx.current, x) <= 0, [{ field: 'request.current', value: ctx.current.raw }]) : res(U, [], [versionMissing]),
  env_set: (ctx, a) => envPredicate(ctx, a.service, a.keys, () => true, '(set)', a.command),
  env_equals: (ctx, a) => envPredicate(ctx, a.service, [a.key], e => e.value === null ? U : e.value === a.value, a.value),
  env_relative_path: (ctx, a) => envPredicate(ctx, a.service, [a.key], e => e.value === null ? U : e.value !== '' && !e.value.startsWith('/'), 'relative path'),
  command_argv: (ctx, a) => fieldPredicate(ctx, a.service, s => argvMatch(ctx, s, a.argv)),
  // Substring search inside command arguments; only the matched text is reported, never the command itself.
  command_contains: (ctx, a) => fieldPredicate(ctx, a.service, s => {
    const c = s.command;
    if (!c) return s.extendsFrom.length ? { v: U, why: s.extendsFrom.map(w => `command of ${s.name} (may come from ${w})`) } : { v: false };
    if (c.parseError) return { v: U, why: [`command of ${s.name} (unbalanced quotes)`] };
    if (c.tokens.some(t => !unknownTok(t) && t.includes(a.text))) return { v: true, fact: { service: s.name, field: 'command', value: `contains '${a.text}'`, source: src(ctx, c.line) } };
    return c.tokens.some(unknownTok) ? { v: U, why: c.unresolved.map(x => `${x} (command of ${s.name})`) } : { v: false };
  }),
  // Port match and its exemption (unless_env, e.g. IMMICH_PORT=3001) are judged on the SAME service.
  container_port: (ctx, a) => fieldPredicate(ctx, a.service, s => {
    const why = [];
    let hit = null;
    for (const p of s.ports) {
      if (p.container === null) { why.push(...p.unresolved.map(x => `${x} (ports of ${s.name})`)); continue; }
      const [lo, hi = lo] = p.container.split('-').map(Number);
      if (a.equals >= lo && a.equals <= hi) { hit = p; break; }
    }
    if (hit) {
      for (const [key, val] of Object.entries(a.unless_env ?? {})) {
        const l = envLookup(s, key);
        if (l.unknown) return { v: U, why: l.unknown };
        if (l.found && l.found.value === null) return { v: U, why: l.found.unresolved.map(x => `${x} (used by ${s.name}.${key})`) };
        if (l.found && l.found.value === val) return { v: false };
      }
      return { v: true, fact: { service: s.name, field: 'ports', value: `container port ${a.equals}`, source: src(ctx, hit.line) } };
    }
    if (s.extendsFrom.length) why.push(...s.extendsFrom.map(w => `ports of ${s.name} (more may come from ${w})`));
    return why.length ? { v: U, why } : { v: false };
  }),
  db_kind: (ctx, a) => {
    const db = ctx.db.service;
    if (!db) return res(U, [], ctx.db.unknown);
    if (db.overridden.length) return res(U, [], db.overridden.map(o => `database service ${db.name} ${o}`));
    if (db.image.value === null) return res(U, [], [roleUnknownReason(db)]);
    const k = dbKind(db.image);
    if (k.kind === U) return res(U, [], [`contents of the database image of service ${db.name}: ${imageLabel(db.image)} (not a recognised Immich/pgvecto.rs/pgvector repository)`]);
    const v = a.in.includes(k.kind);
    const facts = [
      { service: db.name, field: 'database host', value: hostLabel({ host: ctx.db.host, interpolated: ctx.db.hostInterpolated }), source: ctx.db.hostSource },
      { service: db.name, field: 'image', value: imageLabel(db.image), detail: db.image.interpolated ? 'versions not shown (interpolated tag)' : k.detail, source: src(ctx, db.image.line),
        // digits-only version components, never derived from an interpolated tag
        ...(!db.image.interpolated && k.pg ? { pg_major: k.pg, pgvecto_rs: k.pgvecto_rs } : {}) },
    ];
    // Doubt from unidentified services: a match stays certain (with the doubt attached), a non-match becomes UNKNOWN.
    if (ctx.db.extra.length) return v ? res(true, facts, ctx.db.extra) : res(U, [], ctx.db.extra);
    return res(v, facts);
  },
};

function evaluate(ctx, c) {
  const [k] = Object.keys(c);
  if (k === 'all' || k === 'any') {
    const parts = c[k].map(x => evaluate(ctx, x));
    const decisive = k === 'all' ? false : true;
    if (parts.some(p => p.v === decisive)) return k === 'any' ? res(true, parts.find(p => p.v === true).facts, parts.flatMap(p => p.missing)) : res(false);
    if (parts.some(p => p.v === U)) return res(U, [], parts.flatMap(p => p.missing));
    return res(!decisive, parts.flatMap(p => p.facts), parts.flatMap(p => p.missing));
  }
  if (k === 'not') { const r = evaluate(ctx, c.not); return r.v === U ? r : res(!r.v); }
  return P[k](ctx, c[k]);
}

// ---------- env destination guard ----------
// A rename/duplicate copies a legacy variable's value into a destination variable WHERE the legacy variable is
// defined, so in a shared env file it reaches every service that reads the file. Before such an instruction is
// emitted, each Immich (or unidentified) service it reaches is checked: it may not end up with two different values
// for one destination, and an existing destination with a different value is never silently overwritten. If a value
// cannot be resolved, the collision is UNKNOWN. Values are compared here and never emitted.
const COPY_OPS = new Set(['rename_env', 'duplicate_env']);
const scopeOf = (e, svc) => e.file ?? `environment of ${svc.name}`; // env file key, or the service's own environment:
function guardEnvDestinations(ctx, findings) {
  const writes = [];
  for (const f of findings) {
    if (f.label === 'UNKNOWN' || !COPY_OPS.has(f.remediation.op)) continue;
    const { op, subjects, replacements } = f.remediation;
    for (const c of f.config) {
      const i = subjects.findIndex(k => c.field === `environment.${k}`);
      const svc = i < 0 ? null : ctx.project.services.find(x => x.name === c.service);
      const e = svc && envLookup(svc, subjects[i]).found;
      if (!e) continue;
      for (const dest of op === 'rename_env' ? [replacements[i]] : replacements) writes.push({ f, svc, key: subjects[i], dest, e });
    }
  }
  const hits = new Map();
  const hit = f => hits.get(f) ?? hits.set(f, { conflicts: [], keys: new Set(), missing: [] }).get(f);
  const readers = [...ctx.roles.server, ...ctx.roles.ml, ...ctx.roles.maybe];
  for (const dest of new Set(writes.map(w => w.dest))) {
    for (const t of readers) {
      const reach = writes.filter(w => w.dest === dest && (w.e.file ? t.envFiles.includes(w.e.file) : w.svc === t));
      if (!reach.length) continue;
      const own = reach.filter(w => w.svc === t);
      const ex = envLookup(t, dest);
      // An existing destination that cannot be looked up (missing env file, override, extends) may hold any value:
      // it is never treated as absent, so the write becomes conditional (existing_value_unchecked) below.
      const unchecked = (ex.unknown ?? []).map(u => `existing ${dest} of service ${t.name} not checked for a conflicting value: ${u}`);
      // A destination in t's own environment: outranks every env file, so only t's own writes can collide with it.
      const involved = ex.found?.fromEnvironment ? own : reach;
      // t has no value of its own and uses its default today; a write into a file t reads would change it (defaults
      // differ per service, e.g. IMMICH_PORT 2283 vs 3003, E09), so that write is conditional too (reaches_other_service).
      const shared = !own.length && !ex.found && !ex.unknown;
      const notes = shared
        ? reach.map(w => `${dest} set in ${scopeOf(w.e, w.svc)} would also reach service ${t.name}, which has no ${dest} or legacy variable of its own (verify that it should use the same value)`)
        : unchecked;
      const values = [...involved.map(w => w.e), ...(ex.found ? [ex.found] : [])];
      const writeVals = new Set(involved.filter(w => w.e.value !== null).map(w => w.e.value));
      const reason = writeVals.size > 1 ? 'different_values'
        : ex.found?.value != null && writeVals.size === 1 && !writeVals.has(ex.found.value) ? 'existing_value_differs'
          : ex.unknown ? 'existing_value_unchecked'
            : shared ? 'reaches_other_service'
              : values.length > 1 && values.some(v => v.value === null) ? 'unresolved_value' : null;
      if (!reason) continue;
      const conflict = {
        destination: dest, reason,
        services: [...new Set([t.name, ...involved.map(w => w.svc.name)])].sort(),
        locations: [...new Set([...involved.map(w => scopeOf(w.e, w.svc)), ...(ex.found ? [scopeOf(ex.found, t)] : [])])].sort(),
      };
      const unresolved = reason === 'unresolved_value' ? [...involved.flatMap(w => w.e.unresolved.map(x => `${x} (used by ${w.svc.name}.${w.key})`)), ...(ex.found?.value === null ? ex.found.unresolved.map(x => `${x} (used by ${t.name}.${dest})`) : [])] : [];
      for (const w of involved) { const h = hit(w.f); h.conflicts.push(conflict); h.keys.add(w.key); h.missing.push(...unresolved, ...notes); }
    }
  }
  for (const [f, h] of hits) {
    f.missing_inputs = [...new Set([...f.missing_inputs, ...h.missing])].sort();
    if (!h.conflicts.length) continue;
    const conflicts = [...new Map(h.conflicts.map(c => [JSON.stringify(c), c])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    // Only a collision between known values is certain; unresolved or unchecked values make the finding UNKNOWN.
    const known = conflicts.some(c => c.reason === 'different_values' || c.reason === 'existing_value_differs');
    f.remediation = validateRemediation(f.rule_id, { op: 'resolve_env_conflict', subjects: f.remediation.subjects.filter(k => h.keys.has(k)), replacements: [...new Set(conflicts.map(c => c.destination))].sort() });
    f.action = renderAction(f.rule_id, f.remediation, { reason: known ? 'known' : 'unverified' });
    if (!known) f.label = 'UNKNOWN';
    f.conflicts = conflicts;
  }
}

// ---------- result semantics ----------
// Overall status, by precedence. There is deliberately no "OK"/"SAFE" value: the tool only knows its supported rules.
const ASSESSMENT = {
  ACTION_REQUIRED: 'At least one supported rule requires a change or an intermediate upgrade before this upgrade.',
  UNKNOWN: 'At least one supported check could not be decided from the given inputs. This is not a pass.',
  ADVISORY: 'The supported rules found only recommended (not yet mandatory) changes. This is not a statement that the upgrade is safe.',
  NO_KNOWN_RISK_IN_COVERED_RULES: 'No supported rule matched. This is not a statement that the upgrade is safe: only the risk families listed under coverage were checked.',
};
function assess(families, path) {
  const labels = Object.values(families).map(f => f.label);
  const status = labels.includes('ACTION_REQUIRED') || path.status === 'INTERMEDIATE_REQUIRED' ? 'ACTION_REQUIRED'
    : labels.includes('UNKNOWN') || path.status === 'UNKNOWN' ? 'UNKNOWN'
      : labels.includes('ADVISORY') || path.status === 'ADVISORY' ? 'ADVISORY' : 'NO_KNOWN_RISK_IN_COVERED_RULES';
  return { status, meaning: ASSESSMENT[status] };
}
export const COVERAGE = {
  families: Object.keys(FAMILIES),
  not_applicable_means: 'NOT_APPLICABLE: with complete inputs, no supported rule of that family matched. It is not a safety verdict.',
  not_covered: 'Changes outside these six families (API, mobile app, hardware/CPU requirements, admin settings, data migrations) are not checked.',
};

// ---------- analysis ----------
export function analyze({ dir, current, target }, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const releases = loadKnownVersions(o.versionsFile);
  const tags = loadKnownVersions(o.tagsFile);
  const known = new Set([...releases, ...tags]);
  const versionNotes = [];
  // Malformed strings are INPUT_ERROR; well-formed versions outside the policy are UNSUPPORTED_VERSION (no risk report).
  // The user-supplied string is never repeated (a prerelease part can carry any text); the option name identifies it.
  const check = (raw, role) => {
    const v = parseVersion(raw), field = `--${role}`;
    if (!v) throw new InputError(`invalid ${role} version (expected vMAJOR.MINOR.PATCH with an optional SemVer prerelease such as -rc.1)`, field);
    if (compareVersions(v, VERSION_POLICY.newest_researched) > 0) throw new UnsupportedVersionError(`${role} version is newer than ${VERSION_POLICY.newest_researched}, the newest version whose release notes were reviewed; no rules cover it`, field);
    if (!known.has(v.raw)) throw new UnsupportedVersionError(`${role} version is not a known Immich release or official git tag in the version registry`, field);
    if (compareVersions(v, VERSION_POLICY.oldest_supported) < 0) throw new UnsupportedVersionError(`${role} version is older than ${VERSION_POLICY.oldest_supported}, where the reviewed release-note range starts`, field);
    if (!releases.has(v.raw)) versionNotes.push(`${v.raw} is an official git tag without a GitHub release entry; no release notes exist for it specifically`);
    return v;
  };
  const tv = check(target, 'target');
  let cv = null;
  if (current !== undefined && current !== null && current !== '') {
    cv = check(current, 'current');
    if (compareVersions(cv, tv) >= 0) throw new InputError(`current ${cv.raw} is not lower than target ${tv.raw}; downgrades are not supported by Immich`);
  }
  const { rules, constraints, evidence, dbImages } = loadRules(o.rulesFile, o.evidenceFile, known);
  const project = loadProject(dir);
  const r = roles(project);
  const ctx = { project, current: cv, target: tv, roles: r, db: resolveDatabase(project, r) };
  // Only validated source references are emitted; rule-file prose (summary, evidence titles) never reaches a report.
  const cite = ids => ids.map(id => ({ id, url: evidence[id].url, revision: evidence[id].revision }));
  const uniq = a => [...new Set(a)].sort();
  const findings = [];

  // Path constraints -> one shared upgrade path; each constraint keeps its own finding.
  const stops = new Map();
  for (const c of constraints) {
    if (compareVersions(tv, c.applies_if_target_gte) < 0) continue;
    if (!cv) {
      findings.push({ rule_id: c.id, family: c.family, label: 'UNKNOWN', action_key: `path.stop:${c.stop}`, remediation: c.remediation,
        action: `Provide the running version; if it is below ${c.requires_current_gte}: ${c.action}`, evidence: cite(c.evidence), config: [], missing_inputs: [versionMissing] });
    } else if (compareVersions(cv, c.requires_current_gte) < 0) {
      if (!stops.has(c.stop)) stops.set(c.stop, []);
      stops.get(c.stop).push(c.id);
      findings.push({ rule_id: c.id, family: c.family, label: 'ACTION_REQUIRED', action_key: `path.stop:${c.stop}`, remediation: c.remediation,
        action: c.action, evidence: cite(c.evidence), config: [{ field: 'request.current', value: cv.raw }], missing_inputs: [] });
    }
  }

  for (const rule of rules) {
    const e = evaluate(ctx, rule.when);
    if (e.v === false) continue;
    const label = e.v === U ? 'UNKNOWN' : KIND_LABEL[rule.kind];
    // DB image actions are rendered per finding: exact documented image, matching components, or verification only.
    let action = rule.action;
    const img = e.facts.find(x => x.field === 'image' && x.pg_major);
    if (rule.remediation.op === 'replace_db_image' && img) {
      const doc = dbImages.find(d => d.pg === img.pg_major && d.pgvecto_rs === img.pgvecto_rs);
      action = renderAction(rule.id, rule.remediation, { pg: img.pg_major, pgvecto_rs: img.pgvecto_rs, image: doc?.image });
    }
    const f = {
      rule_id: rule.id, family: rule.family, label, action_key: rule.action_key, remediation: rule.remediation,
      action: e.v === U ? `Cannot decide without the missing inputs. If it applies: ${action}` : action,
      evidence: cite(rule.evidence), config: e.facts, missing_inputs: uniq(e.missing),
    };
    if (rule.recommended_stop && label === 'ADVISORY') f.recommended_stop = rule.recommended_stop;
    findings.push(f);
  }

  guardEnvDestinations(ctx, findings);

  // Two rules that fired with the same action_key must agree on the label; otherwise the rule set is contradictory.
  const byKey = new Map();
  for (const f of findings) {
    if (f.label === 'UNKNOWN') continue;
    const prev = byKey.get(f.action_key);
    if (prev && prev.label !== f.label) throw new ConflictError(`rules ${prev.rule_id} and ${f.rule_id} both fired for ${f.action_key} with ${prev.label} vs ${f.label}`);
    byKey.set(f.action_key, f);
  }

  // The path is only OK when no path-related finding is uncertain or advisory.
  const pathFindings = findings.filter(f => f.action_key.startsWith('path.'));
  // A mandatory stop outranks everything: the direct upgrade is never described as fine when a stop is required.
  // NO_KNOWN_STOP only means no supported rule requires one; it is not a statement that the direct path is safe.
  const upgradePath = {
    status: stops.size ? 'INTERMEDIATE_REQUIRED' : pathFindings.some(f => f.label === 'UNKNOWN') ? 'UNKNOWN' : pathFindings.some(f => f.label === 'ADVISORY') ? 'ADVISORY' : 'NO_KNOWN_STOP',
    stops: [...stops.keys()].sort(compareVersions).map(v => ({ version: v, required_by: stops.get(v).sort() })),
    advisory_stops: pathFindings.filter(f => f.recommended_stop).map(f => ({ version: f.recommended_stop, recommended_by: f.rule_id })),
    open_risks: pathFindings.filter(f => f.label === 'UNKNOWN').map(f => f.rule_id).sort(),
  };

  findings.sort((a, b) => a.family.localeCompare(b.family) || PRECEDENCE.indexOf(a.label) - PRECEDENCE.indexOf(b.label) || a.rule_id.localeCompare(b.rule_id));
  const families = {};
  for (const [id, name] of Object.entries(FAMILIES)) {
    const fs_ = findings.filter(f => f.family === id);
    const label = PRECEDENCE.find(l => fs_.some(f => f.label === l)) ?? 'NOT_APPLICABLE';
    families[id] = { name, label, findings: fs_ };
  }
  const summary = Object.fromEntries(PRECEDENCE.map(l => [l, Object.keys(families).filter(k => families[k].label === l)]));
  const notes = [...project.notes, ...new Set(versionNotes)];
  if (!r.ml.length && !r.maybe.length && !project.hidden.length) notes.push('no immich-machine-learning service in this compose; ML variables were not checked');
  if (ctx.db.service) notes.push(`database service: ${ctx.db.service.name} (host ${hostLabel({ host: ctx.db.host, interpolated: ctx.db.hostInterpolated })} from ${ctx.db.hostSource})`);
  else notes.push(`database service not determined: ${ctx.db.unknown.join('; ')}`);
  return {
    tool: 'compose-upgrade-risk-inspector', schema: 3,
    request: { current: cv?.raw ?? null, target: tv.raw },
    inputs: { compose: project.composeName, files_read: project.filesRead, missing: project.missing, unsupported: project.unsupported, notes },
    assessment: assess(families, upgradePath), coverage: COVERAGE,
    upgrade_path: upgradePath, families, summary,
  };
}
