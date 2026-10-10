/**
 * L7: the CLI's mirror of the gateway's anonymous-telemetry contract. The gateway
 * (align-stack services/gateway/src/routes/telemetryAnonymousRoutes.ts, `POST /telemetry/anonymous`)
 * has a strict schema with closed lists, and a body outside it is a silent 400 that this CLI
 * swallows by design - so a stage or command the CLI sends that the gateway does not know loses
 * its events with nothing red anywhere. These two lists are two writers of one fact.
 *
 * Two halves, the same shape as mcp-instructions-parity.test.ts:
 *  - PINNED: always runs. The lists as they stood in align-stack on origin/main after #3082
 *    (e213dcdca, 2026-10-09), compared to the CLI's own exports. A CLI edit that drifts from the
 *    pin fails here and must be paired with a server change.
 *  - LIVE: reads the sibling checkout's committed file (../align-stack, or ALIGN_STACK_DIR, at
 *    ALIGN_TELEMETRY_PARITY_REF, default origin/main) and compares by parsing it. CI has no
 *    sibling checkout, so there it skips LOUDLY; the pin above is what runs in CI.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProgram } from '../cli.js';
import { FUNNEL_STAGES, SYNC_OUTCOMES, SYNC_SCOPES, SYNC_SOURCES, SYNC_TRIGGERS } from '../lib/usage-telemetry.js';

const THERE = 'services/gateway/src/routes/telemetryAnonymousRoutes.ts';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sibling = process.env['ALIGN_STACK_DIR'] ?? resolve(root, '..', 'align-stack');
const ref = process.env['ALIGN_TELEMETRY_PARITY_REF'] ?? 'origin/main';

// Pinned from THERE at e213dcdca (align-stack #3082).
const SERVER_COMMANDS = [
  'adjudicate', 'align', 'ask', 'capture', 'check', 'connect', 'context', 'decisions', 'drift',
  'env', 'export', 'import', 'invite', 'links', 'login', 'logout', 'mark', 'mcp', 'push', 'ratify',
  'search', 'setup', 'share', 'spaces', 'status', 'sync', 'telemetry', 'use', 'whoami',
];
const SERVER_STAGES = [
  'install', 'setup_started', 'setup_completed', 'import_completed', 'mcp_wired',
  'first_useful_decision', 'teammate_requested', 'agent_launched',
  'sessions_scanned', 'candidates_found', 'candidates_confirmed', 'decisions_ratified',
  'source_synced',
];
const SERVER_SOURCES = ['git', 'docs', 'github', 'jira', 'confluence', 'slack', 'teams', 'zoom', 'gitlab', 'linear', 'notion'];
const SERVER_OUTCOMES = ['ok', 'partial', 'needs_reauth', 'error'];
const SERVER_SCOPES = ['yours', 'team'];
const SERVER_TRIGGERS = ['connect', 'background', 'manual'];

/** The commands the CLI registers that the gateway deliberately leaves out: `dev` and `connector` are internal (ALIGN_INTERNAL=1), `local` never pings. */
const NOT_SENT = new Set(['local', 'dev', 'connector']);

/**
 * Found by this test on its first run (2026-10-10): `ai` and `agents` are registered here and are
 * not on the gateway's list, so their `cli.command` pings 400 silently today. Not fixed by L7 (the
 * fix is a gateway change, outside this slice). Listed exactly, so the day the gateway adds them
 * this test fails until they are removed from here: it can only shrink.
 */
const KNOWN_DRIFT = ['agents', 'ai'];

