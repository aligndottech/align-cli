import type { Command } from 'commander';
import { findOnPath } from '../lib/launch/detect.js';
import { installText } from '../lib/launch/install.js';
import { AGENT_REGISTRY } from '../lib/launch/registry/index.js';
import type { AgentSpec } from '../lib/launch/registry/types.js';

export interface AgentsDeps {
  specs: readonly AgentSpec[];
  findOnPath(bin: string, env: Record<string, string | undefined>, platform: string): string | null;
  env: Record<string, string | undefined>;
  platform: string;
  out(line: string): void;
  err(line: string): void;
}

const CONNECTS: Record<AgentSpec['injection'], string> = {
  'per-session': 'per session',
  'written-once': 'written once',
};
/** How Align connects, as the table says it: an agent with no graph tools (Aider) says so first. */
const connectsText = (s: AgentSpec): string => (s.graph === false ? 'instructions only, no graph' : CONNECTS[s.injection]);

/**
 * `align agents`: every agent in the registry, whether it is on PATH, how Align connects, and
 * how to install it. Every column comes from the registry; the only probe is a PATH scan, so
 * no agent binary is spawned to list it.
 */
export function runAgents(opts: { json?: boolean }, d: AgentsDeps): number {
  const rows = d.specs.map((s) => {
    // The same test the launcher uses, so a generic `grok` that is not Grok Build is "no" here too.
    const found = d.findOnPath(s.bin, d.env, d.platform);
    const path = found && s.acceptsBin && !s.acceptsBin(found, d.env, d.platform) ? null : found;
    return { spec: s, path };
  });
  if (opts.json) {
    const data = rows.map(({ spec: s, path }) => ({
      id: s.name,
      label: s.label,
      bin: s.bin,
      installed: path !== null,
      path,
      supported: s.supported,
      connects: s.injection,
      graph: s.graph !== false,
      install: s.install,
      installCommand: installText(s.install),
    }));
    d.out(JSON.stringify(data, null, 2));
    return 0;
  }
  const table = [
    ['Agent', 'Installed', 'How Align connects', 'Install command'],
    ...rows.map(({ spec: s, path }) => [s.label, path ? 'yes' : 'no', connectsText(s), installText(s.install)]),
  ];
  const widths = table[0]!.map((_, i) => Math.max(...table.map((r) => r[i]!.length)));
  for (const r of table) d.out(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]! + 2))).join(''));
  return 0;
}

export function registerAgentsCommand(program: Command): void {
  program
    .command('agents')
    .option('--json', 'Print the list as JSON')
    .description('List the coding agents Align works with: installed or not, how Align connects, how to install')
    .action((opts: { json?: boolean }) => {
      const code = runAgents(opts, {
        specs: AGENT_REGISTRY,
        findOnPath,
        env: process.env,
        platform: process.platform,
        out: (l) => console.log(l),
        err: (l) => console.error(l),
      });
      if (code !== 0) process.exit(code);
    });
}
