/**
 * LM: the rules every local MCP tool that RECORDS something shares (Decision 16).
 *
 * - `strictInput`: a closed input schema. An unknown property is refused by NAME before any
 *   handler runs, and its value is never echoed (a pasted token must not land in the transcript
 *   it was typed into). Nothing here lets a token or key in: there is no property for one.
 * - `agentIdFrom`: the MCP `initialize` request's `clientInfo.name`, mapped through a closed table
 *   onto the launcher registry's ids, else 'unknown'. The raw name is never stored. The hosted
 *   server applies the same rule to what a share sends (it drops an id it does not know), so the
 *   two ends agree on one closed list.
 * - `cliCommandFor`: the exact command for the PERSON when an act is theirs alone.
 */
import { AGENT_REGISTRY } from '../launch/registry/index.js';

export interface StringProp { type: 'string'; description: string; enum?: readonly string[]; maxLength?: number }
export interface StringArrayProp { type: 'array'; description: string; maxItems: number; itemMaxLength: number }
export type Prop = StringProp | StringArrayProp;

export interface StrictSpec {
  tool: string;
  properties: Record<string, Prop>;
  required: readonly string[];
}

/** The JSON Schema `tools/list` advertises: closed, with the same limits the validator enforces. */
export function jsonSchemaOf(spec: StrictSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(spec.properties)) {
    properties[name] = p.type === 'string'
      ? { type: 'string', description: p.description, ...(p.enum ? { enum: [...p.enum] } : {}), ...(p.maxLength ? { maxLength: p.maxLength } : {}) }
      : { type: 'array', description: p.description, maxItems: p.maxItems, items: { type: 'string', maxLength: p.itemMaxLength } };
  }
  return { type: 'object', properties, required: [...spec.required], additionalProperties: false };
}

/** Throws a tool error naming what is wrong, never echoing a rejected property's value. */
export function strictInput(spec: StrictSpec, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const input = args ?? {};
  const known = Object.keys(spec.properties);
  const unknown = Object.keys(input).filter((k) => !known.includes(k));
  if (unknown.length) {
    const names = unknown.slice(0, 3).map((k) => JSON.stringify(k.slice(0, 16))).join(', ');
    throw new Error(
      `${spec.tool} takes only ${known.map((k) => `"${k}"`).join(', ')}, and does not accept ${names}. ` +
      'No tool accepts a token or key: the person connects a source or adds a key themselves with the align command.',
    );
  }
  for (const name of spec.required) {
    const v = input[name];
    if (v === undefined || v === null || v === '') {
      throw new Error(`${spec.tool} requires "${name}". Call it again with it set.`);
    }
  }
  for (const [name, p] of Object.entries(spec.properties)) {
    const v = input[name];
    if (v === undefined) continue;
    if (p.type === 'string') {
      if (typeof v !== 'string') throw new Error(`${spec.tool} "${name}" must be a string.`);
      if (p.enum && !p.enum.includes(v)) throw new Error(`${spec.tool} "${name}" must be one of: ${p.enum.join(', ')}.`);
      if (p.maxLength !== undefined && v.length > p.maxLength) throw new Error(`${spec.tool} "${name}" is at most ${p.maxLength} characters.`);
    } else {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${spec.tool} "${name}" must be a list of strings.`);
      if (v.length > p.maxItems) throw new Error(`${spec.tool} "${name}" is at most ${p.maxItems} entries.`);
      if (v.some((x: string) => x.length > p.itemMaxLength)) throw new Error(`${spec.tool} "${name}" entries are at most ${p.itemMaxLength} characters.`);
    }
  }
  return input;
}

/**
 * Names MCP clients send in `clientInfo.name`, beyond the registry ids themselves. Exact match
 * after lowercasing: a prefix or substring rule would let an arbitrary name claim to be a known
 * agent. An addition here is a reviewed change.
 */
const CLIENT_ALIASES: ReadonlyMap<string, string> = new Map([
  ['codex-mcp-client', 'codex'],
  ['cursor-vscode', 'cursor'],
  ['gemini-cli-mcp-client', 'gemini-cli'],
]);

export const UNKNOWN_AGENT = 'unknown';

export function agentIdFrom(clientInfo: { name?: unknown } | undefined): string {
  const raw = typeof clientInfo?.name === 'string' ? clientInfo.name.trim().toLowerCase() : '';
  if (raw === '') return UNKNOWN_AGENT;
  const candidate = CLIENT_ALIASES.get(raw) ?? raw;
  return AGENT_REGISTRY.some((a) => a.name === candidate) ? candidate : UNKNOWN_AGENT;
}

export type PersonOnlyAct = 'ratify' | 'connect';
/** The command only the person may run. `arg` is a decision id or a source name. */
export function cliCommandFor(act: PersonOnlyAct, arg: string): string {
  return act === 'ratify' ? `align ratify ${arg}` : `align connect ${arg}`;
}
