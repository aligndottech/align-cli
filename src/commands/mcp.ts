import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
const { version } = pkg;
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { createConfigStore, type EnvironmentConfig, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { detectEditors, removeMcpConfig, writeMcpConfig } from '../lib/mcp-setup.js';
import { commandIntro } from '../lib/brand.js';

// Server-level instructions (ALI-120): surfaced to the agent so it reaches for
// Align proactively - without the user prompting - the moment this MCP server is
// connected. Kept well under the ~2KB Claude Code truncates server instructions to.
export const ALIGN_MCP_INSTRUCTIONS = `Align is this team's decision graph - the source of truth for what was decided, why, and who decided it. Use these tools proactively, without being asked:

- BEFORE writing or changing non-trivial code, call align_check_alignment with the proposed change. A "conflict" result means a past decision opposes the change - STOP and confirm with the user before proceeding.
- An "unknown" status means the check could NOT run (no LLM key, a timeout, unreadable output). It is NOT a pass and NOT "no conflicts found" - the related decisions it returns are unchecked. STOP and ask the human rather than proceeding.
- When the user asks "why", "how does X work", or "what was decided about Y" - or you're unsure of a convention - call align_ask (or align_search) first. The answer, its status (active/conflicted), and the person who decided it are in the graph.
- Use align_get_conflicts and align_get_related_decisions to understand context and surface who to talk to.
- Prefer the graph over guessing: it reflects decisions made across Slack, Jira, GitHub, Linear and more that may not be in the code or docs.`;

/**
 * Which decision graph THIS server reads, appended to the base instructions.
 *
 * Three Align MCP servers are commonly connected at once - align-prod, align-preview, and this
 * CLI - with near-identical tool names, and none of them said which graph it answers from. An
 * agent choosing between them had no basis to choose, so it took align_ask because the
 * instructions named it first, and answered a question about the hosted product from a laptop
 * SQLite file holding four seeded demo decisions.
 *
 * Naming the source is what lets the model pick correctly, instead of the human remembering to
 * disconnect a server before every session.
 */
function graphIdentity(env: EnvironmentConfig): string {
  if (env.mode === 'local-embedded') {
    return (
      '\n\nTHIS SERVER READS THE LOCAL DECISION GRAPH stored on this machine, not a hosted Align ' +
      'tenant. It holds only what has been captured or imported locally. If another Align server ' +
      'is connected, prefer it for questions about a team or a product, and use this one for what ' +
      'is on this machine.'
    );
  }
  // Naming the host matters when prod and preview are both connected: they hold different
  // graphs and answer the same question differently.
  return `\n\nThis server reads the hosted Align graph at ${env.gatewayUrl}.`;
}

/** Server instructions for the environment actually being served. */
export function instructionsFor(env: EnvironmentConfig): string {
  return ALIGN_MCP_INSTRUCTIONS + graphIdentity(env);
}

/**
 * Tool schemas with the retrieval tools' descriptions marked with the graph they search.
 *
 * Only the two that READ the graph are rewritten. A client picks a tool by its description, and
 * capture/check tools are unambiguous - editing them would be churn that makes a future diff
 * harder to read for no gain in disambiguation.
 */
export function toolSchemasFor(env: EnvironmentConfig): typeof TOOL_SCHEMAS {
  const local = env.mode === 'local-embedded';
  const suffix = local
    ? ' Searches the LOCAL decision graph on this machine, not a hosted Align tenant.'
    : ` Searches the hosted Align graph at ${env.gatewayUrl}.`;
  return TOOL_SCHEMAS.map(tool =>
    tool.name === 'align_ask' || tool.name === 'align_search'
      ? { ...tool, description: tool.description + suffix }
      : tool,
  );
}

// Heavy internal fields that bloat the model's context without helping it reason.
// MCP responses go straight into the agent's context window, so we omit these and
// serialize compactly (no pretty-print whitespace) - see "MCP context cost".
const OMIT_RESULT_KEYS = new Set(['embedding', 'embeddings', 'vector', 'decision_json', 'raw_text']);

export function serializeMcpResult(result: unknown): string {
  return JSON.stringify(result, (key, value) => (OMIT_RESULT_KEYS.has(key) ? undefined : value));
}

// The MCP CallTool router: maps an agent's tool call to the gateway client. Exported
// and pure so the routing - argument extraction, the align_capture URL->platform
// classifier, the local-mode raw-text rule, and the unknown-tool guard - is testable
// without standing up an MCP server. Returns the raw result; the caller serializes it.
export async function dispatchTool(
  name: string,
  args: Record<string, unknown> | undefined,
  client: ReturnType<typeof createGatewayClient>,
  env: EnvironmentConfig,
): Promise<unknown> {
  // A required argument that never arrived used to reach the implementation and fail
  // from wherever the undefined landed: a missing `diff` surfaced as the tokenizer's
  // `text may not be null or undefined`, raised to the agent as JSON-RPC -32603. That
  // names nothing it passed and nothing it could pass instead. The required set is read
  // from TOOL_SCHEMAS - the same declaration tools/list hands the agent - so there is one
  // writer of what a tool needs rather than a second copy that can drift from it.
  const schema = TOOL_SCHEMAS.find((t) => t.name === name) as
    | { inputSchema?: { required?: readonly string[] } }
    | undefined;
  const missing = (schema?.inputSchema?.required ?? []).filter((key) => {
    const value = args?.[key];
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  });
  if (missing.length) {
    const names = missing.map((k) => `"${k}"`).join(' and ');
    throw new Error(
      `${name} requires ${names}. Call it again with ${missing.length > 1 ? 'those arguments' : 'that argument'} ` +
      'set to a non-empty value.',
    );
  }

  switch (name) {
    case 'align_search':
      return client.searchDecisions(args?.['query'] as string, args?.['limit'] as number | undefined);
    case 'align_ask':
      // Pass the question through unchanged so the gateway's smart-search strategy
      // selector can route it to semantic search. See ALI-105.
      return client.searchDecisions(args?.['question'] as string, (args?.['limit'] as number | undefined) ?? 8);
    case 'align_capture': {
      const input = args?.['input'] as string;
      let platform = 'cli';
      try {
        const url = new URL(input);
        platform = 'web';
        if (/slack\.com/.test(url.hostname)) platform = 'slack';
        else if (/atlassian\.net\/browse/.test(input)) platform = 'jira';
        else if (/atlassian\.net\/wiki/.test(input)) platform = 'confluence';
        else if (/github\.com/.test(url.hostname)) platform = 'github';
        else if (/linear\.app/.test(url.hostname)) platform = 'linear';
      } catch {
        if (env.mode !== 'local-embedded') {
          throw new Error('align_capture requires a URL. Raw text capture is not supported in cloud mode.');
        }
        // Local mode: accept plain text directly (platform stays 'cli').
      }
      return client.captureDecision(input, platform);
    }
    case 'align_check_alignment':
      return client.checkAlignment(args?.['diff'] as string, args?.['context'] as string | undefined);
    case 'align_check_drift':
      return client.checkDrift(args?.['decision_id'] as string, args?.['content'] as string, args?.['source_type'] as string | undefined);
    case 'align_get_impact':
      return client.getImpact(args?.['decision_id'] as string);
    case 'align_get_conflicts':
      return client.getConflicts();
    case 'align_get_related_decisions':
      return client.searchDecisions(`${args?.['file_path'] as string} ${args?.['context'] ?? ''}`, 5);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export const TOOL_SCHEMAS = [
  {
    name: 'align_search',
    description: 'Search the Align decision graph for relevant decisions, architectural choices, and past resolutions',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 10)', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'align_ask',
    description: 'Ask a natural language question and get answers from the decision graph. Use this when the user asks "how", "what was decided about", or any question about past decisions. Prefer this over align_search for natural language questions.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural language question about decisions (e.g. "do we use postgres", "how does auth work", "what was decided about caching")' },
        limit: { type: 'number', description: 'Max answers (default: 8)', default: 8 },
      },
      required: ['question'],
    },
  },
  {
    name: 'align_capture',
    description: 'Capture a decision from ANY tool - a Slack thread, Jira ticket, GitHub PR, Confluence/doc URL, or raw text. Call this whenever a decision gets made in conversation so the cross-tool decision graph stays current and relationships across tools can be detected.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'URL or text content of the decision to capture' },
      },
      required: ['input'],
    },
  },
  {
    name: 'align_check_alignment',
    description: 'BEFORE writing or changing significant code, call this with the proposed change to surface prior decisions across ALL the user\'s tools (Slack, Jira, GitHub, git) that it conflicts with or relates to. A "conflict" status means the change opposes a past decision - stop and confirm with the user before proceeding. An "unknown" status means the check could not run and is NOT a pass: the decisions it returns are unchecked, so stop and ask the human rather than treating it as clear.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'Git diff or description of proposed change' },
        context: { type: 'string', description: 'Additional context (branch name, PR title)' },
      },
      required: ['diff'],
    },
  },
  {
    name: 'align_check_drift',
    description: 'Check if code or configuration has drifted from a specific decision',
    inputSchema: {
      type: 'object',
      properties: {
        decision_id: { type: 'string', description: 'ID of the decision to check against' },
        content: { type: 'string', description: 'Code or config content to compare' },
        source_type: { type: 'string', description: 'Type of content: code, config, documentation' },
      },
      required: ['decision_id', 'content'],
    },
  },
  {
    name: 'align_get_impact',
    description: 'Get the upstream and downstream impact of a decision',
    inputSchema: {
      type: 'object',
      properties: {
        decision_id: { type: 'string', description: 'Decision ID to analyze' },
      },
      required: ['decision_id'],
    },
  },
  {
    name: 'align_get_conflicts',
    description:
      'List conflicts and contradictions in the decision graph. conflict_count is the exact total; the links list holds one page, and a message says when there are more than it shows - never present the listed links as the complete set unless they match conflict_count.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'align_get_related_decisions',
    description: 'BEFORE editing a file or module, call this to learn what was already decided about it across all the user\'s connected tools (not just code) - surfacing the cross-tool context an agent would otherwise miss.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File path or module name' },
        context: { type: 'string', description: 'Additional code context' },
      },
      required: ['file_path'],
    },
  },
];

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run Align as an MCP server for any MCP-capable agent (Claude, Cursor, VS Code, Windsurf, Zed, Codex, Gemini, ...)')
    .option('--env <env>', 'Environment')
    .option('--setup', 'Interactively configure your MCP-capable agents to use Align as an MCP server')
    .option('--install', 'Configure agents - alias for --setup')
    .option('--remove', 'Remove Align from your agents\' MCP config')
    .addHelpText('after', `
Claude Code config (~/.claude.json or workspace .mcp.json):
  {
    "mcpServers": {
      "align": { "command": "align", "args": ["mcp"] }
    }
  }
`)
    .action(async (opts: { env: EnvName; setup?: boolean; install?: boolean; remove?: boolean }) => {
      if (opts.remove) {
        await runMcpRemove();
        return;
      }
      if (opts.setup || opts.install) {
        await runMcpSetup(opts.env);
        return;
      }

      const config = createConfigStore();
      // Local mode serves every tool this server exposes, so a no-account user who ran
      // `align local start` is routed there rather than at an anonymous cloud gateway -
      // otherwise the agent's very first call 401s. A logged-in user is never redirected.
      const resolvedEnv = resolveEnv(opts.env, { preferLocalEmbedded: true });
      const env = config.getEnvironment(resolvedEnv);
      const client = createGatewayClient(env);

      const server = new Server(
        { name: 'align', version },
        { capabilities: { tools: {} }, instructions: instructionsFor(env) },
      );

      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolSchemasFor(env) }));

      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const result = await dispatchTool(name, args, client, env);
        return { content: [{ type: 'text', text: serializeMcpResult(result) }] };
      });

      // MCP protocol requires clean stdout; log startup to stderr
      process.stderr.write(`align mcp server started (env: ${resolvedEnv}, gateway: ${env.gatewayUrl})\n`);
      process.stderr.write('Want your whole team to have this context? https://align.tech/pricing\n');

      const transport = new StdioServerTransport();
      await server.connect(transport);
    });
}

