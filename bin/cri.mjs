#!/usr/bin/env node
// cri: Compose Upgrade Risk Inspector (Immich). Offline and read-only.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { analyze, InputError, ConflictError, DEFAULTS } from '../src/engine.mjs';
import { loadRules, RuleError } from '../src/rules.mjs';
import { loadKnownVersions } from '../src/version.mjs';
import { renderText } from '../src/report.mjs';

const USAGE = `Usage:
  cri analyze <compose-dir> --target <vX.Y.Z> [--current <vX.Y.Z>] [--json] [--rules <file>]
  cri lint [--rules <file>]

  <compose-dir>  directory with compose.yaml / docker-compose.yml and its env files
  --current      the version that is running now (omit if unknown: affected checks become UNKNOWN)
  --target       the version you want to upgrade to
Exit codes: 0 analysis done (read the Result line), 2 INPUT_ERROR / SCHEMA_ERROR / RULE_ERROR / RULE_CONFLICT,
            3 UNSUPPORTED_VERSION (no risk was evaluated), 1 INTERNAL_ERROR.
            With --json, errors are printed to stdout as {"tool", "schema": 3, "error": {"category", "message", "field"?}}.`;

// --json is honoured for every error the CLI can recognise, including option-parsing errors (raw argv check).
const wantsJson = process.argv.slice(2).includes('--json');
// A controlled failure is never turned into a risk result: no families, no assessment. Messages never echo input values.
function fail(error, code, usage = false) {
  if (wantsJson) process.stdout.write(JSON.stringify({ tool: 'compose-upgrade-risk-inspector', schema: 3, error }, null, 2) + '\n');
  else console.error(`error [${error.category}]: ${error.message}${usage ? `\n\n${USAGE}` : ''}`);
  process.exit(code);
}

let args;
try {
  args = parseArgs({ allowPositionals: true, options: {
    target: { type: 'string' }, current: { type: 'string' }, json: { type: 'boolean' }, rules: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
} catch (e) {
  // Node's message quotes the offending option, so only the kind of problem is reported.
  fail({ category: 'INPUT_ERROR', message: e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 'unknown option' : 'invalid command-line options (an option is missing its value or has the wrong type)' }, 2, true);
}
const { values: v, positionals: [cmd, dir] } = args;
const opts = v.rules ? { rulesFile: v.rules } : {};

try {
  if (v.help) { console.log(USAGE); process.exit(cmd ? 0 : 2); }
  if (!cmd) throw new InputError('no command given (expected analyze or lint)');
  // An explicit --rules path is user input: a missing or unreadable file is user-correctable (INPUT_ERROR), not internal.
  if (v.rules) {
    try { if (!fs.statSync(v.rules).isFile()) throw new Error(); fs.accessSync(v.rules, fs.constants.R_OK); }
    catch { throw new InputError('rules file not found, not a regular file, or not readable (the path is not repeated here)', '--rules'); }
  }
  if (cmd === 'lint') {
    const { rules, constraints } = loadRules(opts.rulesFile ?? DEFAULTS.rulesFile, DEFAULTS.evidenceFile, loadKnownVersions(DEFAULTS.versionsFile));
    console.log(`rules OK: ${rules.length} rules, ${constraints.length} path constraints`);
  } else if (cmd === 'analyze') {
    if (!dir || !v.target) throw new InputError('analyze needs <compose-dir> and --target');
    const report = analyze({ dir, current: v.current, target: v.target }, opts);
    process.stdout.write(v.json ? JSON.stringify(report, null, 2) + '\n' : renderText(report));
  } else throw new InputError('unknown command (expected analyze or lint)');
} catch (e) {
  if (e instanceof InputError || e instanceof RuleError || e instanceof ConflictError) {
    fail({ category: e.category, message: e.message, ...(e.field ? { field: e.field } : {}) }, e.category === 'UNSUPPORTED_VERSION' ? 3 : 2, e.message.startsWith('no command'));
  }
  // Anything else is a defect or an unexpected I/O failure: no stack trace and no partial result.
  fail({ category: 'INTERNAL_ERROR', message: 'unexpected internal error; no analysis result was produced' }, 1);
}
