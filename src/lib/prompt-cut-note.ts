import type { PromptCuts } from '../detector/relationship-prompt.js';

/**
 * A check that judged only part of the text must say so (#719). The local judge reads a window's worth of the change and
 * of each retrieved decision, and a decision is often cut before the paragraph that states its rule, so "aligned" can mean
 * "the part that conflicts was never read". Null when nothing was cut.
 */
export function promptCutNote(cuts: PromptCuts | undefined, titles: readonly string[]): string | null {
  if (!cuts) return null;
  const n = (v: number): string => v.toLocaleString('en-US');
  const parts: string[] = [];
  if (cuts.subject) parts.push(`the proposed change, ${n(cuts.subject.kept)} of ${n(cuts.subject.total)} characters`);
  cuts.candidates.forEach((c, i) => {
    if (c) parts.push(`"${titles[i] ?? 'a decision'}", ${n(c.kept)} of ${n(c.total)} characters`);
  });
  if (!parts.length) return null;
  return `The model read only part of the text it judged, because its ${n(cuts.windowTokens)}-token window did not hold all of it: ${parts.join('; ')}. ` +
    'A rule stated late in a decision may not have been seen, so take an aligned result with care. A model with a larger context window reads it whole.';
}
