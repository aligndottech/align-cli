/**
 * A QR code of the FULL approval link (fragment included) for the terminal, so a phone camera can carry it to a
 * device where the person approves with a passkey.
 *
 * Error correction is fixed at M (the encoder may raise it, never lower it). A 110-130 character link is version 7
 * to 9, about 45 to 53 modules, so with a 4-module quiet zone it prints in roughly 55 to 61 columns and half as many rows.
 *
 * Colour styles set their own black and white (256-colour 16 and 231) on every cell, so the code scans on a dark and
 * a light terminal alike: the quiet zone is white, not the terminal's background. Plain styles (NO_COLOR, TERM=dumb)
 * cannot do that: a filled cell is drawn in the terminal's text colour, so they fill LIGHT modules, which is right on
 * the usual dark terminal and inverted on a light one (most phone cameras still read an inverted code).
 * Without Unicode a module is two columns wide (colour: two coloured spaces; plain: "  " and "##").
 */
import { encode } from 'uqr';

export interface QrStyle { color: boolean; unicode: boolean }
export interface QrRender { lines: string[]; version: number; columns: number; quiet: number }

const QUIET = 4;
const RESET = '\u001b[0m';
const BLACK = 16;
const WHITE = 231;
const sgr = (fg: number, bg: number): string => `\u001b[38;5;${fg};48;5;${bg}m`;
const bgOnly = (bg: number): string => `\u001b[48;5;${bg}m`;

export function renderQr(text: string, style: QrStyle): QrRender {
  const { data, version } = encode(text, { ecc: 'M', border: 0 });
  const n = data.length;
  const total = n + 2 * QUIET;
  const dark = (x: number, y: number): boolean => x >= QUIET && y >= QUIET && x < QUIET + n && y < QUIET + n && data[y - QUIET]![x - QUIET] === true;
  const lines: string[] = [];
  if (style.unicode) {
    for (let y = 0; y < total; y += 2) {
      let line = ''; let cur = '';
      for (let x = 0; x < total; x++) {
        const t = dark(x, y); const b = dark(x, y + 1);
        if (style.color) {
          const code = sgr(t ? BLACK : WHITE, b ? BLACK : WHITE);
          if (code !== cur) { line += code; cur = code; }
          line += '▀';
        } else {
          // filled = light module
          line += !t && !b ? '█' : !t && b ? '▀' : t && !b ? '▄' : ' ';
        }
      }
      lines.push(style.color ? line + RESET : line);
    }
    return { lines, version, columns: total, quiet: QUIET };
  }
  for (let y = 0; y < total; y++) {
    let line = ''; let cur = -1;
    for (let x = 0; x < total; x++) {
      if (style.color) {
        const bg = dark(x, y) ? BLACK : WHITE;
        if (bg !== cur) { line += bgOnly(bg); cur = bg; }
        line += '  ';
      } else line += dark(x, y) ? '  ' : '##';
    }
    lines.push(style.color ? line + RESET : line);
  }
  return { lines, version, columns: total * 2, quiet: QUIET };
}

const set = (v: string | undefined): boolean => v !== undefined && v !== '';

export function qrStyleFor(platform: string, env: Record<string, string | undefined>): QrStyle {
  const color = !set(env['NO_COLOR']) && env['TERM'] !== 'dumb';
  const locale = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || '';
  const unicode = env['TERM'] === 'dumb' ? false : platform === 'win32' ? true : env['TERM'] !== 'linux' && /utf-?8/i.test(locale);
  return { color, unicode };
}
