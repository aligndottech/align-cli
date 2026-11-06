import { dispatchTool, isFirstUsefulToolResult, serializeMcpResult, TOOL_SCHEMAS } from '../../commands/mcp.js';
import type { EnvironmentConfig } from '../config.js';
import type { createGatewayClient } from '../gateway-client.js';
import { recordFunnelStage } from '../usage-telemetry.js';

/**
 * The decision-graph tools the Align engine hands its model, as engine-neutral specs. An engine
 * adapter turns each spec into its own tool type, so no engine's types leak in here.
 *
 * Every tool goes through dispatchTool, the router `align mcp` serves, so an agent asking from
 * inside `align` gets the answers an agent asking over MCP gets. These are the four READ tools
 * an agent reaches for; align_capture and the other writers stay out of the agent's hands.
 */
export interface GraphToolSpec {
  name: string;
  description: string;
  /** JSON Schema, copied from TOOL_SCHEMAS so there is one writer of what a tool takes. */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

export interface GraphToolDeps {
  client: ReturnType<typeof createGatewayClient>;
  env: EnvironmentConfig;
}

const GRAPH_TOOL_NAMES = ['align_ask', 'align_search', 'align_get_topic_timeline', 'align_get_related_decisions'] as const;

export function createGraphTools({ client, env }: GraphToolDeps): GraphToolSpec[] {
  // One flag per tool set, so first_useful_decision is offered once per session. The
  // once-per-install guard is recordFunnelStage's; this only stops a chatty session re-offering.
  let recordedFirstUseful = false;
  // The local graph has no topic timeline (the local client cannot serve it), so the local
  // engine is not offered a tool that would only fail.
  const names = GRAPH_TOOL_NAMES.filter((n) => !(env.mode === 'local-embedded' && n === 'align_get_topic_timeline'));
  return names.map((name) => {
    const schema = TOOL_SCHEMAS.find((s) => s.name === name);
    if (!schema) throw new Error(`graph tool ${name} is not in TOOL_SCHEMAS`);
    return {
      name,
      description: schema.description,
      parameters: schema.inputSchema as Record<string, unknown>,
      async run(args) {
        const result = await dispatchTool(name, args, client, env);
        if (!recordedFirstUseful && isFirstUsefulToolResult(name, result)) {
          recordedFirstUseful = true;
          // Not awaited: a tool response never waits on telemetry (same as createCallToolHandler).
          void recordFunnelStage(env, 'first_useful_decision', 'mcp');
        }
        // Any successful graph call is use, as in the MCP handler; recordFunnelStage keeps it to once a day.
        void recordFunnelStage(env, 'agent_active', 'mcp');
        return serializeMcpResult(result);
      },
    };
  });
}