/**
 * The undo for the automatic wiring setup does (ALI-776).
 *
 * Setup connects detected agents without asking, which is only defensible because the write
 * is additive and reversible. This is that reversibility, and it needs to be one command -
 * "delete the align key from each of these JSON files" is not an undo anyone will perform.
 *
 * No prompt: the user typed --remove. Asking them to confirm the thing they just asked for
 * is the ceremony this whole change is about removing.
 */
async function runMcpRemove(): Promise<void> {
  p.intro(commandIntro('align mcp --remove'));

  const editors = detectEditors();
  if (!editors.length) {
    p.log.info('No MCP agent detected on this machine, so there is nothing to remove.');
    p.outro('Done.');
    return;
  }

  let removed = 0;
  for (const target of editors) {
    try {
      if (removeMcpConfig(target)) {
        removed++;
        p.log.success(`${target.name}: align removed from ${target.configPath}`);
      } else {
        // Said explicitly rather than silently skipped: "nothing happened" and "it was never
        // there" look identical otherwise, and only one of them is reassuring.
        p.log.info(`${target.name}: no align entry, nothing to remove`);
      }
    } catch (err) {
      p.log.warn(`${target.name}: ${(err as Error).message}`);
    }
  }

  p.outro(
    removed > 0
      ? `Removed from ${removed} agent${removed === 1 ? '' : 's'}. Restart your editor. ${chalk.dim('align mcp --setup')} puts it back.`
      : 'Nothing to remove.',
  );
}

