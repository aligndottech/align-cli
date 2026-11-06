import type { HookToolInput } from '../hook-payload.js';

/**
 * The Align agent's own vocabulary. Engines (Align's own on Pi, the user's own Claude Code)
 * translate their wire formats into these types, so the gate, the broker and the UI never
 * name an engine's types, and a breaking change in an engine stays inside its adapter.
 */

/** What a tool call is, for the purpose of deciding who must approve it. */
export type ToolKind = 'edit' | 'command' | 'read' | 'other';

export interface ToolAsk {
  /** The engine's id for this tool call. */
  id: string;
  /** The engine's tool name, as the engine spells it (Write, edit, Bash, bash). */
  tool: string;
  kind: ToolKind;
  /** For kind 'edit': the change normalised to the shape the hook check already reads. */
  edit?: HookToolInput;
  /** For kind 'command': the command line. */
  command?: string;
}

/** A decision shown to the human on a gate card. */
export interface GateDecision {
  id: string;
  title: string;
  why?: string;
  url?: string;
  /** How the gate found it: the edit rewrites lines it wrote, retrieval, or an adjudicated verdict. */
  via: 'blame' | 'retrieval' | 'verdict';
}

export type GateOutcome =
  | { kind: 'allow'; cards: GateDecision[]; note?: 'not-checked' }
  | { kind: 'ask'; reason: 'conflict' | 'rewrites-decided-lines'; cards: GateDecision[] };

export type HumanAnswer = 'allow' | 'allow-session' | 'stop';

export type BrokerVerdict = { allow: true } | { allow: false; message: string };

export type AgentUiEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-start'; id: string; tool: string; summary: string }
  | { type: 'tool-end'; id: string; ok: boolean }
  | { type: 'gate'; outcome: GateOutcome; filePath?: string }
  | { type: 'turn-end' }
  | { type: 'error'; message: string };

/** The port every engine implements. */
export interface AgentEngine {
  /** Shown in the header, e.g. "Claude Code (your subscription)". */
  readonly label: string;
  start(onEvent: (e: AgentUiEvent) => void, broker: (ask: ToolAsk) => Promise<BrokerVerdict>): Promise<void>;
  /** Sends one user turn; resolves when the turn ends. */
  prompt(text: string): Promise<void>;
  abort(): void;
  close(): Promise<void>;
}
