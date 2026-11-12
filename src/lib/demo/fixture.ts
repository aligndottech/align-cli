/**
 * The repo `align demo` builds in a temp dir. Held as strings, not as copied asset files, so it
 * is the same on every install path (npm, the compiled binaries) and there is nothing to ship
 * beside dist/.
 *
 * One decision in git history and the same rule in CLAUDE.md, which is what a real project looks
 * like once somebody wrote the rule down. The two edits below are what an agent would propose.
 */
export interface DemoFile { path: string; content: string }

export const DEMO_FILES: readonly DemoFile[] = [
  {
    path: 'src/store.ts',
    content: [
      'export interface AppState {',
      '  user: string | null;',
      '  cart: string[];',
      '}',
      '',
      'export const state: AppState = { user: null, cart: [] };',
      '',
    ].join('\n'),
  },
  {
    path: 'CLAUDE.md',
    content: [
      '# State rule',
      '',
      '- Keep all app state in src/store.ts. Do not add module-level state in other files.',
      '',
    ].join('\n'),
  },
];

export const DEMO_COMMIT_SUBJECT = 'Keep all app state in src/store.ts';

export const DEMO_COMMIT_BODY = [
  'State had spread across several modules and nobody could say where a value changed.',
  'Decision: all app state lives in src/store.ts, so every change goes through one place.',
].join('\n');

export const DEMO_EDITS = {
  /** Adds module-level state outside the store. Written as a whole-file write, the shape the hook reads first. */
  violating: {
    file: 'src/cart.ts',
    content: ['let appState = { items: [] as string[] };', 'export const getState = () => appState;', ''].join('\n'),
  },
  /** Touches no state at all. */
  harmless: {
    file: 'src/format.ts',
    content: ['export function formatPrice(cents: number): string {', '  return (cents / 100).toFixed(2);', '}', ''].join('\n'),
  },
} as const;
