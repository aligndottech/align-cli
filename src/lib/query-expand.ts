import { queryTerms, tokenize } from './lexical-terms.js';

/**
 * Query understanding without a model (ALI-1749). Turns a question into weighted lexical terms:
 * every content word at weight 1 (scaffolding such as "why was" is dropped by `tokenize`), and a
 * quoted phrase or a backticked identifier at double weight, because the user marked it as the
 * thing they mean.
 *
 * Verb synonyms ("dropped" also searches remove/delete/retire) were built and measured on the
 * 9-repo eval, and they lowered recall@3 and MRR, so they are not here: the title rerank and the
 * dense ranking already carry the verb. Do not add them back without a harness run that beats it.
 */
export const QUOTED_WEIGHT = 2;

export function expandedTerms(query: string): Map<string, number> {
  const terms = queryTerms(query);
  for (const m of query.matchAll(/`([^`]+)`|"([^"]+)"/g)) {
    for (const t of tokenize(m[1] ?? m[2] ?? '')) terms.set(t, QUOTED_WEIGHT);
  }
  return terms;
}
