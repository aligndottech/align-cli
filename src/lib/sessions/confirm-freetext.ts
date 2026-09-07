import { DETERMINISTIC_TEMPERATURE } from '@aligndottech/connector-core';
import {
  callChatDetailed,
  CLASSIFIER_MAX_TOKENS,
  hasConfiguredProvider,
  type LlmFailure,
  resolveMaxTokens,
} from '../local-llm.js';
import type { AgentName } from './types.js';
import type { RawFreeTextCandidate } from './extract-freetext.js';

/** A raw heuristic hit the model reviewed and stood behind - the only shape that may reach
 *  the confirm-each UX (align decision ALI-409: "only adjudicated results assert"). */
export interface ConfirmedFreeTextDecision {
  agent: AgentName;
  sessionId: string;
  messageId: string;
  /** Verbatim from the raw candidate - never replaced by the model's title. See
   *  extract-freetext.ts's RawFreeTextCandidate.humanText docstring for why. */
  humanText: string;
  /** A short label for the confirm-each review list, written by the model FROM humanText and
   *  contextText - never itself stored as the claim's own words. */
  title: string;
  confidence: number;
  timestamp: string | null;
}

/** Coarse on purpose, same reasoning as local-relationship-classifier.ts's
 *  ClassifierFailureReason: the finer detail travels on `failure` (provider, model, detail). */
export type ConfirmFailureReason = 'no_llm_key' | 'confirm_error' | 'confirm_unparseable' | 'unvetted_local_model';

export type ConfirmOutcome =
  /** decision: null means the model looked and said the heuristic misfired - nothing was
   *  actually decided here, so nothing is returned to review. */
  | { ok: true; decision: ConfirmedFreeTextDecision | null }
  | { ok: false; reason: ConfirmFailureReason; failure?: LlmFailure };

const SYSTEM_PROMPT =
  'You review one turn from a coding-agent session transcript to decide whether the HUMAN ' +
  'stated a decision or redirect mid-session (e.g. "let\'s use X instead", "go with Y", ' +
  '"decided to switch to Z"). CONTEXT is the agent\'s reply and is background only - it tells ' +
  'you what was actually resolved, but the thing being reviewed is the human\'s turn, not the ' +
  'agent\'s. Respond ONLY with compact JSON: ' +
  '{"isDecision": boolean, "title": short string naming what was decided, "confidence": number 0-1}. ' +
  'Set isDecision to false when HUMAN_TEXT is a question, a bug report, a command, or anything ' +
  'else that is not actually a decision or redirect.';

function buildUserPrompt(candidate: RawFreeTextCandidate): string {
  return `HUMAN_TEXT: ${candidate.humanText}\n\nCONTEXT (the agent's reply, background only): ${candidate.contextText ?? '(none)'}`;
}

interface ParsedConfirmation {
  isDecision: boolean;
  title: string;
  confidence: number;
}

function parseConfirmation(text: string): ParsedConfirmation | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { isDecision?: unknown; title?: unknown; confidence?: unknown };
    if (typeof obj.isDecision !== 'boolean') return null;
    const confidence = typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    return { isDecision: obj.isDecision, title, confidence };
  } catch {
    return null;
  }
}

export async function confirmFreeTextCandidate(candidate: RawFreeTextCandidate): Promise<ConfirmOutcome> {
  const maxTokens = resolveMaxTokens('ALIGN_CLASSIFIER_MAX_TOKENS', CLASSIFIER_MAX_TOKENS);
  const result = await callChatDetailed(SYSTEM_PROMPT, buildUserPrompt(candidate), {
    temperature: DETERMINISTIC_TEMPERATURE,
    maxTokens,
  });
  if (!result.ok) {
    const reason: ConfirmFailureReason =
      result.failure.kind === 'unrecognised_local_models' ? 'unvetted_local_model'
        : result.failure.kind === 'provider_stopped' ? 'confirm_error'
          : hasConfiguredProvider() ? 'confirm_error' : 'no_llm_key';
    return { ok: false, reason, failure: result.failure };
  }
  const parsed = parseConfirmation(result.text);
  if (!parsed) return { ok: false, reason: 'confirm_unparseable' };
  if (!parsed.isDecision) return { ok: true, decision: null };
  return {
    ok: true,
    decision: {
      agent: candidate.agent,
      sessionId: candidate.sessionId,
      messageId: candidate.messageId,
      humanText: candidate.humanText,
      title: parsed.title || candidate.humanText,
      confidence: parsed.confidence,
      timestamp: candidate.timestamp,
    },
  };
}
