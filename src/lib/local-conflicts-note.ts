/**
 * Said with every non-empty local conflict list (align_get_conflicts in local mode).
 *
 * On this machine a conflict link is written only by the person's own AI model: `align sync
 * --classify`, or a capture made with a key set. Nobody adjudicates it, so an agent must present
 * it as a possible conflict, not a finding. Conflicts across tools and people that a person
 * adjudicates are the team product.
 */
export const LOCAL_CONFLICTS_NOTE =
  'These conflicts were labelled by an AI model on this machine, and no person has confirmed them unless a mark on the pair says so. Present them as possible conflicts to review, not as conflicts found.';
