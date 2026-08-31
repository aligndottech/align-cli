import { describe, expect, it } from 'vitest';
import { noProviderHintInline, noProviderHintLines } from '../lib/local-llm.js';

/**
 * An outside tester ran a local DeepSeek on llama.cpp in Docker, asked a question, and
 * was told to "Set ANTHROPIC_API_KEY (or OPENAI_API_KEY)". He had deliberately chosen
 * not to use a cloud provider, so that reads as "your setup is not supported" - which
 * is false, and local-llm.ts says so in its own comment about DeepSeek, OpenRouter,
 * LM Studio and vLLM users.
 *
 * The two ways to run locally are NOT the same and the difference is the whole point:
 * Ollama is probed at localhost:11434 with no configuration, while an OpenAI-compatible
 * server needs ALIGN_LLM_BASE_URL.
 */
describe('noProviderHintLines', () => {
  const text = () => noProviderHintLines().join('\n');

  it('offers a cloud key, which is the existing advice', () => {
    expect(text()).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('names ALIGN_LLM_BASE_URL, the variable the tester actually needed', () => {
    expect(text()).toContain('ALIGN_LLM_BASE_URL');
  });

  it('names the local servers by the words a user would search for', () => {
    // He said "llamacpp". If the hint only said "OpenAI-compatible endpoint" he would
    // not have connected it to what he was running.
    expect(text()).toMatch(/llama\.cpp/i);
  });

  it('says Ollama needs no configuration, because that is the non-obvious part', () => {
    // tryOllama probes http://localhost:11434 by default, so a running Ollama works
    // with nothing set. Telling someone to configure it would be wrong.
    expect(text()).toMatch(/ollama/i);
    expect(text()).toMatch(/no (config|setup)|automatic|detected/i);
  });

  it('stays short enough to read', () => {
    // This prints under a failed answer, where a wall of text is worse than nothing.
    const lines = noProviderHintLines();
    expect(lines.length).toBeLessThanOrEqual(4);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(100);
  });
});

describe('the two renderings stay in step', () => {
  // They drifted once: the block form named only cloud keys while the inline form said
  // "or run a local Ollama". Which advice a user got depended on which command they ran.
  // This is the parity guard, not a style check.
  const ROUTES = [/ANTHROPIC_API_KEY/, /ALIGN_LLM_BASE_URL/, /ollama/i];

  it('names all three routes in the block form', () => {
    const text = noProviderHintLines().join('\n');
    for (const r of ROUTES) expect(text).toMatch(r);
  });

  it('names all three routes in the inline form', () => {
    const text = noProviderHintInline('these can be classified');
    for (const r of ROUTES) expect(text).toMatch(r);
  });

  it('the inline form carries the caller purpose it was given', () => {
    // Positive control: proves the assertions above are reading a real rendering and
    // not a constant that ignores its argument.
    expect(noProviderHintInline('these can be classified')).toContain('these can be classified');
    expect(noProviderHintInline('an answer can be written')).toContain('an answer can be written');
  });
});