async function runMcpSetup(env?: EnvName): Promise<void> {
  p.intro(commandIntro('align mcp --setup'));

  const editors = detectEditors();
  if (!editors.length) {
    const envArgs = env && env !== 'prod' ? `, "--env", "${env}"` : '';
    p.log.warn(
      'No MCP agent detected automatically. Align works with any MCP-capable agent.\n' +
      'Add this config manually to your agent\'s MCP settings:\n\n' +
      `  { "mcpServers": { "align": { "command": "align", "args": ["mcp"${envArgs}] } } }`,
    );
    p.outro('Done.');
    return;
  }

  p.log.info(`Detected ${editors.length} agent${editors.length > 1 ? 's' : ''}:`);
  for (const e of editors) p.log.info(`  ${e.name} - ${e.configPath}`);
  console.log('');

  const selected = await p.multiselect({
    message: 'Which agents should use Align as an MCP server?',
    options: editors.map(e => ({ value: e.name, label: e.name })),
    required: true,
  });
  if (p.isCancel(selected)) { p.cancel('Cancelled.'); process.exit(0); }

  for (const name of selected as string[]) {
    const target = editors.find(e => e.name === name)!;
    const spinner = p.spinner();
    spinner.start(`Configuring ${name}...`);
    try {
      writeMcpConfig(target, env === 'prod' || !env ? undefined : env);
      spinner.stop(`${name}: align added to MCP servers`);
    } catch (err) {
      spinner.stop(`${name}: failed - ${(err as Error).message}`);
    }
  }

  const outroText = `${chalk.green('Done.\n\n')}Restart your editor, then ask:\n${chalk.dim('  "What has my team decided about authentication?"\n\n')}${chalk.dim('Want your whole team to have this context? https://align.tech/pricing')}`;
  p.outro(outroText);
}
