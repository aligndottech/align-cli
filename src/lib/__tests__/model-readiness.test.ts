import { describe, expect, it } from 'vitest';
import { modelReadinessLines } from '../model-readiness.js';

// The wizard used to finish without saying that conflict checks need an AI model. With no key and no Ollama,
// every check came back "could not check", and first-run users found out from their agent. One line, only
// when it is true, naming the two ways to fix it.
describe('modelReadinessLines', () => {
  it('a configured provider needs no notice, and Ollama is not even probed', async () => {
    let probed = false;
    const lines = await modelReadinessLines({ hasProvider: () => true, probeOllama: async () => { probed = true; return null; } });
    expect(lines).toBeNull();
    expect(probed).toBe(false);
  });

  it('no provider but a running Ollama with a usable model needs no notice', async () => {
    expect(await modelReadinessLines({ hasProvider: () => false, probeOllama: async () => 'qwen2.5:7b' })).toBeNull();
  });

  it('no provider and no Ollama model says checks will not run, and names a key and an Ollama pull', async () => {
    const lines = await modelReadinessLines({ hasProvider: () => false, probeOllama: async () => null });
    const text = (lines ?? []).join('\n');
    expect(text).toMatch(/conflict checks/i);
    expect(text).toMatch(/not run|could not check/i);
    expect(text).toMatch(/ANTHROPIC_API_KEY/);
    expect(text).toMatch(/ollama pull qwen2\.5:7b/);
  });

  it('a probe that throws counts as no Ollama, not a crash', async () => {
    const lines = await modelReadinessLines({ hasProvider: () => false, probeOllama: async () => { throw new Error('refused'); } });
    expect(lines).not.toBeNull();
  });
});
