import type { HumanQuestion } from '../permission-broker.js';
import type { AgentUiEvent, GateDecision, GateOutcome, HumanAnswer } from '../types.js';
import { theme } from './theme.js';

export function headerLine(o: { label: string; decisionCount: number }): string {
  const n = `${o.decisionCount} ${o.decisionCount === 1 ? 'decision' : 'decisions'}`;
  return [theme.brand('Align'), o.label, n].join(theme.dim(' · '));
}

function decisionLines(d: GateDecision): string[] {
  return [
    `  ${theme.title(d.title)}`,
    ...(d.why ? [`  ${d.why}`] : []),
    ...(d.url ? [`  ${theme.link(d.url)}`] : []),
  ];
}

export function gateCard(q: Extract<HumanQuestion, { kind: 'gate' }>): string[] {
  const lead = {
    conflict: 'This edit conflicts with a decision',
    'rewrites-decided-lines': 'This edit changes lines written by a decision',
    unchecked: 'Align could not read this edit, so it was not checked against your decisions',
  }[q.outcome.reason];
  return [
    theme.warn(lead),
    ...q.outcome.cards.flatMap((d) => ['', ...decisionLines(d)]),
    '',
    theme.key('[a] allow once   [s] stop'),
  ];
}

export function commandCard(q: Extract<HumanQuestion, { kind: 'command' }>): string[] {
  return [theme.warn('Run this command?'), `  ${q.command}`, '', theme.key('[y] yes   [s] yes for this session   [n] no')];
}

/** A command's first line, cut to `max` characters, for one-line mentions. */
export function oneLine(command: string, max = 80): string {
  const first = command.split('\n')[0] ?? '';
  return first.length > max ? `${first.slice(0, max - 1)}\u2026` : first;
}

/** What a card folds to once answered: one line, so pressing a key visibly does something. */
export function answeredLine(q: HumanQuestion, a: HumanAnswer): string {
  if (q.kind === 'command') {
    const cmd = oneLine(q.command);
    if (a === 'stop') return theme.dim(`stopped: ${cmd}`);
    return theme.dim(`${a === 'allow-session' ? 'approved for this session' : 'approved'}, running: ${cmd}`);
  }
  return theme.dim(a === 'stop' ? 'stopped the edit' : 'allowed once, applying the edit');
}

/** What an allowed edit leaves in the transcript. Never silent when the gate could not check. */
export function gateNote(outcome: GateOutcome): string[] {
  if (outcome.kind !== 'allow') return [];
  if (outcome.note === 'not-checked') return [theme.dim('not checked against the decision graph')];
  if (outcome.cards.length === 0) return [];
  return [theme.dim(`checked against: ${outcome.cards.map((d) => d.title).join(', ')}`)];
}

/** The transcript line for a tool starting, or for one that failed (with why, when it said). */
export function toolLine(e: AgentUiEvent): string[] {
  if (e.type === 'tool-start') return [`${theme.dim('•')} ${theme.title(e.tool)} ${theme.dim(e.summary)}`];
  if (e.type === 'tool-end' && !e.ok) {
    return [theme.error('  that tool call failed'), ...(e.detail ?? '').split('\n').filter((l) => l !== '').map((l) => theme.dim(`    ${l}`))];
  }
  return [];
}
