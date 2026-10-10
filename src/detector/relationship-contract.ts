/**
 * The relationship contract, TypeScript half: the data in relationship-contract.v1.json plus the
 * parser for one model answer and the check that the lists in the file agree with each other.
 *
 * Pure: no I/O, no network, no model call. This file is vendored byte for byte into align-stack's
 * packages/llm-eval and pinned there by relationship-contract.lock (the brain keeps a Python twin,
 * app/relationship_contract.py, that runs the same parse-vectors.json). Edit it here and run
 * scripts/sync-relationship-contract.sh in align-stack; never edit a copy.
 *
 * Words are split on ASCII space, tab, CR and LF only, so that a non-breaking space counts the
 * same in both languages. JSON is strict: NaN and Infinity are not JSON and drop the item.
 */
import contractJson from './relationship-contract.v1.json' with { type: 'json' };

export type RelationshipContract = typeof contractJson;
export type OfferName = keyof RelationshipContract['offers'];

export interface ParsedRelationshipItem {
  type: string;
  confidence: number;
  reason: string;
  evidence: { new_quote: string; existing_quote: string } | null;
  replaced: 'new' | 'existing' | null;
}

export const RELATIONSHIP_CONTRACT: RelationshipContract = contractJson;

/** The first balanced `{...}` in the text, string-aware, or null. No retry on a later object. */
function firstObjectText(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function wordCount(quote: string): number {
  return quote.split(/[ \t\n\r]+/).filter((w) => w !== '').length;
}

/** Both quotes present, non-blank and within the cap, or null. A half-populated pair reads as absent. */
function readEvidence(value: unknown, maxWords: number): ParsedRelationshipItem['evidence'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { new_quote: newQuote, existing_quote: existingQuote } = value as Record<string, unknown>;
  if (typeof newQuote !== 'string' || typeof existingQuote !== 'string') return null;
  for (const quote of [newQuote, existingQuote]) {
    const words = wordCount(quote);
    if (words === 0 || words > maxWords) return null;
  }
  return { new_quote: newQuote, existing_quote: existingQuote };
}

export function parseRelationshipItem(
  raw: string,
  offer: OfferName,
  contract: RelationshipContract = RELATIONSHIP_CONTRACT,
): ParsedRelationshipItem | null {
  if (!Object.hasOwn(contract.offers, offer)) {
    throw new Error(`Unknown offer list "${offer}". Allowed: ${Object.keys(contract.offers).join(', ')}.`);
  }
  const text = firstObjectText(raw);
  if (text === null) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = obj['type'];
  if (typeof type !== 'string' || !(contract.offers[offer] as readonly string[]).includes(type)) return null;

  const [low, high] = contract.parse.confidenceClamp as [number, number];
  const confidence = typeof obj['confidence'] === 'number'
    ? Math.min(Math.max(obj['confidence'], low), high)
    : contract.parse.confidenceDefault;
  const evidence = readEvidence(obj['evidence'], contract.parse.evidenceMaxWords);
  if (evidence === null && (contract.verdictTypes as readonly string[]).includes(type)) return null;
  const replaced = obj['replaced'] === 'new' || obj['replaced'] === 'existing' ? obj['replaced'] : null;
  return {
    type,
    confidence,
    reason: typeof obj['reason'] === 'string' ? obj['reason'] : '',
    evidence,
    replaced,
  };
}

/** What is wrong with the lists in a contract, one sentence each. Empty means they agree. */
export function contractProblems(contract: RelationshipContract): string[] {
  const problems: string[] = [];
  const types: readonly string[] = contract.types;
  const verdicts: readonly string[] = contract.verdictTypes;
  for (const t of new Set(types.filter((x, i) => types.indexOf(x) !== i))) {
    problems.push(`duplicate in types: "${t}"`);
  }
  for (const v of verdicts) {
    if (types.includes(v)) problems.push(`"${v}" is listed in types but is a verdict type, never a stored one`);
  }
  for (const [name, list] of Object.entries(contract.offers)) {
    for (const t of list) {
      if (!types.includes(t) && !verdicts.includes(t)) {
        problems.push(`offers.${name} lists "${t}", which is not in types`);
      }
    }
  }
  for (const t of contract.conflictFamily) {
    if (!types.includes(t)) problems.push(`conflictFamily lists "${t}", which is not in types`);
  }
  return problems;
}
