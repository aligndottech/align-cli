/**
 * Asks, before the connector picker, whether each connector with a saved read-only token should reuse it.
 *
 * It used to be asked only AFTER a person ticked that connector in the picker. Connected connectors are not
 * preselected, so a returning user who did not tick it was never offered the token they already had and pasted
 * a new one (David, 14 Oct). One question per saved connector, here, answers that. Nothing is re-fetched unless
 * the answer is yes, so the 2026-09-03 rule that a re-run touches only what you pick still holds.
 *
 * Pure on purpose: the prompt and the TTY check are passed in, so the rules are pinned without a terminal.
 */

export interface OfferSource {
  id: string;
  label: string;
  tokenShortLived?: boolean;
  /** Sources that share one token are asked about once: one Atlassian token is one fact. */
  group?: string;
}

export interface OfferDeps {
  ask: (message: string, initialValue: boolean) => Promise<unknown>;
  isCancel: (value: unknown) => boolean;
}

export interface OfferOptions {
  approve: boolean;
  interactive: boolean;
}

export interface OfferResult {
  /** Connectors whose saved token is reused: a terminal yes, or --approve for a connector that is picked. */
  reuse: Set<string>;
  /** Only a yes given at a terminal. These, and only these, run even when nobody ticked them. */
  answeredYes: Set<string>;
}

/** Sources without a saved token are never asked about. One question per group, whatever its members. */
export async function offerSavedTokens(
  sources: readonly OfferSource[],
  saved: ReadonlyMap<string, Record<string, string>>,
  opts: OfferOptions,
  deps: OfferDeps,
): Promise<OfferResult> {
  const reuse = new Set<string>();
  const answeredYes = new Set<string>();
  const withSaved = sources.filter((s) => saved.has(s.id));
  const groupOf = (s: OfferSource) => s.group ?? s.id;
  const answers = new Map<string, boolean>();
  for (const source of withSaved) {
    const group = groupOf(source);
    // --approve is a scripted yes for a connector the run already picked. It never adds one to the run.
    if (opts.approve) {
      reuse.add(source.id);
      continue;
    }
    if (!opts.interactive) continue;
    if (!answers.has(group)) {
      const members = withSaved.filter((s) => groupOf(s) === group);
      const names = members.map((s) => s.label).join(' and ');
      const shortLived = members.some((s) => s.tokenShortLived);
      const answer = await deps.ask(
        shortLived
          ? `Use the ${names} token you connected before? It lasts about an hour, so No (paste a fresh one) is usually right`
          : `Use the ${names} token you connected before? (No pastes a new one)`,
        !shortLived,
      );
      answers.set(group, !deps.isCancel(answer) && answer === true);
    }
    if (answers.get(group)) {
      reuse.add(source.id);
      answeredYes.add(source.id);
    }
  }
  return { reuse, answeredYes };
}
