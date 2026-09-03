import type { AgentName } from './types.js';

const AGENTS: readonly AgentName[] = ['claude-code', 'codex', 'cursor', 'gemini-cli', 'opencode', 'pi'];

/** ALI-808 shared contract: the agent name lives in the scheme, `platform` stays the single
 *  value `agent-session` everywhere else. */
export function buildSessionSourceUrl(agent: AgentName, sessionId: string, messageId: string): string {
  return `${agent}-session://${sessionId}/${messageId}`;
}

export function parseSessionSourceUrl(url: string): { agent: AgentName; sessionId: string; messageId: string } | null {
  for (const agent of AGENTS) {
    const prefix = `${agent}-session://`;
    if (url.startsWith(prefix)) {
      const rest = url.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) return null;
      return { agent, sessionId: rest.slice(0, slash), messageId: rest.slice(slash + 1) };
    }
  }
  return null;
}
