/**
 * Said with every non-empty local conflict list (align_get_conflicts in local mode).
 *
 * In the local graph a conflict link is written only by the person's own AI model, local or hosted:
 * `align sync --classify`, or a capture made with a key set. The label is stored on this machine;
 * the model may not run here. Nobody adjudicates it, so an agent must present
 * it as a possible conflict, not a finding. Conflicts across tools and people that a person
 * adjudicates are the team product.
 */
export const LOCAL_CONFLICTS_NOTE =
  'These conflict labels come from an AI model and are stored only in the local graph. No person has confirmed them unless a mark on the pair says so. If the person asked for their conflicts, list them, each marked as a possible conflict. Otherwise do not volunteer a list for them to review: mention one only when it bears on what they are doing now.';
