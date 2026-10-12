import { describe, expect, it, vi } from 'vitest';
import { type ModelStepDeps, modelStepOptions, noModelLines, runModelStep } from '../model-step.js';

// The wizard used to finish silently with no AI model, and every conflict check then said "could not check".
// This step asks once, at setup, only when it is true, and offers what is actually available on this machine.
const base = (over: Partial<ModelStepDeps> = {}): ModelStepDeps => ({
  hasProvider: () => false,
  ollamaModel: async () => null,
  unusedExported: () => [],
  select: vi.fn(async () => 'skip'),
  pasteKey: vi.fn(async () => null),
  freeGroq: vi.fn(async () => false),
  setPreference: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn() },
  ...over,
});

describe('modelStepOptions', () => {
  it('always offers a key, a free Groq key, a local model and skip', () => {
    expect(modelStepOptions([]).map((o) => o.value)).toEqual(['key', 'groq', 'ollama', 'skip']);
  });

  it('puts a key already exported in the shell first, one entry per key, named by its variable', () => {
    const opts = modelStepOptions([{ id: 'deepseek', envVar: 'DEEPSEEK_API_KEY' }, { id: 'zai', envVar: 'ZAI_API_KEY' }]);
    expect(opts.map((o) => o.value)).toEqual(['env:deepseek', 'env:zai', 'key', 'groq', 'ollama', 'skip']);
    expect(opts[0]!.label).toMatch(/DeepSeek/);
    expect(opts[0]!.hint).toMatch(/DEEPSEEK_API_KEY/);
  });
});

describe('runModelStep', () => {
  it('a configured provider: nothing asked, nothing said', async () => {
    const d = base({ hasProvider: () => true });
    expect(await runModelStep({ interactive: true }, d)).toBe('ready');
    expect(d.select).not.toHaveBeenCalled();
    expect(d.log.warn).not.toHaveBeenCalled();
  });

  it('a running Ollama model counts as a model: nothing asked', async () => {
    const d = base({ ollamaModel: async () => 'qwen2.5:7b' });
    expect(await runModelStep({ interactive: true }, d)).toBe('ready');
    expect(d.select).not.toHaveBeenCalled();
  });

  it('a throwing Ollama probe is the same as no Ollama', async () => {
    const d = base({ ollamaModel: async () => { throw new Error('refused'); } });
    expect(await runModelStep({ interactive: true }, d)).toBe('skipped');
    expect(d.select).toHaveBeenCalledTimes(1);
  });

  it('no terminal: no prompt, the warning says what stops working and how to fix it', async () => {
    const d = base();
    expect(await runModelStep({ interactive: false }, d)).toBe('skipped');
    expect(d.select).not.toHaveBeenCalled();
    expect(vi.mocked(d.log.warn).mock.calls[0]![0]).toMatch(/conflict checks/i);
  });

  it('choosing a key exported in the shell saves only the CHOICE, so the key stays in the shell', async () => {
    const d = base({ unusedExported: () => [{ id: 'deepseek', envVar: 'DEEPSEEK_API_KEY' }], select: vi.fn(async () => 'env:deepseek') });
    expect(await runModelStep({ interactive: true }, d)).toBe('configured');
    expect(d.setPreference).toHaveBeenCalledWith({ provider: 'deepseek' });
    expect(d.pasteKey).not.toHaveBeenCalled();
  });

  it('a second exported key picks that key, not the first (two examples)', async () => {
    const d = base({
      unusedExported: () => [{ id: 'deepseek', envVar: 'DEEPSEEK_API_KEY' }, { id: 'zai', envVar: 'ZAI_API_KEY' }],
      select: vi.fn(async () => 'env:zai'),
    });
    await runModelStep({ interactive: true }, d);
    expect(d.setPreference).toHaveBeenCalledWith({ provider: 'zai' });
  });

  it('"a key I have" runs the paste flow, and counts only when a key was saved', async () => {
    const saved = base({ select: vi.fn(async () => 'key'), pasteKey: vi.fn(async () => 'anthropic') });
    expect(await runModelStep({ interactive: true }, saved)).toBe('configured');
    const backedOut = base({ select: vi.fn(async () => 'key'), pasteKey: vi.fn(async () => null) });
    expect(await runModelStep({ interactive: true }, backedOut)).toBe('skipped');
    expect(vi.mocked(backedOut.log.warn)).toHaveBeenCalled();
  });

  it('the free Groq path is configured only when it saved a key', async () => {
    expect(await runModelStep({ interactive: true }, base({ select: vi.fn(async () => 'groq'), freeGroq: vi.fn(async () => true) }))).toBe('configured');
    expect(await runModelStep({ interactive: true }, base({ select: vi.fn(async () => 'groq'), freeGroq: vi.fn(async () => false) }))).toBe('skipped');
  });

  it('local model: shows the pull command, saves nothing, and still warns that checks wait for it', async () => {
    const d = base({ select: vi.fn(async () => 'ollama') });
    expect(await runModelStep({ interactive: true }, d)).toBe('skipped');
    expect(vi.mocked(d.log.info).mock.calls.flat().join('\n')).toMatch(/ollama pull qwen2\.5:7b/);
    expect(d.setPreference).not.toHaveBeenCalled();
  });

  it('skip and cancel (null) both leave the warning, saved nothing', async () => {
    for (const answer of ['skip', null] as const) {
      const d = base({ select: vi.fn(async () => answer) });
      expect(await runModelStep({ interactive: true }, d)).toBe('skipped');
      expect(d.log.warn).toHaveBeenCalled();
      expect(d.setPreference).not.toHaveBeenCalled();
    }
  });
});

describe('noModelLines', () => {
  it('leads with the free local model, then keys, then how to change it later', () => {
    const text = noModelLines().join('\n');
    expect(text.indexOf('ollama pull qwen2.5:7b')).toBeGreaterThan(-1);
    expect(text.indexOf('ollama pull')).toBeLessThan(text.search(/API_KEY/));
    expect(text).toMatch(/align ai/);
  });
});
