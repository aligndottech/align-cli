import type { AgentName, CanonicalSession } from './types.js';

/**
 * ALI-809 Pass B, heuristic half: a HUMAN turn whose own words redirect or settle on an
 * approach mid-session. Everything downstream (confirm-freetext.ts) treats this as a proposal
 * only - "heuristic proposes, LLM adjudicates, only adjudicated results assert" is the same
 * shape as decision_links' writer split (align decision ALI-409), applied here to candidates
 * instead of edges.
 */
export interface RawFreeTextCandidate {
  agent: AgentName;
  sessionId: string;
  /** `turn-<index>` into the parsed session's turns array - stable for one session file, and
   *  used only as an object-reference-free identity in the source_url; nothing here needs it
   *  to survive a re-parse of a DIFFERENT file. */
  messageId: string;
  /** The human's own words, verbatim - the only decider-authored content in this candidate. */
  humanText: string;
  /** The assistant turn immediately after, when there is one - CONTEXT for the LLM confirmation
   *  pass to read, never itself scanned for the trigger phrase and never the source of the
   *  claim (the same "don't let bot content pass as the human's own statement" principle as
   *  align decision ALI-538, applied to a different pipeline). */
  contextText: string | null;
  timestamp: string | null;
}

/**
 * Phrases a human types when redirecting or settling on an approach mid-session. Calibrated
 * against four REAL captured sessions (fixtures/sessions/), not invented - see
 * extract-freetext.test.ts's end-to-end block for which fixture drove which pattern. A miss
 * here is a missed candidate, not a wrong one (the LLM pass only ever narrows further), so
 * staying narrow and growing this as more real sessions are captured beats guessing at
 * phrasings nobody has actually said.
 */
const DECISION_PHRASES: readonly RegExp[] = [
  /\binstead of\b/i,
  /\blet'?s (go with|use|do|switch to|just use|just go with)\b/i,
  /\bdecid(e|ed|ing|ision)\b/i,
  /\bgo with\b/i,
  /\bswitch(ed|ing)? to\b/i,
];

function isDecisionShaped(text: string): boolean {
  return DECISION_PHRASES.some(p => p.test(text));
}

/**
 * The assistant's reply to a human's redirect is rarely one turn: a commentary aside, a tool
 * call, and the actual resolution routinely land as separate turns in the canonical shape
 * (confirmed against the real codex and opencode fixtures - a tool-call turn carries text: ''
 * and sits between the commentary and the resolution in both). Walks every CONSECUTIVE
 * assistant turn starting at `from`, joining the non-empty ones, and stops at the next human
 * turn or the end of the session - never crossing into a later human turn's own reply.
 */
function collectAssistantContext(turns: CanonicalSession['turns'], from: number): string | null {
  const parts: string[] = [];
  for (let i = from; i < turns.length && turns[i].role === 'assistant'; i++) {
    if (turns[i].text) parts.push(turns[i].text);
  }
  return parts.length ? parts.join('\n') : null;
}

export function findFreeTextCandidates(session: CanonicalSession): RawFreeTextCandidate[] {
  const candidates: RawFreeTextCandidate[] = [];
  session.turns.forEach((turn, i) => {
    // toolCalls-only turns carry text: '' (types.ts), which no phrase can match - no special
    // case needed beyond the phrase test itself.
    if (turn.role !== 'user' || !isDecisionShaped(turn.text)) return;
    candidates.push({
      agent: session.agent,
      sessionId: session.sessionId,
      messageId: `turn-${i}`,
      humanText: turn.text,
      contextText: collectAssistantContext(session.turns, i + 1),
      timestamp: turn.timestamp,
    });
  });
  return candidates;
}
