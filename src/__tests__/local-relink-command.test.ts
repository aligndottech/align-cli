// P3 + review F3: `align local relink` shows an estimate first, a dry run calls no model unless
// --classify is passed, a default call cap applies, a TTY asks, and a wrapped or terminal-less run
// refuses unless --yes AND --max-calls are given. Every dependency is injected; nothing real runs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RELINK_MAX_CALLS, type RelinkCommandDeps, type RelinkCommandOptions, runRelinkCommand } from '../commands/local-relink.js';
import { costEstimate } from '../lib/relink-estimate.js';
import type { RelinkPlan, RelinkReport } from '../lib/local-relink.js';

const plan = (calls: number): RelinkPlan => ({ groups: [], decision: () => undefined, calls, pairs: calls * 2, skippedJudged: 1, inputTokens: calls * 1000, maxOutputTokens: calls * 2048 });
const report: RelinkReport = { calls: 1, remainingCalls: 0, proposed: [{ sourceId: 'n', targetId: 'a', from: ['conflicts_with'], to: 'refines' }], written: [], unchanged: 1, omitted: 2, skippedJudged: 1, keptSupersedes: 0, failed: 0 };

let out: string[];
let err: string[];
let deps: RelinkCommandDeps;
beforeEach(() => {
  out = []; err = [];
  deps = {
    dbPath: () => '/nonexistent/test.db',
    plan: vi.fn(() => plan(3)),
    relink: vi.fn(async () => report),
    hasProvider: () => true,
    provider: () => 'anthropic',
    isTty: () => true,
    wrapped: () => false,
    confirm: vi.fn(async () => true),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  };
});
const run = (opts: Partial<RelinkCommandOptions>) => runRelinkCommand({ detector: 'v1', ...opts }, deps);
const text = () => out.join('\n');

describe('refusals', () => {
  it('--detector v0 is refused with exit 2; nothing planned', async () => {
    expect(await run({ detector: 'v0' })).toBe(2);
    expect(deps.plan).not.toHaveBeenCalled();
  });
  it('--replace without --apply, --classify without --dry-run, and --dry-run with --apply are refused', async () => {
    expect(await run({ replace: true })).toBe(2);
    expect(await run({ classify: true })).toBe(2);
    expect(await run({ dryRun: true, apply: true })).toBe(2);
    expect(await run({ apply: true, maxCalls: 0 })).toBe(2);
    expect(deps.relink).not.toHaveBeenCalled();
  });
});

describe('the estimate comes first and a plain dry run is free', () => {
  it('no flags: prints calls, tokens and cost, calls no model', async () => {
    expect(await run({})).toBe(0);
    expect(text()).toMatch(/3 model call\(s\) for 6 pair\(s\)/);
    expect(text()).toMatch(/1 pair\(s\) skipped: a person judged them/);
    expect(text()).toMatch(/\$0\.0[0-9]+/);
    expect(text()).toMatch(/no model was called/i);
    expect(deps.relink).not.toHaveBeenCalled();
  });
  it('--dry-run alone is the same free dry run', async () => {
    expect(await run({ dryRun: true })).toBe(0);
    expect(deps.relink).not.toHaveBeenCalled();
  });
  it('--dry-run --classify asks, then classifies without writing', async () => {
    expect(await run({ dryRun: true, classify: true })).toBe(0);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.relink).toHaveBeenCalledWith('/nonexistent/test.db', { apply: false, replace: false, maxCalls: DEFAULT_RELINK_MAX_CALLS });
    expect(text()).toContain('would change: n -> a: conflicts_with -> refines');
  });
  it('nothing pending: says so and calls nothing', async () => {
    deps.plan = vi.fn(() => plan(0));
    expect(await run({ apply: true })).toBe(0);
    expect(deps.relink).not.toHaveBeenCalled();
  });
});

describe('the cap and the confirmation', () => {
  it('--apply at a TTY asks first; a no means nothing is sent', async () => {
    deps.confirm = vi.fn(async () => false);
    expect(await run({ apply: true })).toBe(0);
    expect(deps.relink).not.toHaveBeenCalled();
    expect(text()).toMatch(/Cancelled/);
  });
  it('the default cap is 50 calls and is named when the plan is larger; --max-calls raises it', async () => {
    deps.plan = vi.fn(() => plan(120));
    await run({ apply: true });
    expect(vi.mocked(deps.relink).mock.calls[0]![1]).toMatchObject({ maxCalls: 50 });
    expect(text()).toMatch(/stops after 50 of 120 calls/);
    await run({ apply: true, maxCalls: 200 });
    expect(vi.mocked(deps.relink).mock.calls[1]![1]).toMatchObject({ maxCalls: 200 });
  });
  it('no terminal: refused unless --yes AND --max-calls', async () => {
    deps.isTty = () => false;
    expect(await run({ apply: true })).toBe(1);
    expect(await run({ apply: true, yes: true })).toBe(1);
    expect(await run({ apply: true, maxCalls: 5 })).toBe(1);
    expect(deps.relink).not.toHaveBeenCalled();
    expect(await run({ apply: true, yes: true, maxCalls: 5 })).toBe(0);
    expect(deps.relink).toHaveBeenCalledTimes(1);
  });
  it('inside an agent (ALIGN_WRAPPED) at a TTY: the same refusal', async () => {
    deps.wrapped = () => true;
    expect(await run({ apply: true, yes: true })).toBe(1);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(await run({ apply: true, yes: true, maxCalls: 5 })).toBe(0);
  });
  it('with no AI provider, a spending run refuses; a free dry run still works', async () => {
    deps.hasProvider = () => false;
    expect(await run({ apply: true })).toBe(1);
    expect(await run({})).toBe(0);
    expect(deps.relink).not.toHaveBeenCalled();
  });
});

describe('the report prints only what was written', () => {
  it('--apply lists the written rows, not the proposals', async () => {
    deps.relink = vi.fn(async () => ({ ...report, written: [{ sourceId: 'n', targetId: 'b', from: ['relates'], to: 'refines' }] }));
    await run({ apply: true });
    expect(text()).toContain('wrote: n -> b: relates -> refines');
    expect(text()).not.toContain('n -> a');
  });
});

describe('costEstimate', () => {
  it('prices the provider default model per million tokens (input plus the output ceiling)', () => {
    expect(costEstimate(1_000_000, 0, 'anthropic', {})).toMatchObject({ usd: 1, model: 'claude-haiku-4-5-20251001' });
    expect(costEstimate(0, 1_000_000, 'openai', {})).toMatchObject({ usd: 0.6, model: 'gpt-4o-mini' });
  });
  it('Ollama and unpriced providers say unknown price, never a number', () => {
    expect(costEstimate(1000, 1000, 'ollama', {})).toMatchObject({ usd: null, note: expect.stringMatching(/locally/) });
    expect(costEstimate(1000, 1000, 'groq', {})).toMatchObject({ usd: null });
    expect(costEstimate(1000, 1000, undefined, {})).toMatchObject({ usd: null });
  });
});

describe('costEstimate with a model override', () => {
  it('a provider whose model env var is set is unknown price, because the default price may not apply', () => {
    expect(costEstimate(1000, 1000, 'anthropic', { ALIGN_ANTHROPIC_MODEL: 'claude-opus-4-1' })).toMatchObject({ usd: null });
    expect(costEstimate(1000, 1000, 'anthropic', { ALIGN_ANTHROPIC_MODEL: '' })).toMatchObject({ usd: expect.any(Number) });
  });
});