const cliCommands = (): string[] => buildProgram({ internal: false }).commands.map((c) => c.name());
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe('the CLI mirror of the gateway telemetry contract (pinned)', () => {
  it('every funnel stage the CLI can send, plus the install beacon, is exactly the gateway\'s list', () => {
    expect(sorted([...FUNNEL_STAGES, 'install'])).toEqual(sorted(SERVER_STAGES));
  });
  it('the sync enums: sources, outcomes and scopes equal the gateway\'s; triggers are a subset of its list', () => {
    expect(sorted(SYNC_SOURCES)).toEqual(sorted(SERVER_SOURCES));
    expect(sorted(SYNC_OUTCOMES)).toEqual(sorted(SERVER_OUTCOMES));
    expect(sorted(SYNC_SCOPES)).toEqual(sorted(SERVER_SCOPES));
    for (const t of SYNC_TRIGGERS) expect(SERVER_TRIGGERS).toContain(t);
  });
  it('every command the CLI registers is on the gateway\'s list, bar the three it leaves out on purpose', () => {
    const names = cliCommands();
    expect(names.length).toBeGreaterThan(10); // positive control: the tree was actually read
    const missing = names.filter((n) => !NOT_SENT.has(n) && !SERVER_COMMANDS.includes(n));
    expect(sorted(missing)).toEqual(KNOWN_DRIFT);
  });
  it('sync and mark are on the list (the pings this slice sends)', () => {
    expect(SERVER_COMMANDS).toContain('sync');
    expect(SERVER_COMMANDS).toContain('mark');
  });
});

/** The quoted strings of `const NAME = [ ... ]`, with `...OTHER` spreads resolved from the same file. */
function listOf(src: string, name: string): string[] {
  const m = new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(src);
  if (!m) throw new Error(`${THERE} has no "const ${name} = [...] as const" - the parse is stale, not the lists equal`);
  const out: string[] = [];
  for (const part of m[1]!.split(',')) {
    const t = part.replace(/\/\/.*$/gm, '').trim();
    const spread = /^\.\.\.(\w+)$/.exec(t);
    if (spread) out.push(...listOf(src, spread[1]!));
    else for (const q of t.matchAll(/'([^']+)'/g)) out.push(q[1]!);
  }
  return out;
}

function live(): { ok: true; src: string } | { ok: false; why: string } {
  if (!existsSync(join(sibling, '.git'))) return { ok: false, why: `no align-stack checkout at ${sibling} (set ALIGN_STACK_DIR)` };
  try {
    const src = execFileSync('git', ['-C', sibling, 'show', `${ref}:${THERE}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, src };
  } catch (err) {
    return { ok: false, why: `${THERE} is not on ${ref} of ${sibling} (${(err as Error).message.split('\n')[0]})` };
  }
}
const other = live();
if (!other.ok) console.warn(`\n[telemetry-server-parity] LIVE half SKIPPED: ${other.why}\n`);

describe.skipIf(!other.ok)(`the CLI mirror against ${THERE} on ${ref} (live)`, () => {
  const src = (other as { src: string }).src;
  it('the parse reads real lists (positive control), and the pin above is what the file says', () => {
    expect(listOf(src, 'KNOWN_COMMANDS')).toContain('ask');
    expect(sorted(listOf(src, 'KNOWN_COMMANDS'))).toEqual(sorted(SERVER_COMMANDS));
    expect(sorted(listOf(src, 'FUNNEL_STAGES'))).toEqual(sorted(SERVER_STAGES));
    expect(sorted(listOf(src, 'SOURCE_VALUES'))).toEqual(sorted(SERVER_SOURCES));
    expect(sorted(listOf(src, 'SYNC_OUTCOME_VALUES'))).toEqual(sorted(SERVER_OUTCOMES));
    expect(sorted(listOf(src, 'SCOPE_VALUES'))).toEqual(sorted(SERVER_SCOPES));
    expect(sorted(listOf(src, 'SYNC_TRIGGER_VALUES'))).toEqual(sorted(SERVER_TRIGGERS));
  });
  it('every stage, enum value and registered command the CLI can send is accepted by the live file', () => {
    expect(sorted(listOf(src, 'FUNNEL_STAGES'))).toEqual(sorted([...FUNNEL_STAGES, 'install']));
    for (const t of SYNC_TRIGGERS) expect(listOf(src, 'SYNC_TRIGGER_VALUES')).toContain(t);
    const known = listOf(src, 'KNOWN_COMMANDS');
    expect(sorted(cliCommands().filter((n) => !NOT_SENT.has(n) && !known.includes(n)))).toEqual(KNOWN_DRIFT);
  });
});
