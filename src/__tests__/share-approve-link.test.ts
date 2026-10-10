import { describe, expect, it } from 'vitest';
import { checkApproveLink } from '../lib/share/approve-link.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const KEY = 'A'.repeat(43);
const APP = 'https://app.align.test';
const link = (o = APP, id = ID, key = KEY): string => `${o}/share/approve/${id}#k=${key}`;

describe('checkApproveLink: the one gate between a link and a shell, a spawn or a QR', () => {
  it('accepts the link the CLI builds, for two different hosts and a localhost dev app', () => {
    expect(checkApproveLink(link(), APP)).toEqual({ ok: true, url: link() });
    expect(checkApproveLink(link('https://app.preview.align.tech'), 'https://app.preview.align.tech/').ok).toBe(true);
    expect(checkApproveLink(link('http://localhost:5173'), 'http://localhost:5173').ok).toBe(true);
  });
  it('refuses a host that is not the configured app, and http anywhere but localhost', () => {
    expect(checkApproveLink(link('https://evil.example'), APP).ok).toBe(false);
    expect(checkApproveLink(link('https://app.align.test.evil.example'), APP).ok).toBe(false);
    expect(checkApproveLink(link('http://app.align.test'), 'http://app.align.test').ok).toBe(false);
    expect(checkApproveLink(link('https://app.align.test:8443'), APP).ok).toBe(false);
  });
  it('refuses other schemes, userinfo and a javascript: link', () => {
    expect(checkApproveLink(`javascript:alert(1)//${ID}#k=${KEY}`, APP).ok).toBe(false);
    expect(checkApproveLink(link('ftp://app.align.test'), APP).ok).toBe(false);
    expect(checkApproveLink(link('https://user@app.align.test'), APP).ok).toBe(false);
    expect(checkApproveLink(link('https://app.align.test@evil.example'), APP).ok).toBe(false);
    expect(checkApproveLink(link('https://user:pw@app.align.test'), APP).ok).toBe(false);
  });
  it('refuses extra path segments, a query, and a missing or malformed id', () => {
    expect(checkApproveLink(`${APP}/share/approve/${ID}/extra#k=${KEY}`, APP).ok).toBe(false);
    expect(checkApproveLink(`${APP}/other/approve/${ID}#k=${KEY}`, APP).ok).toBe(false);
    expect(checkApproveLink(`${APP}/share/approve/${ID}?x=1#k=${KEY}`, APP).ok).toBe(false);
    expect(checkApproveLink(`${APP}/share/approve/#k=${KEY}`, APP).ok).toBe(false);
    expect(checkApproveLink(link(APP, 'not-a-uuid'), APP).ok).toBe(false);
    expect(checkApproveLink(link(APP, `${ID}x`), APP).ok).toBe(false);
  });
  it('refuses a key that is missing, one character short, one character long, or not base64url', () => {
    expect(checkApproveLink(`${APP}/share/approve/${ID}`, APP).ok).toBe(false);
    expect(checkApproveLink(link(APP, ID, 'A'.repeat(42)), APP).ok).toBe(false);
    expect(checkApproveLink(link(APP, ID, 'A'.repeat(44)), APP).ok).toBe(false);
    expect(checkApproveLink(link(APP, ID, `${'A'.repeat(42)}=`), APP).ok).toBe(false);
    expect(checkApproveLink(link(APP, ID, `${'A'.repeat(42)}+`), APP).ok).toBe(false);
    expect(checkApproveLink(`${APP}/share/approve/${ID}#k=${KEY}&x=1`, APP).ok).toBe(false);
  });
  it('refuses shell metacharacters, whitespace, newlines and control characters anywhere', () => {
    for (const bad of [';calc', '$(id)', '`id`', '|x', '&x', '"x', "'x", ' x', '\nx', '\rx', '\tx', '\u0000x', '\u001bx', '\u007fx', '%0a']) {
      expect(checkApproveLink(link(`https://app.align.test${bad}`), APP).ok, JSON.stringify(bad)).toBe(false);
      expect(checkApproveLink(`${link()}${bad}`, APP).ok, JSON.stringify(bad)).toBe(false);
      expect(checkApproveLink(link(APP, ID, `${'A'.repeat(42)}${bad}`), APP).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it('refuses a configured app URL that is itself odd, whatever the link says', () => {
    for (const odd of ['https://app.align.test;calc', 'https://app.align.test/ x', 'not a url', 'https://u@app.align.test', 'https://app.align.test"']) {
      expect(checkApproveLink(link(odd), odd).ok, odd).toBe(false);
    }
  });
  it('refuses an over-long link', () => {
    const origin = `https://${'a'.repeat(120)}.align.test`;
    expect(checkApproveLink(link(origin), origin).ok).toBe(false);
  });
});
