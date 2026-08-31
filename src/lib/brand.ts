/**
 * Align brand rendering for the terminal.
 *
 * The mark is AUTHORED at terminal resolution, not downsampled from the vector logo.
 * Resampling the detailed mark to this size was tried first and read as mud: the thin
 * strokes and the inner triangle turn to noise below about 40 rows. So this is pixel
 * art of the mark - chevron, inner triangle, the teal bar and the two feet - drawn to
 * survive at 16x5 cells, packed two pixel rows per terminal row with half blocks.
 *
 * On a dark terminal the navy strokes are rendered WHITE, following the brand pack's
 * own knockout variant (F 4 R): navy on a dark background is invisible, which is why
 * that variant exists. The teal stays teal in both, as it does in the artwork.
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

export const LOGO_WIDTH = 20;
export const LOGO_ROWS = 6;

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

/**
 * The mark, DERIVED from the real logo rather than hand-drawn.
 *
 * Downscaled (stroke-preserving area coverage, 2026-08-31) from the approved 32x10
 * sprite, which was itself sampled from the brand pack's F 1 R.png at 32x20 pixels -
 * so the geometry is the actual mark and not an approximation of it: a hollow
 * triangle with a nested hollow triangle inside, a navy base bar that overhangs to the
 * RIGHT only, a teal bar that overhangs to the LEFT, two short teal segments, and two
 * slanted navy feet. Earlier hand-drawn versions got every one of those details wrong,
 * because they were reconstructed from memory instead of read off the asset. The one
 * hand edit at this size is the feet row's COLOUR mask: the teal bar's lower edge
 * bleeds into it when multiple source pixel rows are averaged into a single cell row at this scale, and the approved
 * sprite's bottom row is navy feet throughout - coverage was left exactly as derived.
 *
 * Only block and half-block glyphs are used. Quadrant characters were tried in 0.26.2
 * and render blurry and inset in many terminal fonts, which is the one thing a logo
 * cannot afford; these three are universally hinted.
 *
 * GLYPHS holds the shape, COLOURS names each cell's brand colour, and a test asserts
 * they agree cell for cell.
 */
const GLYPHS: readonly string[] = [
  '         ▄██        ',
  '       ▄█▀▄ █▄      ',
  '      █▀▄█▀█▄▀█     ',
  '     ▀▀▀▀▀▀▀▀▀▀▀▀▀▀ ',
  '▀▀▀██████▀▀▀▀█████  ',
  '  ██▄▄██      █▄▄██▄',
];

const COLOURS: readonly string[] = [
  '         NNN        ',
  '       NNNN NN      ',
  '      NNNNNNNNN     ',
  '     NNNNNNNNNNNNNN ',
  'TTTTTTTTTTTTTTTTTT  ',
  '  NNNNNN      NNNNNN',
];

/** Which brand colour the mark's strokes take. The pack ships a teal-only variant
 * (F 2 R) as well as the white knockout (F 4 R), so both are on-brand.
 *
 * A third 'solid' style used to swap in a filled sprite. The mark is drawn solid now, so
 * it had nothing left to offer and was removed rather than kept as a synonym. */
export type MarkStyle = 'white' | 'teal';

export interface RenderOptions {
  /** Mark styling; defaults to 'white'. */
  style?: MarkStyle;
  /** Emit ANSI at all. Defaults to "stdout is a TTY and NO_COLOR is unset". */
  color?: boolean;
  /** Use 24-bit colour. Defaults to reading COLORTERM. */
  truecolor?: boolean;
  /** Dark terminal background, which decides whether the mark is white or navy. */
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
  // terminals, and dark is the safer default: a white mark on an unexpectedly light
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

/** The mark, one string per terminal row, all exactly LOGO_WIDTH cells wide. */
export function logoLines(opts: RenderOptions = {}): string[] {
  const color = resolveColor(opts);
  const truecolor = resolveTruecolor(opts);
  const style = opts.style ?? 'white';
  const markRgb = resolveDark(opts) ? WHITE_RGB : NAVY_RGB;
  const mark256 = resolveDark(opts) ? WHITE_256 : NAVY_256;
  const strokeRgb = style === 'white' ? markRgb : TEAL_RGB;
  const stroke256 = style === 'white' ? mark256 : TEAL_256;

  return GLYPHS.map((row, y) => {
    if (!color) return row;
    const mask = COLOURS[y] ?? '';
    let out = '';
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] as string;
      const c = mask[x];
      if (c === 'N') out += `${fg(strokeRgb, stroke256, truecolor)}${ch}${RESET}`;
      else if (c === 'T') out += `${fg(TEAL_RGB, TEAL_256, truecolor)}${ch}${RESET}`;
      else out += ch;
    }
    return out;
  });
}

export interface BannerOptions extends RenderOptions {
  version: string;
}

/**
 * The full lockup: the mark on the left, wordmark and tagline to its right, so the
 * whole thing is only as tall as the mark (LOGO_ROWS) rather than stacking.
 */
/** Split the second headline line into its plain lead and its accented tail. */
function splitAccent(line: string): [string, string] {
  const i = line.indexOf(TAGLINE_ACCENT);
  // Fall back to colouring the whole line rather than dropping the accent silently,
  // so a reworded tagline degrades visibly instead of losing a colour nobody notices.
  return i < 0 ? ['', line] : [line.slice(0, i), line.slice(i)];
}

export function banner(opts: BannerOptions): string {
  const color = resolveColor(opts);
  const truecolor = resolveTruecolor(opts);
  const dim = color ? '\x1b[2m' : '';
  const bold = color ? '\x1b[1m' : '';
  const tealFg = color ? fg(TEAL_RGB, TEAL_256, truecolor) : '';
  // The headline takes the mark colour, which is white on dark and navy on light,
  // so it reads against whichever ground the terminal has.
  const headline = color
    ? fg(resolveDark(opts) ? WHITE_RGB : NAVY_RGB, resolveDark(opts) ? WHITE_256 : NAVY_256, truecolor)
    : '';
  const reset = color ? RESET : '';

  const right: string[] = new Array(LOGO_ROWS).fill('');
  // Registered, not TM: Align is a registered trademark.
  // Centre the text block against the mark's height instead of pinning rows: the
  // sprite has changed height three times and hardcoded indices drifted each time.
  const textTop = Math.max(0, Math.floor((LOGO_ROWS - 4) / 2));
  right[textTop] = `${bold}ALIGN®${reset}`;
  // Match the site: the headline is the heading colour and only the accent span is teal.
  right[textTop + 1] = `${headline}${TAGLINE_LINES[0]}${reset}`;
  const [lead, accent] = splitAccent(TAGLINE_LINES[1]);
  right[textTop + 2] = `${headline}${lead}${reset}${tealFg}${accent}${reset}`;
  // Version only. A graph label ('local graph', 'personal cloud') cannot go here:
  // both callers print the banner BEFORE they know which graph is in play, so any
  // such line would be a guess, and guessing 'local' at a cloud user implies their
  // data stayed on the machine when it did not.
  const meta = `v${opts.version}`;
  right[textTop + 4] = `${dim}${meta}${reset}`;

  const mark = logoLines(opts);
  return mark.map((m, i) => (right[i] ? `${m}   ${right[i]}` : m)).join('\n');
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
  process.stdout.write(`${banner(opts)  }\n`);
  return true;
}
