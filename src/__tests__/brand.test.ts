import { describe, expect, it } from 'vitest';
import { banner, BRAND, commandIntro, LOGO_ROWS, LOGO_WIDTH, logoLines } from '../lib/brand.js';

const ESC = '\x1b';
// eslint-disable-next-line no-control-regex -- ESC is the thing under test here
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('BRAND palette', () => {
  it('uses the exact brand hex values from the asset pack', () => {
    // Derived from the SVGs in ~/Downloads/AlignBranding: fill:#43b6ac and fill:#022863.
    expect(BRAND.teal).toBe('#43b6ac');
    expect(BRAND.navy).toBe('#022863');
  });
});

describe('logoLines', () => {
  it('renders the mark at the declared size', () => {
    expect(logoLines({ color: false })).toHaveLength(LOGO_ROWS);
  });

  it('renders every row at an identical display width', () => {
    // Ragged rows would break any lockup that puts text to the right of the mark,
    // and the defect is invisible until someone looks at a real terminal.
    const widths = new Set(logoLines({ color: false }).map((l) => strip(l).length));
    expect([...widths]).toEqual([LOGO_WIDTH]);
  });

  it('emits no escape sequences when colour is off', () => {
    // NO_COLOR, a pipe, or a dumb terminal must get plain text.
    expect(logoLines({ color: false }).join('')).not.toContain(ESC);
  });

  it('emits 24-bit colour when truecolor is available', () => {
    const out = logoLines({ color: true, truecolor: true }).join('');
    expect(out).toContain(ESC);
    expect(out).toMatch(/38;2;/);
  });

  it('uses the teal brand colour for the crossbar', () => {
    // 67,182,172 is #43b6ac. Positive control that the palette reaches the output.
    expect(logoLines({ color: true, truecolor: true }).join('')).toContain('38;2;67;182;172');
  });

  it('renders the mark WHITE on a dark background, never navy', () => {
    // Tom: the dark navy will not show on a dark terminal. F 4 R is the white knockout,
    // so the terminal mark follows it. Navy is 2,40,99 and must be absent when dark.
    const dark = logoLines({ color: true, truecolor: true, dark: true }).join('');
    expect(dark).toContain('38;2;255;255;255');
    expect(dark).not.toContain('38;2;2;40;99');
  });

  it('uses navy on a light background', () => {
    const light = logoLines({ color: true, truecolor: true, dark: false }).join('');
    expect(light).toContain('38;2;2;40;99');
  });
});

describe('banner', () => {
  it('shows the wordmark and the registered mark, not TM', () => {
    // Align is a REGISTERED trademark, so the correct symbol is the R one.
    const out = strip(banner({ version: '0.25.0', color: false }));
    expect(out).toContain('ALIGN');
    expect(out).toContain('®');
    expect(out).not.toContain('™');
  });

  it('shows the version', () => {
    expect(strip(banner({ version: '0.25.0', color: false }))).toContain('0.25.0');
  });

  it('sets the mark beside the wordmark, so the lockup is only the mark height', () => {
    expect(strip(banner({ version: '0.25.0', color: false })).split('\n')).toHaveLength(LOGO_ROWS);
  });

  it('carries the tagline from the brand pack', () => {
    expect(strip(banner({ version: '0.25.0', color: false }))).toMatch(/clarity/i);
  });
});

describe('commandIntro', () => {
  it('keeps the command label', () => {
    expect(strip(commandIntro('align setup', { color: false }))).toContain('align setup');
  });

  it('drops the off-brand magenta and blue the CLI used before', () => {
    // 15 intros were bgMagenta / bgBlue / unstyled. One helper, brand teal, everywhere.
    const out = commandIntro('align setup', { color: true, truecolor: true });
    expect(out).toContain('67;182;172');
    // eslint-disable-next-line no-control-regex -- ESC is the thing under test here
    expect(out).not.toMatch(/\x1b\[(45|44|105|104)m/);
  });
});
