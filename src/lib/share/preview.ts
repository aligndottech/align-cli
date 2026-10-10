/**
 * L9: the text a person reads before anything leaves the machine. Plain text with no colour, so the
 * CLI prints it, the confirmation prompt re-renders it from the stored payload, and `align_share`
 * returns the SAME string to the agent. It is rendered from the payload objects `buildSharePayload`
 * made, which are the objects that are sent: it cannot show one thing and send another.
 *
 * Judgements an agent relayed are listed under their own heading, so the person sees them before
 * they leave. What stays local is named, so a missing verdict is a visible choice and not a surprise.
 */
import { visible } from './visible.js';
import type { LeftLocal, SharePayload, ShownJudgement } from './payload.js';

export interface Destination {
  /** The workspace name from the token's tenant. */
  workspace: string;
  env: string;
  /** The signed-in account. */
  email: string;
}

export interface PreviewOptions {
  /** Local ids this machine shared before: the preview says it is an update. */
  updates?: ReadonlySet<string>;
  /** Local ids an old `align push` sent without a workspace: a second share may make a second copy. */
  legacy?: ReadonlySet<string>;
}

const day = (iso: string): string => iso.slice(0, 10);
const quoted = (t: string | null): string => (t ? `"${visible(t)}"` : 'another decision');

function describe(s: ShownJudgement): string {
  const w = s.wire;
  const when = day(w.judged_at);
  switch (w.kind) {
    case 'ratify': return `ratified by you (${when})`;
    case 'conflict_verdict':
      return `${w.value === 'false_positive' ? 'not a real conflict' : 'a real conflict'} with ${quoted(s.counterpartTitle)} (${when})`;
    case 'check_verdict': return `check hit judged ${w.value === 'false_positive' ? 'a false alarm' : 'real'} (${when})`;
    case 'supersede': return `replaces ${quoted(s.counterpartTitle)} (${when})`;
    case 'not_a_decision': return `marked as not a decision (${when})`;
    case 'note': return `note: "${visible(w.note ?? '')}" (${when})`;
  }
}

function leftLocalLine(l: LeftLocal): string {
  const noun = l.kind === 'conflict_verdict' ? 'conflict verdict' : l.kind === 'supersede' ? 'replaced mark' : l.kind.replace(/_/g, ' ');
  return l.why === 'counterpart_not_shared'
    ? `a ${noun} about ${quoted(l.counterpartTitle)}: that decision is not on your team graph`
    : `an older ${noun}: a decision carries at most 50 judgements`;
}

const indent = (text: string, pad: string): string => visible(text, { keepNewline: true }).split('\n').map((l) => `${pad}${l}`).join('\n');

export function renderPreview(payloads: readonly SharePayload[], dest: Destination, opts: PreviewOptions = {}): string {
  const lines: string[] = [
    `You are about to share ${payloads.length} decision${payloads.length === 1 ? '' : 's'} with your team.`,
    '',
  ];
  payloads.forEach((p, i) => {
    const ownJudgements = p.shown.filter((s) => s.via === 'cli');
    const viaAgent = p.shown.filter((s) => s.via === 'mcp');
    lines.push(`${i + 1}. ${visible(p.item.title)}${opts.updates?.has(p.localId) ? '  (update: you shared this before)' : ''}`);
    lines.push(indent(p.item.raw_text, '   '));
    lines.push(`   Source: ${visible(p.item.source_url)} (${visible(p.item.platform)})`);
    if (p.item.created_at) lines.push(`   Decided: ${day(p.item.created_at)}`);
    if (opts.legacy?.has(p.localId)) {
      lines.push(`   This was pushed before Align tracked shares, so sharing again may create a second copy. Retract the old one: align share --retract ${  p.localId}`);
    }
    if (ownJudgements.length) {
      lines.push('   Goes with it:');
      for (const s of ownJudgements) lines.push(`     - ${describe(s)}`);
    }
    for (const agent of [...new Set(viaAgent.map((s) => s.agentId ?? 'unknown'))]) {
      lines.push(`   Recorded by your agent (${visible(agent)}):`);
      for (const s of viaAgent.filter((x) => (x.agentId ?? 'unknown') === agent)) lines.push(`     - ${describe(s)}`);
    }
    if (p.leftLocal.length) {
      lines.push('   Stays on this machine:');
      for (const l of p.leftLocal) lines.push(`     - ${leftLocalLine(l)}`);
    }
    lines.push('');
  });
  // The destination is the LAST thing printed, directly above the question, so it is what is read last.
  lines.push('Nothing is sent until you say yes.', `To: ${visible(dest.workspace)} (${visible(dest.env)}) as ${visible(dest.email)}`);
  return lines.join('\n');
}
