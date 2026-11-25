import { describe, expect, it } from 'vitest';
import { PROVIDER_RESOLUTION_ENV_VARS } from '../lib/llm-providers.js';

// Reads process.env as it stands when the file starts, after the setup file ran. A key exported in the
// developer's shell must not be visible here: tests that see one make real paid provider calls.
describe('provider environment is hermetic', () => {
  it('lists the variables the resolver reads (positive control: the check has something to check)', () => {
    expect(PROVIDER_RESOLUTION_ENV_VARS).toEqual(expect.arrayContaining([
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
      'OPENROUTER_API_KEY', 'ALIGN_LLM_BASE_URL', 'ALIGN_LLM_API_KEY', 'OLLAMA_HOST',
    ]));
  });

  it('exposes no provider variable at the start of a test file', () => {
    const visible = PROVIDER_RESOLUTION_ENV_VARS.filter((n) => process.env[n] !== undefined);
    expect(visible).toEqual([]);
  });
});
