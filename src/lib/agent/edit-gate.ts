import { decisionLinkFor } from '../decision-links.js';
import type { AlignmentResult } from '../gateway-client.js';
import type { HookToolInput } from '../hook-payload.js';
import { proposedChangeText, type RelatedDecision } from './edit-text.js';
import type { GateDecision, GateOutcome, ToolAsk } from './types.js';

/**
 * The edit gate: every edit either engine proposes passes here before it is written.
 *
 * Retrieval and `git blame` run first, together, inside the hook's retrieval budget. Only when
 * they find something, and a model is configured, is the change adjudicated - that costs a model
 * call (~11s measured), so the human sees a spinner rather than a silent stall. The gate asks the
 * human on an adjudicated conflict, and on an edit that rewrites lines a decision wrote when no
 * verdict could be had: that second rule is how a keyless user still gets stopped on fastify#7089.
 * A check that could not run says so ('not-checked'); it never reads as a pass.
 */

export interface GateClient {
  checkAlignment(text: string, context: string, opts: { depth: 'related' | 'full' }): Promise<AlignmentResult>;
}

export interface GateDeps {
  client: GateClient;
  cwd: string;
  /** True when a model is configured to adjudicate (a key or Ollama). */
  canAdjudicate: () => boolean;
  blame: (input: HookToolInput | undefined, cwd: string) => Promise<RelatedDecision[]>;
  retrievalMs?: number;
  adjudicateMs?: number;
}

/** Same budget as the advisory hook's retrieval (check.ts RETRIEVAL_TIMEOUT_MS). */
const RETRIEVAL_MS = 2500;
const ADJUDICATE_MS = 15_000;

const TIMED_OUT = Symbol('timed-out');
function within<T>(ms: number, work: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export async function gateEdit(ask: ToolAsk, deps: GateDeps): Promise<GateOutcome> {
  const text = proposedChangeText(ask.edit);
  if (!text.trim()) return { kind: 'allow', cards: [] };
  const filePath = ask.edit?.file_path ?? '';

  const found = await within(deps.retrievalMs ?? RETRIEVAL_MS, Promise.all([
    deps.client.checkAlignment(text, filePath, { depth: 'related' }),
    deps.blame(ask.edit, deps.cwd),
  ])).catch((): typeof TIMED_OUT => TIMED_OUT);
  if (found === TIMED_OUT) return { kind: 'allow', cards: [], note: 'not-checked' };

  const [related, wrote] = found;
  const blameCards: GateDecision[] = wrote.map((d) => ({ id: d.id, title: d.title, via: 'blame' }));
  const seen = new Set(blameCards.map((c) => c.id));
  const retrievalCards: GateDecision[] = (related.relevant_decisions ?? [])
    .filter((d) => !seen.has(d.id))
    .map((d) => ({ id: d.id, title: d.title, why: d.summary, url: decisionLinkFor(d), via: 'retrieval' }));
  if (!blameCards.length && !retrievalCards.length) return { kind: 'allow', cards: [] };

  if (deps.canAdjudicate()) {
    const verdict = await within(deps.adjudicateMs ?? ADJUDICATE_MS, deps.client.checkAlignment(text, filePath, { depth: 'full' })).catch((): typeof TIMED_OUT => TIMED_OUT);
    if (verdict !== TIMED_OUT && verdict.status === 'conflicting') {
      const cards: GateDecision[] = (verdict.conflicts ?? []).map((c) => ({ id: c.decision_id, title: c.title, why: c.reason, url: decisionLinkFor(c), via: 'verdict' }));
      return { kind: 'ask', reason: 'conflict', cards };
    }
    if (verdict !== TIMED_OUT && (verdict.status === 'aligned' || verdict.status === 'no-context')) {
      return { kind: 'allow', cards: [...blameCards, ...retrievalCards] };
    }
  }

  if (blameCards.length) return { kind: 'ask', reason: 'rewrites-decided-lines', cards: [...blameCards, ...retrievalCards] };
  return { kind: 'allow', cards: retrievalCards };
}
