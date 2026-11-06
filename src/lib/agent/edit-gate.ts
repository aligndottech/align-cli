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

/** A card's why is one short line: a git-imported summary is the whole commit body. */
const WHY_MAX = 160;
function shortWhy(summary: string | undefined): string | undefined {
  const first = summary?.split('\n').map((l) => l.trim()).find(Boolean);
  if (!first) return undefined;
  return first.length > WHY_MAX ? `${first.slice(0, WHY_MAX - 3).trimEnd()}...` : first;
}

const TIMED_OUT = Symbol('timed-out');
function within<T>(ms: number, work: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export async function gateEdit(ask: ToolAsk, deps: GateDeps): Promise<GateOutcome> {
  // An edit with no path is a shape this gate cannot read (an engine field it does not map).
  // It asks rather than passing unseen.
  const filePath = ask.edit?.file_path ?? '';
  if (!filePath) return { kind: 'ask', reason: 'unchecked', cards: [] };
  // A deletion has no new text to search with, but blame still reads the lines it removes.
  const text = proposedChangeText(ask.edit);
  const noRelated = Promise.resolve({ relevant_decisions: [] } as unknown as AlignmentResult);

  // Separate budgets: a failed or slow retrieval must not throw away a blame hit, which is the
  // stronger signal and the one that asks the person.
  const ms = deps.retrievalMs ?? RETRIEVAL_MS;
  const settle = <T>(work: Promise<T>) => within(ms, work).catch((): typeof TIMED_OUT => TIMED_OUT);
  const [related, wrote] = await Promise.all([
    settle(text.trim() ? deps.client.checkAlignment(text, filePath, { depth: 'related' }) : noRelated),
    settle(deps.blame(ask.edit, deps.cwd)),
  ]);

  const blameCards: GateDecision[] = (wrote === TIMED_OUT ? [] : wrote).map((d) => ({ id: d.id, title: d.title, via: 'blame' }));
  const seen = new Set(blameCards.map((c) => c.id));
  const retrievalCards: GateDecision[] = (related === TIMED_OUT ? [] : related.relevant_decisions ?? [])
    .filter((d) => !seen.has(d.id))
    .map((d) => ({ id: d.id, title: d.title, why: shortWhy(d.summary), url: decisionLinkFor(d), via: 'retrieval' }));
  // A blame hit always reaches the person, and no model verdict can clear it: that the edit
  // rewrites lines a decision wrote is a fact from git, a verdict is a guess about a fragment
  // (measured on fastify #7089, 6 Nov: "not a conflict" let the reversal through). So no model
  // call is spent here either.
  if (blameCards.length) return { kind: 'ask', reason: 'rewrites-decided-lines', cards: [...blameCards, ...retrievalCards] };
  // No blame hit and a check that did not finish: say so rather than reading as a pass.
  if (related === TIMED_OUT || wrote === TIMED_OUT) return { kind: 'allow', cards: [], note: 'not-checked' };
  if (!retrievalCards.length) return { kind: 'allow', cards: [] };

  // Retrieval alone only finds what is similar. A model may escalate that to a question; it
  // never turns a question into a silent pass, because there is none to clear.
  if (deps.canAdjudicate()) {
    const verdict = await within(deps.adjudicateMs ?? ADJUDICATE_MS, deps.client.checkAlignment(text, filePath, { depth: 'full' })).catch((): typeof TIMED_OUT => TIMED_OUT);
    if (verdict !== TIMED_OUT && verdict.status === 'conflicting') {
      const cards: GateDecision[] = (verdict.conflicts ?? []).map((c) => ({ id: c.decision_id, title: c.title, why: c.reason, url: decisionLinkFor(c), via: 'verdict' }));
      return { kind: 'ask', reason: 'conflict', cards };
    }
    // A verdict that never came is not a verdict: keep the cards, and say it was not checked.
    if (verdict === TIMED_OUT || verdict.status === 'unknown') return { kind: 'allow', cards: retrievalCards, note: 'not-checked' };
  }
  return { kind: 'allow', cards: retrievalCards };
}
