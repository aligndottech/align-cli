/**
 * Align brand rendering for the terminal.
 *
 * The header is text, not pixel art: a teal triangle, the name and version, then the
 * tagline, three rows in all, the way Claude Code and Codex open. Tom, 10 Nov 2026: the
 * 7-row block 'A' looked bad beside them. Before that the CLI went through a chevron,
 * a robot head and an alien head (both read as skulls), and that block 'A'. Every pixel
 * version failed the same way: a terminal cell is too coarse to draw a logo, and a font
 * glyph renders sharp in every terminal. U+25B2 is the A's silhouette.
 *
 * On a dark terminal navy text is rendered WHITE, following the brand pack's knockout
 * variant (F 4 R): navy on a dark background is invisible. Teal stays teal on both.
 */

export const BRAND = {
  teal: '#43b6ac',
  navy: '#022863',
} as const;

const TEAL_RGB: [number, number, number] = [67, 182, 172];
const NAVY_RGB: [number, number, number] = [2, 40, 99];
const WHITE_RGB: [number, number, number] = [255, 255, 255];

// 256-colour approximations, for terminals that report colour but not truecolor.
const TEAL_256 = 79;
const NAVY_256 = 24;
const WHITE_256 = 231;

/** The mark: one glyph, in brand teal. */
export const MARK = '▲';

/**
 * The live positioning line, taken from align-frontend's hero (src/lib/seo.ts).
 * 'Collaboration with clarity built in' is RETIRED - do not reintroduce it.
 */
export const TAGLINE_LINES = [
  'Your AI agents know the code.',
  "They don't know the company.",
] as const;

/**
 * The part align-frontend wraps in <span class="accent">, which resolves to --teal.
 * Everything else in the headline takes the heading colour, so colouring both lines
 * teal (as this did at first) is not what the site does.
 */
export const TAGLINE_ACCENT = "don't know the company.";

/** The setup prompts draw "│  " down the left, so their text starts at column 3. */
const INDENT = '   ';

export interface RenderOptions {
  /** Emit ANSI at all. Defaults to "stdout is a TTY and NO_COLOR is unset". */
  color?: boolean;
  /** Use 24-bit colour. Defaults to reading COLORTERM. */
  truecolor?: boolean;
  /** Dark terminal background, which decides whether text is white or navy. */
  dark?: boolean;
}

function resolveColor(o: RenderOptions): boolean {
  if (typeof o.color === 'boolean') return o.color;
  // NO_COLOR is honoured whatever its value, per the no-color.org convention: the
  // variable's PRESENCE is the signal, so `NO_COLOR=0` still disables colour.
  if (process.env['NO_COLOR'] !== undefined) return false;
  return Boolean(process.stdout.isTTY);
}

function resolveTruecolor(o: RenderOptions): boolean {
  if (typeof o.truecolor === 'boolean') return o.truecolor;
  const ct = process.env['COLORTERM'] ?? '';
  return ct === 'truecolor' || ct === '24bit';
}

function resolveDark(o: RenderOptions): boolean {
  if (typeof o.dark === 'boolean') return o.dark;
  // COLORFGBG is "fg;bg"; a bg of 0-6 or 8 means a dark background. Absent on most
  // terminals, and dark is the safer default: white text on an unexpectedly light
  // background is faint, whereas navy on an unexpectedly dark one is unreadable.
  const fgbg = process.env['COLORFGBG'];
  if (fgbg) {
    const bg = Number(fgbg.split(';').pop());
    if (Number.isFinite(bg)) return bg <= 6 || bg === 8;
  }
  return true;
}

function fg(rgb: [number, number, number], c256: number, truecolor: boolean): string {
  return truecolor ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[38;5;${c256}m`;
}

function bg(rgb: [number, number, number], c256: number, truecolor: boolean): string {
  return truecolor ? `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[48;5;${c256}m`;
}

const RESET = '\x1b[0m';

export interface BannerOptions extends RenderOptions {
  version: string;
}

/** Split the second headline line into its plain lead and its accented tail. */
function splitAccent(line: string): [string, string] {
  const i = line.indexOf(TAGLINE_ACCENT);
  // Fall back to colouring the whole line rather than dropping the accent silently,
  // so a reworded tagline degrades visibly instead of losing a colour nobody notices.
  return i < 0 ? ['', line] : [line.slice(0, i), line.slice(i)];
}

/** The header: mark, name and version on one row, the tagline on the two below. */
export function banner(opts: BannerOptions): string {
  const color = resolveColor(opts);
  const truecolor = resolveTruecolor(opts);
  const dim = color ? '\x1b[2m' : '';
  const bold = color ? '\x1b[1m' : '';
  const teal = color ? fg(TEAL_RGB, TEAL_256, truecolor) : '';
  // The headline takes the heading colour, white on dark and navy on light, so it reads
  // against whichever ground the terminal has.
  const dark = resolveDark(opts);
  const headline = color ? fg(dark ? WHITE_RGB : NAVY_RGB, dark ? WHITE_256 : NAVY_256, truecolor) : '';
  const reset = color ? RESET : '';
  const [lead, accent] = splitAccent(TAGLINE_LINES[1]);

  // Registered, not TM: Align is a registered trademark. Version only: a graph label
  // ('local graph', 'personal cloud') cannot go here, because both callers print this
  // BEFORE they know which graph is in play, and guessing 'local' at a cloud user
  // implies their data stayed on the machine when it did not.
  return [
    `${teal}${MARK}${reset}  ${bold}Align®${reset} ${dim}v${opts.version}${reset}`,
    `${INDENT}${headline}${TAGLINE_LINES[0]}${reset}`,
    `${INDENT}${headline}${lead}${reset}${teal}${accent}${reset}`,
  ].join('\n');
}

/** One consistent intro chip for every command, in brand teal. */
export function commandIntro(label: string, opts: RenderOptions = {}): string {
  const color = resolveColor(opts);
  if (!color) return ` ${label} `;
  const truecolor = resolveTruecolor(opts);
  return `${bg(TEAL_RGB, TEAL_256, truecolor)}${fg(NAVY_RGB, NAVY_256, truecolor)} ${label} ${RESET}`;
}

/**
 * Print the banner, but only when someone is actually looking at a terminal.
 *
 * Piped output (`align ask ... | jq`) and CI logs must stay clean, so this is a
 * no-op off a TTY rather than a plain-text banner.
 */
export function printBanner(opts: BannerOptions): boolean {
  if (!process.stdout.isTTY) return false;
  process.stdout.write(`${banner(opts)}\n`);
  return true;
}
