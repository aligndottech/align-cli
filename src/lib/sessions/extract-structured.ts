import type { AgentName, CanonicalSession, SessionTurn } from './types.js';

export interface SessionDecisionCandidate {
  agent: AgentName;
  sessionId: string;
  /** The structured tool call's own id - unique within the session, and the value used to
   *  build the source_url's messageId segment. */
  messageId: string;
  question: string;
  header: string | null;
  options: Array<{ label: string; description?: string }>;
  /** The answer, verbatim - either a listed option's label or free text (Claude Code's
   *  "Other"). Never null here: a candidate with no resolvable answer is not returned at
   *  all (see extractAskUserQuestion). */
  chosenLabel: string;
  timestamp: string | null;
}

/** Only Claude Code exposes a structured decision-shaped tool call today. One producer per
 *  agent that has one - designed so a second agent's equivalent slots in without touching
 *  this dispatch or any caller (ALI-608 addendum's explicit design note). */
type Producer = (session: CanonicalSession) => SessionDecisionCandidate[];
const PRODUCERS: Partial<Record<AgentName, Producer>> = {
  'claude-code': extractAskUserQuestion,
};

export function extractStructuredDecisions(session: CanonicalSession): SessionDecisionCandidate[] {
  return PRODUCERS[session.agent]?.(session) ?? [];
}

interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
  }>;
}

/**
 * Claude Code's AskUserQuestion tool_result is free text, not structured JSON - the tool
 * itself renders it that way (`"<question>"="<answer>". <trailing sentence>`). Anchoring on
 * the question's own text (echoed verbatim by the tool) rather than splitting on commas
 * keeps this correct even when an answer itself contains a comma or a quote.
 */
function parseAnsweredText(resultText: string, question: string): string | null {
  const marker = `"${question}"=`;
  const idx = resultText.indexOf(marker);
  if (idx === -1) return null;
  const after = resultText.slice(idx + marker.length);
  if (!after.startsWith('"')) return null;
  const body = after.slice(1);
  // The two real trailing phrasings this tool emits, whichever fires depends on whether one
  // question was asked or several. A quote not followed by either is inside the answer.
  const suffixMatch = body.search(/"\.\s*(Read the answers|You can now continue)/);
  if (suffixMatch !== -1) return body.slice(0, suffixMatch);
  // Last resort (e.g. this is the final question in a multi-question call, with nothing
  // trailing but the closing quote): take up to the last quote in the string.
  const lastQuote = body.lastIndexOf('"');
  return lastQuote === -1 ? null : body.slice(0, lastQuote);
}

function extractAskUserQuestion(session: CanonicalSession): SessionDecisionCandidate[] {
  const candidates: SessionDecisionCandidate[] = [];
  for (const turn of session.turns) {
    for (const call of turn.toolCalls) {
      if (call.name !== 'AskUserQuestion') continue;
      const input = call.arguments as AskUserQuestionInput | undefined;
      const q = input?.questions?.[0];
      if (!q) continue;
      const resultText = findToolResult(session.turns, call.id);
      if (resultText === null) continue;
      const chosenLabel = parseAnsweredText(resultText, q.question);
      // A rejection ("the tool use was rejected...") or any other unrecognised result shape
      // has no `"<question>"=` marker, so this is also where a decline is filtered out -
      // nothing was decided, so nothing is a candidate.
      if (chosenLabel === null) continue;
      candidates.push({
        agent: session.agent,
        sessionId: session.sessionId,
        messageId: call.id,
        question: q.question,
        header: q.header ?? null,
        options: q.options.map(o => ({ label: o.label, ...(o.description !== undefined ? { description: o.description } : {}) })),
        chosenLabel,
        timestamp: turn.timestamp,
      });
    }
  }
  return candidates;
}

function findToolResult(turns: SessionTurn[], toolCallId: string): string | null {
  for (const turn of turns) {
    if (toolCallId in turn.toolResults) return turn.toolResults[toolCallId];
  }
  return null;
}
