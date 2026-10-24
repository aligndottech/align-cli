import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_FILES, MODEL_REPO } from '../lib/embedding-assets.js';
import { EMBEDDING_DTYPE, EMBEDDING_MODEL_ID } from '../lib/local-embeddings.js';

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
 * different weights file would silently leave old and new vectors in one index.
 * Now the pin is the FILE we download and load (there is no transformers.js
 * `dtype` option any more), so it is pinned here at both ends.
 */
describe('local embedding weights', () => {
  it('downloads the quantized (q8) weights and not an fp32 or fp16 file', () => {
    const onnx = MODEL_FILES.filter((f) => f.path.endsWith('.onnx')).map((f) => f.path);
    expect(EMBEDDING_DTYPE).toBe('q8');
    expect(onnx).toEqual(['onnx/model_quantized.onnx']);
  });

  // Second example for the same rule: the model identity is half the contract.
  // A different checkpoint would invalidate stored vectors just as surely as a
  // different dtype.
  it('fetches the same model checkpoint the stored vectors came from', () => {
    expect(EMBEDDING_MODEL_ID).toBe('Xenova/all-MiniLM-L6-v2');
    expect(MODEL_REPO).toBe(EMBEDDING_MODEL_ID);
  });

  describe('the loader opens exactly that file', () => {
    const create = vi.hoisted(() => vi.fn());
    afterEach(() => { vi.resetModules(); vi.doUnmock('../lib/embedding-runtime.js'); create.mockReset(); });

    it('creates the ONNX session from model_quantized.onnx, with the CPU provider', async () => {
      const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const model = mkdtempSync(join(tmpdir(), 'dtype-'));
      mkdirSync(join(model, 'onnx'));
      writeFileSync(join(model, 'tokenizer_config.json'), '{}');
      writeFileSync(join(model, 'tokenizer.json'), JSON.stringify({ version: '1.0', model: { type: 'WordPiece', vocab: { '[UNK]': 0 }, unk_token: '[UNK]' } }));
      create.mockResolvedValue({ inputNames: [], outputNames: [], run: vi.fn() });
      vi.doMock('../lib/embedding-runtime.js', () => ({
        ensureRuntime: async () => '/rt',
        ensureModel: async () => model,
        loadOrt: () => ({ InferenceSession: { create }, Tensor: class {} }),
      }));
      vi.doMock('@huggingface/tokenizers', () => ({ Tokenizer: class { encode() { return { ids: [], attention_mask: [] }; } } }));
      const { createNativeEmbeddingPipeline } = await import('../lib/local-embeddings-native.js');
      await createNativeEmbeddingPipeline({ allowDownload: true });
      expect(create).toHaveBeenCalledWith(join(model, 'onnx', 'model_quantized.onnx'), { executionProviders: ['cpu'] });
    });
  });
});
