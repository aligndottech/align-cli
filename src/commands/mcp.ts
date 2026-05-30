import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
const { version } = pkg;
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { detectEditors, writeMcpConfig } from '../lib/mcp-setup.js';
import { normaliseWhyQuery } from '../lib/why-normalise.js';

// Heavy internal fields that bloat the model's context without helping it reason.
// MCP responses go straight into the agent's context window, so we omit these and
// serialize compactly (no pretty-print whitespace) - see "MCP context cost".
const OMIT_RESULT_KEYS = new Set(['embedding', 'embeddings', 'vector', 'decision_json', 'raw_text']);

export function serializeMcpResult(result: unknown): string {
  return JSON.stringify(result, (key, value) => (OMIT_RESULT_KEYS.has(key) ? undefined : value));
}

const TOOL_SCHEMAS = [
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
    description: 'BEFORE writing or changing significant code, call this with the proposed change to surface prior decisions across ALL the user\'s tools (Slack, Jira, GitHub, git) that it conflicts with or relates to. A "conflict" status means the change opposes a past decision - stop and confirm with the user before proceeding.',
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
    description: 'List all active conflicts and contradictions in the decision graph',
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
    .description('Run Align as an MCP server for Claude Code, Cursor, or Windsurf')
    .option('--env <env>', 'Environment')
    .option('--setup', 'Interactively configure editors (Claude, Cursor) to use Align as an MCP server')
    .option('--install', 'Configure editors - alias for --setup')
    .addHelpText('after', `
Claude Code config (~/.claude.json or workspace .mcp.json):
  {
    "mcpServers": {
      "align": { "command": "align", "args": ["mcp"] }
    }
  }
`)
    .action(async (opts: { env: EnvName; setup?: boolean; install?: boolean }) => {
      if (opts.setup || opts.install) {
        await runMcpSetup(opts.env);
        return;
      }

      const config = createConfigStore();
      const resolvedEnv = resolveEnv(opts.env);
      const env = config.getEnvironment(resolvedEnv);
      const client = createGatewayClient(env);

      const server = new Server(
        { name: 'align', version },
        { capabilities: { tools: {} } },
      );

      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_SCHEMAS }));

      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        let result: unknown;

        switch (name) {
          case 'align_search':
            result = await client.searchDecisions(args?.['query'] as string, args?.['limit'] as number | undefined);
            break;
          case 'align_ask':
            result = await client.searchDecisions(
              normaliseWhyQuery(args?.['question'] as string),
              (args?.['limit'] as number | undefined) ?? 8,
            );
            break;
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
              // Local mode: accept plain text directly
            }
            result = await client.captureDecision(input, platform);
            break;
          }
          case 'align_check_alignment':
            result = await client.checkAlignment(
              args?.['diff'] as string,
              args?.['context'] as string | undefined,
            );
            break;
          case 'align_check_drift':
            result = await client.checkDrift(
              args?.['decision_id'] as string,
              args?.['content'] as string,
              args?.['source_type'] as string | undefined,
            );
            break;
          case 'align_get_impact':
            result = await client.getImpact(args?.['decision_id'] as string);
            break;
          case 'align_get_conflicts':
            result = await client.getConflicts();
            break;
          case 'align_get_related_decisions':
            result = await client.searchDecisions(
              `${args?.['file_path'] as string} ${args?.['context'] ?? ''}`,
              5,
            );
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return { content: [{ type: 'text', text: serializeMcpResult(result) }] };
      });

      // MCP protocol requires clean stdout; log startup to stderr
      process.stderr.write(`align mcp server started (env: ${resolvedEnv}, gateway: ${env.gatewayUrl})\n`);
      process.stderr.write('Want your whole team to have this context? https://align.tech/pricing\n');

      const transport = new StdioServerTransport();
      await server.connect(transport);
    });
}

async function runMcpSetup(env?: EnvName): Promise<void> {
  p.intro(chalk.bgBlue.white(' align mcp --setup '));

  const editors = detectEditors();
  if (!editors.length) {
    const envArgs = env && env !== 'prod' ? `, "--env", "${env}"` : '';
    p.log.warn(
      'No editors detected automatically.\n' +
      'Add this config manually to your editor\'s MCP settings:\n\n' +
      `  { "mcpServers": { "align": { "command": "align", "args": ["mcp"${envArgs}] } } }`,
    );
    p.outro('Done.');
    return;
  }

  p.log.info(`Detected ${editors.length} editor${editors.length > 1 ? 's' : ''}:`);
  for (const e of editors) p.log.info(`  ${e.name} - ${e.configPath}`);
  console.log('');

  const selected = await p.multiselect({
    message: 'Which editors should use Align as an MCP server?',
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
