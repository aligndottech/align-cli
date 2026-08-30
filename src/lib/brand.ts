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
export const LOGO_ROWS = 8;

/**
 * The live positioning line, taken from align-frontend's hero (src/lib/seo.ts).
 * 'Collaboration with clarity built in' is RETIRED - do not reintroduce it.
 */
export const TAGLINE_LINES = [
  'Your AI agents know the code.',
  "They don't know the company.",
] as const;

/**
 * One character per terminal cell, encoding the two pixel rows it covers:
 *   ' ' both empty   'N' both mark    'T' both teal
 *   'n' mark on top  'u' mark below   't' teal on top   'v' teal below
 *   'x' mark over teal              'y' teal over mark
 */
const SPRITE: readonly string[] = [
  '        unnu        ',
  '       NnuunN       ',
  '      NnunnunN      ',
  '    uNNuNuuNuNNuuuuu',
  'vvvvvvvvvvvvvvvvvv  ',
  '   vvvvv    vvvvv   ',
  '  uu  uu    uu  uu  ',
  '  NNuNN      NNuNN  ',
];

/** Which brand colour the mark's strokes take. The pack ships a teal-only variant
 * (F 2 R) as well as the white knockout (F 4 R), so both are on-brand. */
export type MarkStyle = 'white' | 'teal' | 'solid';

const SPRITE_SOLID: readonly string[] = [
  '        uNNu        ',
  '       NNnnNN       ',
  '      NNnuunNN      ',
  '    uNNNuNNuNNNuuuuu',
  'vvvvvvvvvvvvvvvvvv  ',
  '   vvvvv    vvvvv   ',
  '  uuu uuu   uuu uuu ',
  '  NNNuNNN   NNNuNNN ',
];

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
  const markRgb = resolveDark(opts) ? WHITE_RGB : NAVY_RGB;
  const mark256 = resolveDark(opts) ? WHITE_256 : NAVY_256;

  const style = opts.style ?? 'white';
  // 'teal' paints the strokes teal instead of the knockout white; 'solid' also swaps in
  // the filled sprite, which reads bolder because the mass carries the colour rather
  // than a one-cell outline.
  const strokeRgb = style === 'white' ? markRgb : TEAL_RGB;
  const stroke256 = style === 'white' ? mark256 : TEAL_256;
  return (style === 'solid' ? SPRITE_SOLID : SPRITE).map((row) => {
    let out = '';
    for (const cell of row) {
      // Plain mode still uses the blocks: the shape is the point, and stripping
      // colour must not change the width or the silhouette.
      if (!color) {
        out += cell === ' ' ? ' '
          : cell === 'N' || cell === 'T' ? '█'
          : cell === 'n' || cell === 't' ? '▀'
          : cell === 'u' || cell === 'v' ? '▄'
          : '█';
        continue;
      }
      switch (cell) {
        case ' ': out += ' '; break;
        case 'N': out += `${fg(strokeRgb, stroke256, truecolor)  }█${  RESET}`; break;
        case 'T': out += `${fg(TEAL_RGB, TEAL_256, truecolor)  }█${  RESET}`; break;
        case 'n': out += `${fg(strokeRgb, stroke256, truecolor)  }▀${  RESET}`; break;
        case 'u': out += `${fg(strokeRgb, stroke256, truecolor)  }▄${  RESET}`; break;
        case 't': out += `${fg(TEAL_RGB, TEAL_256, truecolor)  }▀${  RESET}`; break;
        case 'v': out += `${fg(TEAL_RGB, TEAL_256, truecolor)  }▄${  RESET}`; break;
        case 'x': out += `${fg(strokeRgb, stroke256, truecolor) + bg(TEAL_RGB, TEAL_256, truecolor)  }▀${  RESET}`; break;
        case 'y': out += `${fg(TEAL_RGB, TEAL_256, truecolor) + bg(strokeRgb, stroke256, truecolor)  }▀${  RESET}`; break;
        default: out += ' ';
      }
    }
    return out;
  });
}

export interface BannerOptions extends RenderOptions {
  version: string;
  /** Optional context line, e.g. "local graph" or "preview". */
  context?: string;
}

/**
 * The full lockup: the mark on the left, wordmark and tagline to its right, so the
 * whole thing is only as tall as the mark (LOGO_ROWS) rather than stacking.
 */
export function banner(opts: BannerOptions): string {
  const color = resolveColor(opts);
  const truecolor = resolveTruecolor(opts);
  const dim = color ? '\x1b[2m' : '';
  const bold = color ? '\x1b[1m' : '';
  const tealFg = color ? fg(TEAL_RGB, TEAL_256, truecolor) : '';
  const reset = color ? RESET : '';

  const right: string[] = new Array(LOGO_ROWS).fill('');
  // Registered, not TM: Align is a registered trademark.
  right[1] = `${bold}ALIGN®${reset}`;
  right[2] = `${tealFg}${TAGLINE_LINES[0]}${reset}`;
  right[3] = `${tealFg}${TAGLINE_LINES[1]}${reset}`;
  const meta = opts.context ? `v${opts.version}  ${'\u00b7'}  ${opts.context}` : `v${opts.version}`;
  right[5] = `${dim}${meta}${reset}`;

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
