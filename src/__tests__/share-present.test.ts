import { describe, expect, it } from 'vitest';
import { type DeliveryPlan, osc52, type PresentDeps, presentLink } from '../lib/share/delivery.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const APP = 'https://app.align.test';
const LINK = `${APP}/share/approve/${ID}#k=${'C'.repeat(43)}`;
const plan = (o: Partial<DeliveryPlan>): DeliveryPlan => ({ open: false, qr: false, qrIfOpenFails: false, why: 't', ...o });

function rig(p: DeliveryPlan, o: Partial<PresentDeps> = {}) {
  const out: string[] = []; const raw: string[] = []; const opened: string[] = []; const copied: string[] = [];
  const deps: PresentDeps = {
    appUrl: APP, plan: p, out: (l) => out.push(l), raw: (l) => raw.push(l),
    openUrl: async (u) => { opened.push(u); return true; },
    qr: () => ({ lines: ['QR-1', 'QR-2'], columns: 40 }),
    copy: undefined, ...o,
  };
  if (o.copy) deps.copy = (u) => { copied.push(u); o.copy!(u); };
  return { deps, out, raw, opened, copied, all: () => [...out, ...raw].join('\n') };
}

describe('presentLink', () => {
  it('opens and stops there: no QR, no instructions', async () => {
    const r = rig(plan({ open: true }));
    await presentLink(LINK, r.deps);
    expect(r.opened).toEqual([LINK]); expect(r.raw).toEqual([]); expect(r.out).toEqual([]);
  });
  it('QR only: the QR lines go to the raw channel, nothing opens, and the three ways are explained', async () => {
    const r = rig(plan({ qr: true }));
    await presentLink(LINK, r.deps);
    expect(r.opened).toEqual([]); expect(r.raw).toEqual(['QR-1', 'QR-2']);
    expect(r.out.join('\n')).toMatch(/scan the QR code with your phone/);
    expect(r.out.join('\n')).toMatch(/Face ID or a fingerprint/);
  });
  it('neither: no QR and no open, but still says how to open the link', async () => {
    const r = rig(plan({}));
    await presentLink(LINK, r.deps);
    expect(r.opened).toEqual([]); expect(r.raw).toEqual([]);
    expect(r.out.join('\n')).toMatch(/open the link above/);
    expect(r.out.join('\n')).not.toMatch(/scan the QR/);
  });
  it('a failed open says so and falls back to the QR when one is allowed, and to the text when it is not', async () => {
    const a = rig(plan({ open: true, qrIfOpenFails: true }), { openUrl: async () => false });
    await presentLink(LINK, a.deps);
    expect(a.out.join('\n')).toContain('Could not open a browser here.'); expect(a.raw).toEqual(['QR-1', 'QR-2']);
    const b = rig(plan({ open: true, qrIfOpenFails: false }), { openUrl: async () => false });
    await presentLink(LINK, b.deps);
    expect(b.out.join('\n')).toContain('Could not open a browser here.'); expect(b.raw).toEqual([]);
  });
  it('a link that fails the allowlist is neither opened nor drawn', async () => {
    for (const bad of [`https://evil.example/share/approve/${ID}#k=${'C'.repeat(43)}`, `${LINK}x`, `${LINK}\n`]) {
      const r = rig(plan({ open: true, qr: true }));
      await presentLink(bad, r.deps);
      expect(r.opened).toEqual([]); expect(r.raw).toEqual([]);
      expect(r.out.join('\n')).toBe('This link is not in the expected form, so it was not opened and no QR code was made. If you trust this server, copy the link yourself.');
    }
  });
  it('a terminal narrower than the QR gets a sentence, not a wrapped code; a wide enough one gets the code', async () => {
    const narrow = rig(plan({ qr: true }), { columns: 39 });
    await presentLink(LINK, narrow.deps);
    expect(narrow.raw).toEqual([]); expect(narrow.out.join('\n')).toMatch(/39 columns wide and the QR code needs 40/);
    const exact = rig(plan({ qr: true }), { columns: 40 });
    await presentLink(LINK, exact.deps);
    expect(exact.raw).toEqual(['QR-1', 'QR-2']);
  });
  it('copy runs only when it is provided, and says it may not have worked', async () => {
    const off = rig(plan({ qr: true })); await presentLink(LINK, off.deps); expect(off.copied).toEqual([]);
    const on = rig(plan({ qr: true }), { copy: () => undefined }); await presentLink(LINK, on.deps);
    expect(on.copied).toEqual([LINK]); expect(on.out.join('\n')).toMatch(/Not every terminal allows it/);
  });
});

describe('osc52: the clipboard sequence is written to a terminal and nowhere else', () => {
  it('encodes the whole link for a terminal', () => {
    const s = osc52(LINK, true)!;
    expect(s.startsWith('\u001b]52;c;') && s.endsWith('\u0007')).toBe(true);
    expect(Buffer.from(s.slice(7, -1), 'base64').toString()).toBe(LINK);
  });
  it('is null when stdout is not a terminal, and for a link that fails the shape check', () => {
    expect(osc52(LINK, false)).toBeNull();
    expect(osc52(`${LINK}\u001b]0;x`, true)).toBeNull();
  });
});
