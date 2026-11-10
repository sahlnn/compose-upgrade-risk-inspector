// Loads a Compose project directory into a model the rule engine can query.
// Read-only and offline: reads only files whose real path is inside the given directory, never process.env, never Docker.
// Uncertainty is tracked per field: anything that cannot be resolved is recorded, never guessed.
import fs from 'node:fs';
import path from 'node:path';
import YAML, { LineCounter } from 'yaml';

// Every input error carries a category; the CLI turns it into a controlled exit code and an error object.
// `field` names the input (an option or a Compose field path), never its value.
export class InputError extends Error {
  constructor(message, field) { super(message); if (field) this.field = field; }
  get category() { return 'INPUT_ERROR'; }
}
export class SchemaError extends InputError {
  constructor(field, problem) { super(`${field}: ${problem}`, field); }
  get category() { return 'SCHEMA_ERROR'; }
}

// Narrow structural check of the Compose fields this tool reads (not the full Compose Specification).
// Messages name the field and the required and actual TYPE only, never a value.
const kind = v => (v === null ? 'null' : Array.isArray(v) ? 'sequence' : typeof v === 'object' ? 'mapping' : typeof v);
const scalar = v => ['string', 'number', 'boolean'].includes(typeof v);
function validateComposeShape(raw) {
  const fail = (field, expected, v) => { throw new SchemaError(field, `expected ${expected}, got a ${kind(v)}`); };
  const seqOf = (field, v, okItem, itemExpected) => {
    if (!Array.isArray(v)) fail(field, 'a sequence', v);
    v.forEach((x, i) => { if (!okItem(x)) fail(`${field}[${i}]`, itemExpected, x); });
  };
  const str = x => typeof x === 'string';
  const map = x => kind(x) === 'mapping';
  if (raw.include !== undefined) seqOf('include', raw.include, x => str(x) || map(x), 'a string or mapping');
  for (const [name, s] of Object.entries(raw.services)) {
    const f = k => `services.${name}.${k}`;
    if (!map(s)) fail(`services.${name}`, 'a mapping', s);
    for (const k of ['image', 'container_name', 'hostname', 'network_mode']) if (s[k] !== undefined && !str(s[k])) fail(f(k), 'a string', s[k]);
    // Long forms: the nested fields that are read (or that name what is read) must have their documented types.
    const fields = (field, x, spec) => { for (const [k, [ok, expected, required]] of Object.entries(spec)) if (x[k] === undefined ? required : !ok(x[k])) fail(`${field}.${k}`, expected, x[k]); };
    const portNum = v => str(v) || Number.isInteger(v);
    if (s.ports !== undefined) seqOf(f('ports'), s.ports, x => str(x) || typeof x === 'number' || map(x), 'a string, number or mapping');
    (Array.isArray(s.ports) ? s.ports : []).forEach((x, i) => map(x) && fields(`${f('ports')}[${i}]`, x, {
      target: [portNum, 'an integer or string', true], published: [portNum, 'an integer or string'],
      protocol: [str, 'a string'], mode: [str, 'a string'], host_ip: [str, 'a string'], name: [str, 'a string'], app_protocol: [str, 'a string'],
    }));
    if (s.volumes !== undefined) seqOf(f('volumes'), s.volumes, x => str(x) || map(x), 'a string or mapping');
    (Array.isArray(s.volumes) ? s.volumes : []).forEach((x, i) => map(x) && fields(`${f('volumes')}[${i}]`, x, {
      target: [str, 'a string', true], source: [str, 'a string'], type: [str, 'a string'],
    }));
    if (s.environment !== undefined) {
      if (Array.isArray(s.environment)) seqOf(f('environment'), s.environment, str, 'a string');
      else if (!map(s.environment)) fail(f('environment'), 'a mapping or sequence', s.environment);
      else for (const [k, v] of Object.entries(s.environment)) if (v !== null && !scalar(v)) fail(`${f('environment')}.${k}`, 'a scalar or null', v);
    }
    if (s.env_file !== undefined && !str(s.env_file)) {
      seqOf(f('env_file'), s.env_file, x => str(x) || (map(x) && str(x.path)), 'a string or a mapping with a path');
      s.env_file.forEach((x, i) => map(x) && fields(`${f('env_file')}[${i}]`, x, { required: [v => typeof v === 'boolean', 'a boolean'], format: [str, 'a string'] }));
    }
    for (const k of ['command', 'entrypoint']) if (s[k] !== undefined && s[k] !== null && !str(s[k])) seqOf(f(k), s[k], scalar, 'a scalar');
    if (s.extends !== undefined && !str(s.extends) && !(map(s.extends) && str(s.extends.service) && (s.extends.file === undefined || str(s.extends.file)))) fail(f('extends'), 'a string or a mapping with a service', s.extends);
    for (const k of ['profiles', 'links', 'external_links']) if (s[k] !== undefined) seqOf(f(k), s[k], str, 'a string');
    if (s.extra_hosts !== undefined && !map(s.extra_hosts)) seqOf(f('extra_hosts'), s.extra_hosts, str, 'a string');
    if (s.networks !== undefined) {
      if (Array.isArray(s.networks)) seqOf(f('networks'), s.networks, str, 'a string');
      else if (!map(s.networks)) fail(f('networks'), 'a mapping or sequence', s.networks);
      else for (const [n, cfg] of Object.entries(s.networks)) {
        if (cfg !== null && !map(cfg)) fail(`${f('networks')}.${n}`, 'a mapping or null', cfg);
        if (cfg?.aliases !== undefined) seqOf(`${f('networks')}.${n}.aliases`, cfg.aliases, str, 'a string');
      }
    }
  }
}

