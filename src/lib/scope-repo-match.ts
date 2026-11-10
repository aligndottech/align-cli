/**
 * Which of the teams, projects or spaces a token can see belong to THIS repo, by name. A match is a whole word: a word of the
 * repo's name (or its folder's) equal to a word of an item's name or key, split on anything that is not a letter or digit, in any case;
 * or the two whole names equal. Never a substring (ENG is not "engine", ops is not "workshops"). A word under three characters never
 * matches, so a two-letter Jira key does not claim every repo. A suggestion only: it decides what the picker preselects, never what is read.
 */
const MIN = 3;
const words = (t: string): string[] => t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== '');
const whole = (t: string): string => words(t).join('');

/** The keys of the items whose name or key shares a whole word with one of the repo's names. Only a suggestion for what a picker preselects. */
export function matchRepoNames(items: Array<{ key: string; name: string }>, repoNames: string[]): string[] {
  const repoWords = new Set(repoNames.flatMap(words).filter((w) => w.length >= MIN));
  const repoWhole = new Set(repoNames.map(whole).filter((w) => w.length >= MIN));
  return items
    .filter((i) => [i.key, i.name].some((t) => words(t).some((w) => w.length >= MIN && repoWords.has(w)) || repoWhole.has(whole(t))))
    .map((i) => i.key);
}
