/**
 * "A change under these paths must also change those paths, in the same PR." The shape
 * `align check` evaluates deterministically against a PR's file list. Defined once here so
 * an importer that emits it and a checker that reads it cannot spell it two ways.
 */
export interface CoChangeRule {
  when_paths: string[];
  require_paths: string[];
  scope: 'same_pr';
}
