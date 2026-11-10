// Semver for Immich tags: vMAJOR.MINOR.PATCH with optional -prerelease (e.g. v3.4.0-rc.3).
import fs from 'node:fs';

// Prerelease: SemVer 2.0 grammar, dot-separated non-empty identifiers; numeric identifiers have no leading zeros.
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const RE = new RegExp(`^v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?$`);

export function parseVersion(s) {
  const m = RE.exec(String(s ?? '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [], raw: `v${m[1]}.${m[2]}.${m[3]}${m[4] ? '-' + m[4] : ''}` };
}

// SemVer 2.0 precedence: a prerelease sorts before its release; numeric identifiers compare numerically.
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (!x || !y) throw new Error(`cannot compare versions ${a} and ${b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p - +q; continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export function loadKnownVersions(file) {
  return new Set(fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => parseVersion(l)).map(l => parseVersion(l).raw));
}
