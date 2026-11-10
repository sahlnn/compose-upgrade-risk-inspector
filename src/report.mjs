// Human-readable terminal report. Shows every family; UNKNOWN is never folded into a pass.
const ICON = { ACTION_REQUIRED: '!!', UNKNOWN: '??', ADVISORY: '->', NOT_APPLICABLE: '  ' };

export function renderText(r) {
  const out = [];
  const line = s => out.push(s);
  line('Compose Upgrade Risk Inspector  (offline, read-only; no files are changed)');
  line(`Upgrade : ${r.request.current ?? 'UNKNOWN (no --current given)'} -> ${r.request.target}`);
  line(`Result  : ${r.assessment.status}`);
  line(`          ${r.assessment.meaning}`);
  line(`Read    : ${r.inputs.files_read.join(', ')}`);
  if (r.inputs.missing.length) line(`Missing : ${r.inputs.missing.join('; ')}`);
  if (r.inputs.unsupported.length) line(`Not supported (treated as unknown): ${r.inputs.unsupported.join('; ')}`);
  for (const n of r.inputs.notes) line(`Note    : ${n}`);
  const p = r.upgrade_path;
  const route = [r.request.current ?? '(unknown)', ...p.stops.map(s => `${s.version} [${s.required_by.join(', ')}]`), r.request.target].join(' -> ');
  line(`Path    : ${p.status}: ${route}`);
  if (p.open_risks.length) line(`          open path risks (UNKNOWN): ${p.open_risks.join(', ')}`);
  for (const a of p.advisory_stops) line(`          recommended (advisory) stop: ${a.version} [${a.recommended_by}]`);
  line('');
  for (const [id, fam] of Object.entries(r.families)) {
    line(`${id} ${fam.name.padEnd(28, '.')} ${fam.label}`);
    for (const f of fam.findings) {
      line(`   ${ICON[f.label]} [${f.label}] ${f.rule_id}`);
      line(`      action : ${f.action}`);
      for (const c of f.conflicts ?? []) line(`      conflict: ${c.destination} ${c.reason} (services ${c.services.join(', ')}; in ${c.locations.join(', ')})`);
      for (const c of f.config) line(`      config : ${[c.service, c.field].filter(Boolean).join('.')} = ${c.value}${c.detail ? ` [${c.detail}]` : ''}${c.source ? `  (${c.source})` : ''}`);
      // On a certain finding these are other services/fields that could not be checked; they stay visible.
      for (const m of f.missing_inputs) line(`      ${f.label === 'UNKNOWN' ? 'missing' : 'unchecked'}: ${m}`);
      for (const e of f.evidence) line(`      source : ${e.id} <${e.url}> (${e.revision})`);
    }
  }
  line('');
  line(`Summary : ${Object.entries(r.summary).map(([l, fams]) => `${l} ${fams.length}${fams.length ? ` (${fams.join(',')})` : ''}`).join(' | ')}`);
  if (r.summary.UNKNOWN.length) line('UNKNOWN means the given inputs cannot decide the question. It is not a pass.');
  line(`Coverage: families ${r.coverage.families.join(', ')}. ${r.coverage.not_applicable_means}`);
  line(`          ${r.coverage.not_covered}`);
  return out.join('\n') + '\n';
}
