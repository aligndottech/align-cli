import chalk from 'chalk';
import type { StaleFinding, StaleReport } from './stale-code.js';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const rangeText = (r: [number, number]) => (r[0] === r[1] ? `${r[0]}` : `${r[0]}-${r[1]}`);
const shortRanges = (rs: Array<[number, number]>) => { const t = rs.slice(0, 6).map(rangeText).join(', '); return rs.length > 6 ? `${t}, +${rs.length - 6} more` : t; };

/** The wording the command and the MCP tool both use: never "wrong", only built on a replaced decision. */
export function renderFinding(f: StaleFinding): string[] {
  const out = [
    `${plural(f.totalLines, 'line')} built on a decision that was replaced`,
    `  Replaced:     ${f.replaced.title}${f.replaced.sourceUrl ? `  ${f.replaced.sourceUrl}` : ''}`,
    `  Replaced by:  ${f.replacedBy.title}${f.replacedBy.sourceUrl ? `  ${f.replacedBy.sourceUrl}` : ''}`,
    f.confirmation === 'ai-suggested'
      ? `  Link:         AI-suggested, not confirmed (confidence ${Number(f.confidence ?? 0).toFixed(2)})`
      : '  Link:         confirmed by a person',
  ];
  for (const h of f.files) out.push(`  ${h.file}  ${plural(h.lines, 'line')}  (${h.lines === 1 ? "line" : "lines"} ${shortRanges(h.ranges)})`);
  return out;
}

export function reportNotes(r: StaleReport, extra: string[], includeAi: boolean): string[] {
  const notes = [...extra];
  if (!includeAi && r.aiExcluded > 0) {
    notes.push(`${plural(r.aiExcluded, 'AI-suggested supersedes link')} left out because no person confirmed ${r.aiExcluded === 1 ? 'it' : 'them'}. Add --include-ai to include ${r.aiExcluded === 1 ? 'it' : 'them'}.`);
  }
  if (r.skipped.length) notes.push(`Skipped ${plural(r.skipped.length, 'replaced decision')}: ${[...new Set(r.skipped.map((s) => s.reason))].join('; ')}.`);
  if (r.filesCapped) notes.push(`${plural(r.filesCapped, 'replaced decision')} touched more files than the per-decision cap, so only the first files were checked.`);
  if (r.budgetExceeded) notes.push('The time budget ran out before every decision was checked.');
  return notes;
}

export function renderReport(r: StaleReport, extra: string[], includeAi: boolean): string {
  const lines: string[] = [];
  if (!r.findings.length) {
    lines.push(`No code on ${r.ref} is still built on a replaced decision (checked ${plural(r.linksConsidered, 'supersedes link')}).`);
  } else {
    const total = r.findings.reduce((n, f) => n + f.totalLines, 0);
    lines.push(chalk.bold(`${plural(total, 'line')} still built on ${plural(r.findings.length, 'replaced decision')} (blame on ${r.ref})`), '');
    for (const f of r.findings) lines.push(...renderFinding(f), '');
  }
  for (const n of reportNotes(r, extra, includeAi)) lines.push(chalk.dim(n));
  return lines.join('\n');
}
