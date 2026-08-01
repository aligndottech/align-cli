import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The embedding weights are a compatibility contract, not a tuning knob.
 *
 * `@xenova/transformers@2` loaded **quantized** weights by default;
 * `@huggingface/transformers@3+` defaults to fp32. Measured on the same model
 * (Xenova/all-MiniLM-L6-v2) over an 8-sentence corpus, letting it default moves
 * pairwise cosine by up to 2.3e-02, where pinning `dtype: 'q8'` holds it to
 * 6.6e-04 - roughly a ninth of the smallest margin any sampled pair had to the
 * 0.45 / 0.65 gates.
 *
 * That matters because vectors are persisted in the user's local graph: a
 * default-dtype upgrade would silently leave old and new vectors in one index.
 * Nothing else in the suite would catch the pin being dropped, so it is pinned
 * here.
 */

const pipelineMock = vi.fn().mockResolvedValue(
  vi.fn().mockResolvedValue([{ data: new Float32Array(384).fill(0.1) }]),
);
vi.mock('@huggingface/transformers', () => ({ pipeline: pipelineMock }));

describe('local embedding weights', () => {
  // getEmbedding memoises the pipeline in a module-level singleton, so without a
  // module reset the second test would observe zero pipeline calls and assert
  // against nothing.
  afterEach(() => {
    vi.resetModules();
    pipelineMock.mockClear();
  });

  it('loads the quantized (q8) weights, matching the vectors already stored on disk', async () => {
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await getEmbedding('Use Postgres for production');

    expect(pipelineMock).toHaveBeenCalledWith(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      expect.objectContaining({ dtype: 'q8' }),
    );
  });

  // Second example for the same rule: the model identity is half the contract.
  // A different checkpoint would invalidate stored vectors just as surely as a
  // different dtype.
  it('loads the same model checkpoint the stored vectors came from', async () => {
    const { getEmbedding } = await import('../lib/local-embeddings.js');
    await getEmbedding('anything');

    const [task, model] = pipelineMock.mock.calls[0]!;
    expect(task).toBe('feature-extraction');
    expect(model).toBe('Xenova/all-MiniLM-L6-v2');
  });
});
