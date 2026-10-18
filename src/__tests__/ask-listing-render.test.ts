/**
 * ALI-1780: the no-answer list of `align ask` is scannable, deterministic and honest.
 * Display only: --json and the synthesis path must not move.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import type * as LocalLlm from '../lib/local-llm.js';
import type * as NodeFs from 'node:fs';

vi.mock('ora', () => ({ default: () => ({ start() { return this; }, stop: vi.fn(), fail: vi.fn() }) }));
vi.mock('node:fs', async (importActual) => ({ ...(await importActual<typeof NodeFs>()), existsSync: vi.fn().mockReturnValue(false) }));

const envMode = vi.hoisted(() => ({ mode: 'local-embedded' as string }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ mode: envMode.mode })),
    getConnectorFields: vi.fn(() => null),
    isAskKeyOfferDismissed: () => true,
  })),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('local') }));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage: vi.fn() }));
vi.mock('../lib/git.js', () => ({
  getGitIdentities: async () => ({ email: null, name: null }),
  hasOtherCommitters: async () => false,
}));

const synthesiseDetailed = vi.hoisted(() => vi.fn());
vi.mock('../lib/local-llm.js', async (importActual) => ({
  ...(await importActual<typeof LocalLlm>()),
  synthesiseDetailed,
}));

const searchDecisions = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({
  createGatewayClient: vi.fn(() => ({ searchDecisions, listDecisions: vi.fn().mockResolvedValue([]) })),
}));

import { registerAskCommand } from '../commands/why.js';

const output: string[] = [];
async function ask(...extra: string[]) {
  output.length = 0;
  const program = new Command();
  registerAskCommand(program);
  await program.parseAsync(['node', 'align', 'ask', 'why postgres', ...extra]);
  return output.join('\n');
}
const setTTY = (v: boolean) => {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true });
};
const NO_PROVIDER = { ok: false, failure: { kind: 'no_provider' } };

const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
const longBody = Array.from({ length: 40 }, (_, i) => `row${i} ${WORDS}`).join('\n');
const hit = (n: number, sim: number, summary: string) => ({
  id: `id-${n}`, title: `Decision ${n}`, summary, platform: 'git', similarity: sim,
  source_url: null, decided_at: '2026-01-02T00:00:00Z',
});
const respond = (results: ReturnType<typeof hit>[]) =>
  searchDecisions.mockResolvedValue({ results, count: results.length, strategy: 'semantic', scope: null });

beforeEach(() => {
  clearTelemetryEnv();
  envMode.mode = 'local-embedded';
  synthesiseDetailed.mockReset();
  synthesiseDetailed.mockResolvedValue(NO_PROVIDER);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { output.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { output.push(String(s)); return true; }) as never);
});
afterEach(() => { vi.restoreAllMocks(); setTTY(false); });

describe('excerpt per match', () => {
  it('shows a short word-boundary excerpt with an ellipsis, not the 40-line body', async () => {
    respond([hit(1, 0.6, longBody)]);
    const out = await ask();
    expect(out).toContain('row0 alpha bravo');
    expect(out).not.toContain('row39');
    expect(out).toMatch(/\.\.\."/);
    expect(out.split('\n').length).toBeLessThan(30);
  });
  it('does not repeat the title inside the excerpt', async () => {
    respond([hit(1, 0.6, 'Decision 1 the actual body')]);
    const out = await ask();
    expect(out).toContain('"the actual body"');
  });
  it('leaves a short body whole, no ellipsis', async () => {
    respond([hit(1, 0.6, 'kept whole, two words more')]);
    const out = await ask();
    expect(out).toContain('"kept whole, two words more"');
    expect(out).not.toContain('...');
  });
});

describe('display cap', () => {
  it('prints 3 matches with no cap line', async () => {
    respond([1, 2, 3].map((n) => hit(n, 0.6, `s${n}`)));
    const out = await ask();
    expect(out).toContain('Decision 3');
    expect(out).not.toMatch(/and \d+ more/);
  });
  it('prints 5 of 30 and says how to see the rest', async () => {
    respond(Array.from({ length: 30 }, (_, n) => hit(n + 1, 0.6, `s${n}`)));
    const out = await ask();
    expect(out).toContain('Decision 5');
    expect(out).not.toContain('Decision 6\n');
    expect(out).toContain('... and 25 more (use --limit 30)');
  });
  it('an explicit --limit shows every match returned', async () => {
    respond(Array.from({ length: 7 }, (_, n) => hit(n + 1, 0.6, `s${n}`)));
    const out = await ask('--limit', '7');
    expect(out).toContain('Decision 7');
    expect(out).not.toMatch(/and \d+ more/);
  });
});

describe('weak matches', () => {
  it('says weak when every score is below the floor, and still lists them', async () => {
    respond([hit(1, 0.42, 'a'), hit(2, 0.26, 'b')]);
    const out = await ask();
    expect(out).toContain('weak matches');
    expect(out).toContain('Decision 1');
    expect(out).toContain('(26% weak match)');
  });
  it('does not call a set weak when one match clears the floor, and marks only the low one', async () => {
    respond([hit(1, 0.62, 'a'), hit(2, 0.27, 'b')]);
    const out = await ask();
    expect(out).not.toContain('weak matches');
    expect(out).toContain('(62% match)');
    expect(out).toContain('(27% weak match)');
  });
  it('marks nothing weak outside local mode, where scores are on another scale', async () => {
    envMode.mode = 'auth';
    respond([hit(1, 0.3, 'a')]);
    const out = await ask();
    expect(out).not.toContain('weak');
    expect(out).toContain('(30% match)');
  });
});

describe('summary line and guidance order', () => {
  const NOAI = 'no AI model is set up, so no answer was written';
  beforeEach(() => respond([hit(1, 0.6, 'a'), hit(2, 0.7, 'b')]));
  it('non-TTY: one-line summary first, guidance after the list', async () => {
    setTTY(false);
    const out = await ask();
    const lines = out.split('\n').filter((l) => l.trim());
    expect(lines[0]).toContain(`2 related decisions`);
    expect(lines[0]).toContain(NOAI);
    expect(out.indexOf('Decision 2')).toBeLessThan(out.indexOf('Any one of these works'));
  });
  it('TTY: guidance above the list', async () => {
    setTTY(true);
    const out = await ask();
    expect(out.indexOf('Any one of these works')).toBeLessThan(out.indexOf('Decision 1'));
    expect(out).toContain(NOAI);
  });
  it('singular noun for one match', async () => {
    respond([hit(1, 0.6, 'a')]);
    expect(await ask()).toContain('1 related decision, ');
  });
});

describe('synthesis path unchanged', () => {
  it('prints the answer and Sources, no list header or excerpt, when a provider answers', async () => {
    respond([hit(1, 0.3, longBody)]);
    synthesiseDetailed.mockResolvedValue({ ok: true, text: 'We chose Postgres.' });
    const out = await ask();
    expect(out).toContain('We chose Postgres.');
    expect(out).toContain('Sources:');
    expect(out).not.toContain('related decision');
    expect(out).not.toContain('weak');
  });
});

describe('--json is untouched', () => {
  it('is byte-identical to the pre-change output for the same input', async () => {
    respond([hit(1, 0.42, longBody), hit(2, 0.9, 'b')]);
    const out = await ask('--json');
    // Golden captured from origin/main (28c97cd) before the renderer change.
    expect(out).toBe(readFileSync(new URL('./fixtures/ask-json-golden-main.json', import.meta.url), 'utf8'));
  });
});

