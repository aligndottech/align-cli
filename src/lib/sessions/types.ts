/**
 * ALI-808: the canonical shape every per-agent adapter parses into, so extraction (Pass A,
 * and eventually ALI-809's Pass B) never learns which agent it is reading - the same
 * `normalizeHookPayload` pattern used for the destructive-command guard (ALI-357/#1953) and
 * the pre-edit conflict check (align-cli#86), both cited in the ALI-608 addendum.
 */

/** The six agents named in the ALI-808 shared contract. Not every adapter parses content yet
 *  (see `fixtureVerified` on SessionAdapter) - the name is reserved even where the reader
 *  is not, because it is also the scheme host in a session's source_url. */
export type AgentName = 'claude-code' | 'codex' | 'cursor' | 'gemini-cli' | 'opencode' | 'pi';

export interface SessionToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface SessionTurn {
  role: 'user' | 'assistant';
  /** The turn's own text, own words - never a tool result or a system reminder. Empty
   *  string, not absent, when a turn is tool-calls-only (keeps every consumer's access
   *  uniform rather than optional-chaining everywhere). */
  text: string;
  toolCalls: SessionToolCall[];
  /** Keyed by SessionToolCall.id, when the transcript records a result for it. A missing
   *  key means "no result recorded", not "empty result" - the two are different facts
   *  (a cancelled tool call vs. one that returned nothing). */
  toolResults: Record<string, string>;
  /** ISO-8601, or null when the source did not carry one for this turn. */
  timestamp: string | null;
}

export interface CanonicalSession {
  agent: AgentName;
  sessionId: string;
  /** The working directory the agent was running in, when the source records one. */
  cwd: string | null;
  turns: SessionTurn[];
}

export interface SessionAdapter {
  agent: AgentName;
  /** True only when a real captured session backs this adapter's fixture (the ALI-808
   *  shared-contract gate: "the gate is the fixture, not the agent name"). False means
   *  `parseSession` is intentionally unimplemented - see fixtures/sessions/README.md for
   *  which agents and why. */
  fixtureVerified: boolean;
  /** Session files for the given project directory, newest first. Never throws on a
   *  missing/unreadable agent data directory - that is "this agent has no local data
   *  here", not an error, and every caller (detectAgents, the import command) treats an
   *  empty array as the normal "not installed / never used here" case. */
  locateSessionFiles(cwd: string): string[];
  /** Parses one session file. Returns null for a file that does not belong to this agent's
   *  format (defensive - locateSessionFiles should not hand it one, but a caller passing an
   *  arbitrary path must get an honest null rather than a throw). Throws
   *  SessionFormatUnverifiedError for an adapter with fixtureVerified === false. */
  parseSession(filePath: string): CanonicalSession | null;
}

/** Thrown by an unverified adapter's parseSession, instead of guessing at a format nobody
 *  has confirmed against a real session (verification.md: a plausible construction is not
 *  data). Naming the fixtures README in the message is deliberate - it is the one place
 *  that explains why and what unblocks it. */
export class SessionFormatUnverifiedError extends Error {
  constructor(agent: AgentName) {
    super(
      `${agent}'s session format is not fixture-verified yet (no real captured session was ` +
      `available - see src/__tests__/fixtures/sessions/README.md). Capture a real session and ` +
      `add it as a fixture before parsing this agent's data.`,
    );
    this.name = 'SessionFormatUnverifiedError';
  }
}
