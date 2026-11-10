import { describe, expect, it } from 'vitest';
import { banner, BRAND, commandIntro, MARK, TAGLINE_ACCENT, TAGLINE_LINES } from '../lib/brand.js';

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

describe('the header', () => {
  // Tom, 10 Nov: the 7-row block A looked bad next to Claude Code and Codex. The header is
  // now a teal triangle, the name and version, and the tagline: three rows, no pixel art.
  const plain = (o: Partial<Parameters<typeof banner>[0]> = {}) =>
    strip(banner({ version: '1.2.3', color: false, ...o })).split('\n');

  it('is three rows: mark, name and version, then the two tagline lines', () => {
    expect(plain()).toEqual([
      `${MARK}  Align® v1.2.3`,
      '   Your AI agents know the code.',
      "   They don't know the company.",
    ]);
  });

  it('indents the tagline three columns, under the name and in line with the prompt rail below', () => {
    // The setup prompts draw "│  " down the left, so their text starts at column 3.
    const [first, second] = plain();
    expect((first as string).indexOf('Align')).toBe(3);
    expect((second as string).indexOf('Your')).toBe(3);
  });

  it('paints the mark teal and leaves it plain with colour off', () => {
    const out = banner({ version: '1.2.3', color: true, truecolor: true, dark: true });
    expect(out.split('\n')[0]).toContain(`\x1b[38;2;67;182;172m${MARK}`);
    expect(banner({ version: '1.2.3', color: false })).not.toContain(ESC);
  });

  it('uses 256 colours when truecolor is not available', () => {
    expect(banner({ version: '1.2.3', color: true, truecolor: false, dark: true })).toMatch(/38;5;79m/);
  });

  it('sets the name bold and the version dim', () => {
    const first = banner({ version: '1.2.3', color: true, truecolor: true, dark: true }).split('\n')[0] as string;
    expect(first).toContain('\x1b[1mAlign®');
    expect(first).toContain('\x1b[2mv1.2.3');
  });

  it('writes the tagline white on a dark terminal and navy on a light one', () => {
    const line = (dark: boolean) => banner({ version: '1.2.3', color: true, truecolor: true, dark }).split('\n')[1] as string;
    expect(line(true)).toContain('38;2;255;255;255');
    expect(line(true)).not.toContain('38;2;2;40;99');
    expect(line(false)).toContain('38;2;2;40;99');
  });
});

describe('banner', () => {
  it('shows the wordmark and the registered mark, not TM', () => {
    // Align is a REGISTERED trademark, so the correct symbol is the R one.
    const out = strip(banner({ version: '0.25.0', color: false }));
    expect(out).toContain('Align');
    expect(out).toContain('®');
    expect(out).not.toContain('™');
  });

  it('shows the version', () => {
    expect(strip(banner({ version: '0.25.0', color: false }))).toContain('0.25.0');
  });

  it('carries the LIVE positioning line, not the retired tagline', () => {
    // 'Collaboration with clarity built in' is retired. The live line is the frontend
    // hero (align-frontend src/lib/seo.ts), and it is two lines.
    const out = strip(banner({ version: '0.25.0', color: false }));
    expect(out).toContain('Your AI agents know the code.');
    expect(out).toContain("They don't know the company.");
    expect(out).not.toMatch(/clarity built in/i);
  });
});

describe('the headline follows align-frontend, not a flat teal block', () => {
  // The site puts <span class="accent"> on "don't know the company." only; the rest of
  // the h1 takes the heading colour. Rendering both lines teal (the first version) is a
  // different design from the one the site ships.
  const WHITE = '38;2;255;255;255';
  const TEAL = '38;2;67;182;172';
  const lineWith = (needle: string) =>
    banner({ version: '1.2.3', color: true, truecolor: true, dark: true })
      .split('\n')
      // eslint-disable-next-line no-control-regex -- ESC is the thing under test here
      .find((l) => l.replace(/\x1b\[[0-9;]*m/g, '').includes(needle)) ?? '';

  it('renders the first headline line in the heading colour, not teal', () => {
    const line = lineWith('know the code');
    expect(line).toContain(WHITE);
    // The teal mark is on the row above, so teal here could only come from the text.
    expect(line).not.toContain(TEAL);
  });

  it('splits the second line, colouring only the accent phrase', () => {
    const line = lineWith('know the company');
    expect(line).toContain(WHITE);   // "They "
    expect(line).toContain(TEAL);    // "don't know the company."
  });

  it('puts the accent boundary exactly where the site puts it', () => {
    const [lead] = TAGLINE_LINES[1].split(TAGLINE_ACCENT);
    expect(lead).toBe('They ');
  });
});

describe('the banner claims nothing it cannot know', () => {
  it('shows the version and no graph label', () => {
    // The banner prints BEFORE either caller knows which graph is in play:
    // setup.ts:527 runs before the cloud/local decision at 535, and
    // default-action.ts:28 runs before hasLocal/hasCloud are read at 34-35. A
    // "local graph" style context line was therefore unfillable by construction,
    // and naming the wrong graph is worse than naming none - a personal cloud user
    // told they are local would reasonably conclude their data never left the
    // machine. Tom caught this on 2026-08-31 reading a preview.
    const out = strip(banner({ version: '9.9.9', color: false }));
    expect(out).toContain('v9.9.9');
    expect(out).not.toMatch(/local graph|personal cloud|preview/i);
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
