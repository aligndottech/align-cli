const STRIP_PREFIXES: RegExp[] = [
  // "why do/does/did we/it/they ..."
  /^why\s+(do|does|did)\s+(we|it|they)\s+/i,
  // "why is/are/was/were we/it/they ..."
  /^why\s+(is|are|was|were)\s+(we|it|they)\s+/i,
  // "why should/would/can/could/have/has we/it/they ..."
  /^why\s+(should|would|can|could|have|has)\s+(we|it|they)\s+/i,
  // "why verb ..." (strip verb too, keep the rest)
  /^why\s+(do|does|did|is|are|was|were|should|would|can|could|have|has)\s+/i,
  // bare "why ..."
  /^why\s+/i,
  // "do/does/did we/it/they ..."
  /^(do|does|did)\s+(we|it|they)\s+/i,
  // "what do/does/did we/it/they ..."
  /^what\s+(do|does|did)\s+(we|it|they)\s+/i,
  // "what is/are/was/were ..."
  /^what\s+(is|are|was|were)\s+/i,
  // bare "what ..."
  /^what\s+/i,
  // "how do/does/did we/it/they ..."
  /^how\s+(do|does|did)\s+(we|it|they)\s+/i,
  // "how verb ..."
  /^how\s+(does|do|did|is|are|was|were)\s+/i,
  // bare "how ..."
  /^how\s+/i,
];

export function normaliseWhyQuery(q: string): string {
  const trimmed = q.trim();
  for (const re of STRIP_PREFIXES) {
    if (re.test(trimmed)) {
      const stripped = trimmed.replace(re, '').trim();
      if (stripped.length > 0) {
        return stripped;
      }
    }
  }
  return trimmed;
}
