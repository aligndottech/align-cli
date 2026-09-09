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

/**
 * ALI-810: memory files are not sessions, so they get their own scheme rather than being
 * squeezed into `<agent>-session://<sessionId>/<messageId>` with invented ids.
 *
 * Built from the project directory name and the topic file's stem, both of which are stable
 * for a given memory across rewrites - Claude edits a topic file in place rather than making
 * a new one. That stability is the point: the gateway upserts on `(tenant_id, source_url)`,
 * so re-running the import after Claude has revised a memory updates the decision instead of
 * adding a second copy of it.
 */
export function buildMemorySourceUrl(memoryDir: string, filePath: string): string {
  const project = memoryDir.split(/[\\/]/).filter(Boolean).at(-2) ?? 'unknown-project';
  const topic = (filePath.split(/[\\/]/).pop() ?? 'unknown').replace(/\.md$/, '');
  return `claude-code-memory://${project}/${topic}`;
}
