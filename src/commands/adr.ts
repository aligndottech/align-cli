/**
 * `align adr`: list the decisions in this repo's graph that read as decisions and have no ADR yet.
 * `align adr write`: go through them at a terminal and write an ADR for each one a person accepts.
 *
 * Without a person at a terminal nothing is written, and an existing file is never replaced.
 */
import type { Command } from 'commander';
import readline from 'node:readline/promises';
import { createConfigStore } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { getRepoRoot } from '../lib/git.js';
import { decisionShapedRows, LOCAL_SCAN } from '../lib/context-from-graph.js';
import { adrCandidates, adrDirFor, type AdrRow, rowsOfThisRepo, writeAdr } from '../lib/adr-writer.js';
import type { EnvName } from '../lib/config.js';

export interface AdrDeps {
  interactive: boolean;
  write: boolean;
  today: string;
  ask(question: string): Promise<string>;
  out(line: string): void;
}

export async function runAdr(rows: AdrRow[], repoRoot: string, d: AdrDeps): Promise<string[]> {
  const candidates = adrCandidates(decisionShapedRows(rows as never) as AdrRow[], repoRoot);
  const dir = adrDirFor(repoRoot);
  if (candidates.length === 0) { d.out(`Every decision in this repo's graph already has an ADR in ${dir}.`); return []; }
  if (!d.write || !d.interactive) {
    d.out(`${candidates.length} decision(s) with no ADR in ${dir}:`);
    for (const c of candidates) d.out(`  - ${c.title}${c.sourceUrl ? `  (${c.sourceUrl})` : ''}`);
    d.out(d.write ? 'Not at a terminal, so nothing was written. Run `align adr write` yourself to accept them one by one.'
      : 'Run `align adr write` to go through them and write an ADR for each one you accept.');
    return [];
  }
  const written: string[] = [];
  for (const [i, c] of candidates.entries()) {
    d.out(`\n[${i + 1}/${candidates.length}] ${c.title}${c.sourceUrl ? `\n  ${c.sourceUrl}` : ''}${c.reason ? `\n  Why: ${c.reason}` : ''}`);
    const a = (await d.ask('Write an ADR for this? [y/N/q] ')).trim().toLowerCase();
    if (a === 'q') break;
    if (a !== 'y' && a !== 'yes') continue;
    const file = writeAdr(repoRoot, c, d.today);
    written.push(file);
    d.out(`  wrote ${file}`);
  }
  d.out(`\n${written.length} ADR(s) written. Review and commit them like any other change.`);
  return written;
}

export function registerAdrCommand(program: Command): void {
  program
    .command('adr')
    .description("List decisions in this repo's graph that have no ADR yet; `adr write` drafts one for each you accept")
    .argument('[action]', '"write" to go through them and write the ones you accept')
    .option('--env <env>', 'Environment')
    .action(async (action: string | undefined, opts: { env?: EnvName }) => {
      if (action && action !== 'write') { console.error(`align adr: unknown action "${action}". Use \`align adr\` or \`align adr write\`.`); process.exitCode = 2; return; }
      const root = await getRepoRoot();
      if (!root) { console.error('align adr: run this inside a git repo.'); process.exitCode = 1; return; }
      const env = createConfigStore().getEnvironment(resolveEnv(opts.env, { preferLocalEmbedded: true }));
      const fetched = (await createGatewayClient(env).listDecisions({ limit: LOCAL_SCAN, status: 'active' })) as AdrRow[];
      // A cloud tenant holds every repo's decisions and listDecisions has no repo filter there, so narrow to this repo.
      const rows = rowsOfThisRepo(fetched, root);
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
      try {
        await runAdr(rows, root, {
          interactive, write: action === 'write', today: new Date().toISOString().slice(0, 10),
          ask: (q) => (rl ? rl.question(q) : Promise.resolve('n')), out: (l) => console.log(l),
        });
      } finally { rl?.close(); }
    });
}
