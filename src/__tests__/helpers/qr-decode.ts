import jsQR from 'jsqr';
import { encode } from 'uqr';

/**
 * Test-only: turn what the CLI PRINTS back into a module matrix, then into pixels, and decode it with an independent
 * decoder (jsQR). Parsing the real output, not the encoder's matrix, is what makes a round trip mean something.
 */
const ESC = '\u001b';
const BLACK = '16';
const WHITE = '231';

/** One printed line to two rows of dark(true)/light(false) modules. `width` is the number of module columns. */
export function parseLines(lines: readonly string[], style: { color: boolean; unicode: boolean }): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of lines) {
    if (style.color && style.unicode) {
      const top: boolean[] = []; const bottom: boolean[] = [];
      let fg = WHITE; let bg = WHITE;
      const re = new RegExp(`${ESC}\\[([0-9;]*)m|(.)`, 'gu');
      for (const m of line.matchAll(re)) {
        if (m[1] !== undefined) {
          if (m[1] === '0' || m[1] === '') { fg = WHITE; bg = WHITE; continue; }
          const f = /38;5;(\d+)/.exec(m[1]); const b = /48;5;(\d+)/.exec(m[1]);
          if (f) fg = f[1]!;
          if (b) bg = b[1]!;
          continue;
        }
        if (m[2] !== '▀') throw new Error(`unexpected glyph ${JSON.stringify(m[2])}`);
        top.push(fg === BLACK); bottom.push(bg === BLACK);
      }
      rows.push(top, bottom);
    } else if (style.color) {
      // colored double spaces: one module = two columns, one row
      const cells: boolean[] = []; let bg = WHITE; let n = 0;
      const re = new RegExp(`${ESC}\\[([0-9;]*)m|( )`, 'gu');
      for (const m of line.matchAll(re)) {
        if (m[1] !== undefined) { const b = /48;5;(\d+)/.exec(m[1]); if (m[1] === '0' || m[1] === '') bg = WHITE; else if (b) bg = b[1]!; continue; }
        n += 1; if (n % 2 === 0) cells.push(bg === BLACK);
      }
      rows.push(cells);
    } else if (style.unicode) {
      // plain: a filled cell is a LIGHT module (reads correctly on a dark terminal)
      const top: boolean[] = []; const bottom: boolean[] = [];
      for (const ch of line) {
        const [t, b] = ch === ' ' ? [true, true] : ch === '▀' ? [false, true] : ch === '▄' ? [true, false] : ch === '█' ? [false, false] : (() => { throw new Error(`unexpected glyph ${JSON.stringify(ch)}`); })();
        top.push(t); bottom.push(b);
      }
      rows.push(top, bottom);
    } else {
      const cells: boolean[] = [];
      for (let i = 0; i < line.length; i += 2) cells.push(line.slice(i, i + 2) === '  ');
      rows.push(cells);
    }
  }
  return rows;
}

/** Decode a module matrix (with its quiet zone) to text, or null. dontInvert: a wrong polarity must NOT decode. */
export function decodeMatrix(rows: readonly boolean[][], scale = 6): string | null {
  const h = rows.length; const w = Math.max(...rows.map((r) => r.length));
  const W = w * scale; const H = h * scale;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dark = rows[Math.floor(y / scale)]![Math.floor(x / scale)] ?? false;
    const i = (y * W + x) * 4; const v = dark ? 0 : 255;
    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
  }
  return jsQR(data, W, H, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

/** Error-correction level code from the format bits of a matrix with NO quiet zone: 1=L 0=M 3=Q 2=H (ISO 18004). */
export function eccCodeOf(matrix: readonly boolean[][]): number {
  const bit = (x: number, y: number): number => (matrix[y]![x] ? 1 : 0);
  let v = 0;
  for (let i = 0; i <= 5; i++) v = (v << 1) | bit(i, 8);
  v = (v << 1) | bit(7, 8); v = (v << 1) | bit(8, 8); v = (v << 1) | bit(8, 7);
  for (let j = 5; j >= 0; j--) v = (v << 1) | bit(8, j);
  return ((v ^ 0x5412) >> 13) & 3;
}

export const matrixOf = (text: string, ecc: 'L' | 'M' | 'Q' | 'H'): boolean[][] => encode(text, { ecc, border: 0 }).data;