const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const OVERRIDE_NAMES = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];
export const UNKNOWN_MARK = '\u0000'; // marks an unresolved fragment inside a partial string

// ---------- .env style files ----------
// Supported: KEY=VALUE, export KEY=VALUE, '…' (literal), "…" (escapes), unquoted with ` #` comments,
// a comment after a closing quote. raw=true: value taken verbatim (Compose `format: raw`).
export function parseEnvFile(text, { raw = false } = {}) {
  const vars = {}, invalid = [];
  text.split(/\r?\n/).forEach((line0, i) => {
    const line = line0.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) { invalid.push(i + 1); return; }
    let v = m[2], mode = 'plain';
    if (raw) mode = 'raw';
    else if (v[0] === "'" || v[0] === '"') {
      const q = v[0];
      let j = 1, out = '';
      for (; j < v.length && v[j] !== q; j++) {
        if (q === '"' && v[j] === '\\' && j + 1 < v.length) { const n = v[++j]; out += n === 'n' ? '\n' : n; } else out += v[j];
      }
      const rest = v.slice(j + 1);
      if (j >= v.length || (rest && !/^\s+#/.test(rest))) { invalid.push(i + 1); return; }
      v = out; mode = q === "'" ? 'single' : 'double';
    } else v = v.replace(/\s+#.*$/, '');
    vars[m[1]] = { value: v, line: i + 1, mode };
  });
  return { vars, invalid };
}

// ---------- interpolation ----------
// Supported: $$, $VAR, ${VAR}, ${VAR:-d}, ${VAR-d}, ${VAR:?e}, ${VAR?e}, ${VAR:+r}, ${VAR+r}.
// vars[name] === null means "defined but unresolved". Nested ${…} in a default is reported, not guessed.
// True when a string references a variable (not just a $$ escape): its resolved value may come from a secret.
export const hasRef = s => typeof s === 'string' && /\$[{A-Za-z_]/.test(s.replace(/\$\$/g, ''));

export function interpolate(str, vars) {
  const unresolved = [], unsupported = [];
  if (typeof str !== 'string') return { value: str, partial: str, unresolved, unsupported };
  let out = '';
  const unknown = name => { unresolved.push(name); out += UNKNOWN_MARK; };
  for (let i = 0; i < str.length;) {
    if (str[i] !== '$') { out += str[i++]; continue; }
    if (str[i + 1] === '$') { out += '$'; i += 2; continue; }
    if (str[i + 1] === '{') {
      const end = str.indexOf('}', i);
      if (end < 0) { unsupported.push('unclosed'); out += UNKNOWN_MARK; break; }
      const body = str.slice(i + 2, end);
      if (body.includes('$')) { unsupported.push('nested'); out += UNKNOWN_MARK; i = str.indexOf('}', end + 1) + 1 || str.length; continue; }
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])(.*))?$/s.exec(body);
      if (!m) { unsupported.push('malformed'); out += UNKNOWN_MARK; i = end + 1; continue; }
      const [, name, op, arg = ''] = m;
      i = end + 1;
      const has = Object.hasOwn(vars, name), val = has ? vars[name] : undefined;
      if (has && val === null) { unknown(name); continue; }
      const empty = !has || val === '';
      if (!op) { if (has) out += val; else unknown(name); }
      else if (op === ':-') out += empty ? arg : val;
      else if (op === '-') out += has ? val : arg;
      else if (op === ':?' || op === '?') { if ((op === ':?' && empty) || (op === '?' && !has)) unknown(name); else out += val; }
      else if (op === ':+') out += empty ? '' : arg;
      else if (op === '+') out += has ? arg : '';
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(str.slice(i + 1));
    if (!m) { out += '$'; i++; continue; }
    if (Object.hasOwn(vars, m[0]) && vars[m[0]] !== null) out += vars[m[0]]; else unknown(m[0]);
    i += 1 + m[0].length;
  }
  return { value: unresolved.length || unsupported.length ? null : out, partial: out, unresolved, unsupported };
}

// Shell-style word splitting used by Compose for string commands. Returns null on unbalanced quotes.
export function splitWords(s) {
  const words = [];
  let cur = '', inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const j = s.indexOf(c, i + 1);
      if (j < 0) return null;
      cur += s.slice(i + 1, j); inWord = true; i = j;
    } else if (/\s/.test(c)) { if (inWord) { words.push(cur); cur = ''; inWord = false; } }
    else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; inWord = true; }
    else { cur += c; inWord = true; }
  }
  if (inWord) words.push(cur);
  return words;
}

