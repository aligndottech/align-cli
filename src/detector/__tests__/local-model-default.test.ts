import { describe, expect, it } from 'vitest';
import { defaultDetectorForLocalModel } from '../local-model-default.js';

// v1 is the default detector, but on a LOCAL model only the ones that passed the preregistered
// rule (qwen2.5 at its default size, or 7B and above) run it. Anything else defaults to v0.
describe('the default detector for a local Ollama model', () => {
  it.each(['qwen2.5:7b', 'qwen2.5:14b', 'qwen2.5:latest', 'qwen2.5'])('%s passed the rule, so v1', (model) => {
    expect(defaultDetectorForLocalModel(model)).toBe('v1');
  });

  it.each(['qwen2.5:0.5b', 'qwen2.5:1.5b', 'qwen2.5:3b'])('%s is a small qwen that was not measured, so v0', (model) => {
    expect(defaultDetectorForLocalModel(model)).toBe('v0');
  });

  it.each(['llama3.2:latest', 'llama3.2:3b', 'llama3.2:1b'])('%s did not pass (llama3.2 found 30 of 51), so v0', (model) => {
    expect(defaultDetectorForLocalModel(model)).toBe('v0');
  });

  it('a model that was never measured defaults to v0, whatever its size', () => {
    expect(defaultDetectorForLocalModel('mistral:7b')).toBe('v0');
    expect(defaultDetectorForLocalModel('gemma2:27b')).toBe('v0');
  });

  it('no local model at all defaults to v0', () => {
    expect(defaultDetectorForLocalModel(null)).toBe('v0');
  });
});
