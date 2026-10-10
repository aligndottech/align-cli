import { describe, expect, it } from 'vitest';
import { MAX_LINK_LENGTH } from '../lib/share/approve-link.js';
import { qrStyleFor, renderQr } from '../lib/share/qr.js';
import { decodeMatrix, eccCodeOf, matrixOf, parseLines } from './helpers/qr-decode.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const KEYS = ['A'.repeat(43), `${'Zy0_'.repeat(10)  }Q9-`, 'x7Kp2-_mN4vB8cR1tL6wE3yU5iO0aS9dF2gH4jK6lZ8'.slice(0, 43)];
const mk = (origin: string, key: string): string => `${origin}/share/approve/${ID}#k=${key}`;
const typical = mk('https://app.align.tech', KEYS[0]!);
const STYLES = [{ color: true, unicode: true }, { color: true, unicode: false }, { color: false, unicode: true }, { color: false, unicode: false }];

describe('renderQr: what is printed decodes back to exactly the link', () => {
  const links = [
    typical, mk('https://app.preview.align.tech', KEYS[1]!), mk('http://localhost:5173', KEYS[2]!),
    mk(`https://${'b'.repeat(40)}.example.org`, KEYS[1]!),
  ];
  const longest = mk(`https://${'c'.repeat(MAX_LINK_LENGTH - 97 - 11)}.io`, KEYS[2]!);
  it('the longest allowed link is really at the cap', () => { expect(longest.length).toBe(MAX_LINK_LENGTH); });
  for (const style of STYLES) {
    it(`round-trips ${[style.color ? 'colour' : 'plain', style.unicode ? 'half-block' : 'ascii'].join(' ')}, the fragment included`, () => {
      for (const link of [...links, longest]) {
        const { lines } = renderQr(link, style);
        const decoded = decodeMatrix(parseLines(lines, style));
        expect(decoded, link).toBe(link);
        expect(decoded!.endsWith(`#k=${link.slice(-43)}`)).toBe(true);
      }
    });
  }
  it('the check can fail: a one-character difference does not decode to the original', () => {
    const other = `${typical.slice(0, -1)  }B`;
    const style = STYLES[0]!;
    const decoded = decodeMatrix(parseLines(renderQr(other, style).lines, style));
    expect(decoded).toBe(other);
    expect(decoded).not.toBe(typical);
  });
});

describe('renderQr: size, error correction and polarity', () => {
  it('a 110-130 character link is at most version 10 and fits in 60 columns', () => {
    for (const origin of ['https://app.align.tech', 'https://app.preview.align.tech', 'https://app.some-long-customer-name.example.com']) {
      const link = mk(origin, KEYS[1]!);
      expect(link.length).toBeGreaterThanOrEqual(105);
      const r = renderQr(link, STYLES[0]!);
      expect(r.version).toBeLessThanOrEqual(10);
      expect(r.columns).toBeLessThanOrEqual(60);
      for (const l of r.lines) expect(l.replace(/\u001b\[[0-9;]*m/g, '').length).toBe(r.columns);
    }
  });
  it('half-block output is about half as tall as it is wide', () => {
    const r = renderQr(typical, STYLES[0]!);
    expect(r.lines.length).toBeLessThanOrEqual(Math.ceil(r.columns / 2) + 1);
  });
  it('the error-correction level is M or higher (and the probe can tell L from M)', () => {
    const rank = (c: number): number => ({ 1: 0, 0: 1, 3: 2, 2: 3 } as Record<number, number>)[c]!;
    expect(rank(eccCodeOf(matrixOf(typical, 'L')))).toBe(0);
    expect(rank(eccCodeOf(matrixOf(typical, 'M')))).toBe(1);
    const style = STYLES[2]!; // plain half-block: the quiet zone is light and the matrix is read back from the print
    const { lines, quiet } = renderQr(typical, style);
    const rows = parseLines(lines, style).map((r) => r.slice(quiet, r.length - quiet)).slice(quiet, -quiet);
    const matrix = rows.slice(0, rows[0]!.length);
    expect(rank(eccCodeOf(matrix))).toBeGreaterThanOrEqual(1);
  });
  it('colour output carries its own black and white, so it scans on a dark and a light terminal alike', () => {
    const { lines } = renderQr(typical, STYLES[0]!);
    expect(lines.join('')).toMatch(/\u001b\[38;5;16;48;5;231m|\u001b\[38;5;231;48;5;16m|\u001b\[38;5;16;48;5;16m|\u001b\[38;5;231;48;5;231m/);
    for (const l of lines) expect(l.endsWith('\u001b[0m')).toBe(true);
    // the top and bottom quiet-zone rows are white, not "whatever the terminal background is"
    expect(lines[0]!.replace(/\u001b\[0m$/, '').split('▀').every((s) => s === '' || /^\u001b\[38;5;231;48;5;231m$|^$/.test(s) || /38;5;231;48;5;231/.test(s))).toBe(true);
  });
  it('uses no Unicode at all in the ascii style', () => {
    for (const l of renderQr(typical, { color: false, unicode: false }).lines) expect(l).toMatch(/^[ #]+$/);
    for (const l of renderQr(typical, { color: true, unicode: false }).lines) expect(l.replace(/\u001b\[[0-9;]*m/g, '')).toMatch(/^ +$/);
  });
});

describe('qrStyleFor: colour and Unicode from the environment', () => {
  it('colour unless NO_COLOR or a dumb terminal', () => {
    expect(qrStyleFor('linux', { LANG: 'en_GB.UTF-8' }).color).toBe(true);
    expect(qrStyleFor('linux', { LANG: 'en_GB.UTF-8', NO_COLOR: '1' }).color).toBe(false);
    expect(qrStyleFor('linux', { LANG: 'en_GB.UTF-8', TERM: 'dumb' }).color).toBe(false);
    expect(qrStyleFor('linux', { LANG: 'en_GB.UTF-8', NO_COLOR: '' }).color).toBe(true);
  });
  it('Unicode when the locale says UTF-8, not on the Linux console or a C locale; Windows is Unicode', () => {
    expect(qrStyleFor('linux', { LC_ALL: 'C.UTF-8' }).unicode).toBe(true);
    expect(qrStyleFor('darwin', { LANG: 'en_US.utf8' }).unicode).toBe(true);
    expect(qrStyleFor('linux', { LANG: 'C' }).unicode).toBe(false);
    expect(qrStyleFor('linux', {}).unicode).toBe(false);
    expect(qrStyleFor('linux', { LANG: 'en_GB.UTF-8', TERM: 'linux' }).unicode).toBe(false);
    expect(qrStyleFor('win32', {}).unicode).toBe(true);
  });
});