// ---------- containment ----------
const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);
function makeResolver(dir) {
  const root = fs.realpathSync.native(dir);
  // Returns { abs } for a readable file whose real path (links and junctions resolved) is inside the input dir.
  return rel => {
    const abs = path.resolve(dir, rel);
    if (!norm(abs).startsWith(norm(path.resolve(dir)) + path.sep)) return { error: 'outside the input directory (not read)' };
    if (!fs.existsSync(abs)) return { error: 'missing' };
    const real = fs.realpathSync.native(abs);
    if (!norm(real).startsWith(norm(root) + path.sep)) return { error: 'outside the input directory via a link or junction (not read)' };
    if (!fs.statSync(real).isFile()) return { error: 'not a regular file' };
    return { abs: real };
  };
}

// One key per env file, however the compose file spells its path: services sharing a file share its values.
const fileKey = rel => path.posix.normalize(rel.split('\\').join('/'));

// ---------- compose project ----------
export function loadProject(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new InputError('input directory not found or not a directory (the path is not repeated here)', '<compose-dir>');
  const resolve = makeResolver(dir);
  const present = COMPOSE_NAMES.filter(n => fs.existsSync(path.join(dir, n)));
  if (!present.length) throw new InputError(`no compose file (${COMPOSE_NAMES.join(', ')}) in the input directory`, '<compose-dir>');
  const composeName = present[0];
  const notes = present.length > 1 ? [`several compose files found; using ${composeName} like docker compose does`] : [];
  const unsupported = [], missing = [], filesRead = [];
  const readOrFail = name => {
    const r = resolve(name);
    if (r.error) throw new InputError(`${name}: ${r.error}`);
    filesRead.push(name);
    return fs.readFileSync(r.abs, 'utf8');
  };

  const text = readOrFail(composeName);
  const lineCounter = new LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter, uniqueKeys: true, merge: true, prettyErrors: true });
  // Parser messages can quote the offending text, so only the error code and position are reported.
  if (doc.errors.length) {
    const e = doc.errors[0], at = e.linePos?.[0];
    throw new InputError(`${composeName}: invalid YAML (${e.code})${at ? ` at line ${at.line}, column ${at.col}` : ''}`);
  }
  let raw;
  // Alias resolution happens here and throws plain errors (unresolved alias, alias-count limit) that quote names.
  try { raw = doc.toJS({ maxAliasCount: 100 }); } catch { throw new InputError(`${composeName}: invalid YAML (an alias is undefined or exceeds the alias limit)`); }
  if (!raw || typeof raw !== 'object' || !raw.services || typeof raw.services !== 'object' || Array.isArray(raw.services))
    throw new InputError(`${composeName}: no 'services' mapping`);
  validateComposeShape(raw);
  const lineOf = p => { const n = doc.getIn(p, true); return n?.range ? lineCounter.linePos(n.range[0]).line : null; };

  // Project .env: interpolation only (not container env), evaluated top to bottom like Compose.
  const projectEnv = {};
  if (fs.existsSync(path.join(dir, '.env'))) {
    const { vars, invalid } = parseEnvFile(readOrFail('.env'));
    for (const [k, v] of Object.entries(vars)) projectEnv[k] = v.mode === 'single' ? v.value : interpolate(v.value, projectEnv).value;
    if (invalid.length) unsupported.push(`.env: unparsable lines ${invalid.join(', ')}`);
  }

  // Files Compose would merge but this tool does not: any service may be overridden, and more services may exist.
  const overridden = [], hidden = [];
  for (const o of OVERRIDE_NAMES) if (fs.existsSync(path.join(dir, o))) { unsupported.push(`${o} (override files are not merged)`); overridden.push(o); hidden.push(o); }
  if (raw.include) { unsupported.push('top-level include: (not supported)'); hidden.push('include:'); }

  const envFileCache = new Map();
  const readEnvFile = (rel, format) => {
    const key = `${format}|${rel}`;
    if (envFileCache.has(key)) return envFileCache.get(key);
    const r = resolve(rel);
    const out = r.error ? r : { ...parseEnvFile(fs.readFileSync(r.abs, 'utf8'), { raw: format === 'raw' }) };
    if (!r.error) filesRead.push(rel);
    envFileCache.set(key, out);
    return out;
  };
  const interp = s => interpolate(s, projectEnv);
  // Reasons name variables and the kind of unsupported syntax, never the expression text (it can hold secret defaults).
  const reasonsOf = iv => [...new Set([...iv.unresolved.map(n => `variable ${n}`), ...iv.unsupported.map(k => `unsupported interpolation syntax (${k})`)])];

  const services = [];
  for (const name of Object.keys(raw.services).sort()) {
    const s = raw.services[name] ?? {};
    const base = ['services', name];
    // overridden: an unmerged override may change ANY field; extendsFrom: fields absent locally may come from a base.
    const svc = { name, env: {}, envFiles: [], envIncomplete: [], overridden: overridden.map(o => `may be overridden by ${o}`), extendsFrom: [], ports: [], command: null, image: null, names: [] };
    // Profile-gated services may not run at all; activation (COMPOSE_PROFILES / --profile) is not modeled.
    if (Array.isArray(s.profiles) && s.profiles.length) { svc.overridden.push(`is profile-gated (${s.profiles.length} profile(s)); activation not modeled`); unsupported.push(`profiles on service ${name} (activation not modeled)`); }

    if (s.extends) {
      const f = typeof s.extends === 'string' ? null : s.extends.file;
      if (f) { const r = resolve(f); if (r.error) missing.push(`${f} (extends of service ${name}: ${r.error})`); else unsupported.push(`extends in service ${name} (not merged)`); }
      else unsupported.push(`extends in service ${name} (not merged)`);
      svc.extendsFrom.push(f ? `extends file ${f}` : `extends of service ${name}`);
    }

    if (s.image === undefined) {
      svc.image = { value: null, absent: true, unresolved: [], line: null };
      if (!svc.extendsFrom.length) unsupported.push(`service ${name} has no image (build-only); its role is unknown`);
    } else {
      const ip = interp(String(s.image));
      svc.image = { value: ip.value, absent: false, interpolated: hasRef(String(s.image)), unresolved: reasonsOf(ip), line: lineOf([...base, 'image']) };
    }

    // DNS names this service answers to on the project network.
    const aliasList = s.networks && !Array.isArray(s.networks) ? Object.values(s.networks).flatMap(n => n?.aliases ?? []) : [];
    for (const n of [name, s.container_name, s.hostname, ...aliasList].filter(x => x !== undefined && x !== null)) {
      const iv = interp(String(n));
      svc.names.push(iv.value === null ? { unresolved: reasonsOf(iv) } : { value: iv.value });
    }

    // env_file entries, in order; later files override earlier ones; `environment:` overrides them all.
    const envFiles = s.env_file === undefined ? [] : [].concat(s.env_file);
    for (const e of envFiles) {
      const rel = typeof e === 'object' && e ? e.path : e;
      const required = typeof e === 'object' && e ? e.required !== false : true;
      const format = typeof e === 'object' && e ? e.format : undefined;
      if (typeof rel !== 'string') { unsupported.push(`env_file entry of service ${name} is not a path`); svc.envIncomplete.push(`env_file entry of ${name}`); continue; }
      if (format !== undefined && format !== 'raw') { unsupported.push(`${rel}: env_file format is not supported (only raw)`); svc.envIncomplete.push(`env_file ${rel} (unsupported format)`); continue; }
      const r = readEnvFile(rel, format);
      if (r.error) {
        if (r.error === 'missing' && !required) continue;
        missing.push(`${rel} (env_file of service ${name}: ${r.error})`);
        svc.envIncomplete.push(`env_file ${rel}`);
        continue;
      }
      svc.envFiles.push(fileKey(rel));
      if (r.invalid.length) { svc.envIncomplete.push(`unparsable lines in ${rel}`); unsupported.push(`${rel}: unparsable lines ${r.invalid.join(', ')}`); }
      for (const [k, v] of Object.entries(r.vars)) {
        // shortcut: env_file values are interpolated with the project .env only (not earlier lines of the same file);
        // a reference to such a line stays unresolved (UNKNOWN), which errs on the safe side.
        const iv = v.mode === 'single' || v.mode === 'raw' ? { value: v.value, unresolved: [], unsupported: [] } : interp(v.value);
        svc.env[k] = { value: iv.value, interpolated: v.mode !== "single" && v.mode !== "raw" && hasRef(v.value), unresolved: reasonsOf(iv), source: `${rel}:${v.line}`, file: fileKey(rel), fromEnvironment: false };
      }
    }
    const setEnv = (k, v, line) => {
      if (v === null || v === undefined) { svc.env[k] = { value: null, interpolated: true, unresolved: [`variable ${k} (shell pass-through, not read)`], source: `${composeName}:${line}`, fromEnvironment: true }; return; }
      const iv = interp(String(v));
      svc.env[k] = { value: iv.value, interpolated: hasRef(String(v)), unresolved: reasonsOf(iv), source: `${composeName}:${line}`, fromEnvironment: true };
    };
    if (Array.isArray(s.environment)) s.environment.forEach((item, i) => {
      const str = String(item), eq = str.indexOf('=');
      setEnv(eq < 0 ? str : str.slice(0, eq), eq < 0 ? null : str.slice(eq + 1), lineOf([...base, 'environment', i]));
    });
    else if (s.environment && typeof s.environment === 'object') for (const k of Object.keys(s.environment)) setEnv(k, s.environment[k], lineOf([...base, 'environment', k]));

    svc.portsDeclared = s.ports !== undefined;
    (Array.isArray(s.ports) ? s.ports : []).forEach((p, i) => {
      const line = lineOf([...base, 'ports', i]);
      if (p && typeof p === 'object') {
        const iv = interp(String(p.target ?? ''));
        svc.ports.push({ container: iv.value, unresolved: reasonsOf(iv), line, raw: JSON.stringify(p) });
      } else {
        const iv = interp(String(p));
        const spec = iv.value === null ? null : iv.value.split('/')[0];
        svc.ports.push({ container: spec === null ? null : spec.slice(spec.lastIndexOf(':') + 1), unresolved: reasonsOf(iv), line, raw: String(p) });
      }
    });

    if (s.command !== undefined && s.command !== null) {
      // Tokens keep the unknown marker so an unresolved fragment can never form a match.
      let tokens = null, unres = [];
      if (Array.isArray(s.command)) tokens = s.command.map(x => { const iv = interp(String(x)); unres.push(...reasonsOf(iv)); return iv.partial; });
      else { const iv = interp(String(s.command)); unres = reasonsOf(iv); tokens = splitWords(iv.partial); }
      svc.command = { tokens, unresolved: unres, line: lineOf([...base, 'command']), parseError: tokens === null };
    }
    if (s.entrypoint !== undefined) svc.entrypointSet = true;
    // Network indirection that can redirect the database host away from a plain service-name lookup.
    svc.netIndirection = ["links", "external_links", "network_mode", "extra_hosts"].filter(k => s[k] !== undefined);
    services.push(svc);
  }
  return { dir, composeName, services, hidden, missing: [...new Set(missing)].sort(), unsupported: [...new Set(unsupported)].sort(), notes, filesRead: [...new Set(filesRead)] };
}
