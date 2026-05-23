import { describe, expect, it } from 'vitest';
import { resolveAppUrl, resolveOAuthRedirectUri, resolveWebhookUrl } from '../lib/env-resolver.js';

const local = {
  gatewayUrl: 'http://localhost:8080',
  authToken: null,
  tenantId: null,
  mode: 'demo' as const,
};
const localNgrok = { ...local, ngrokUrl: 'https://abc.ngrok-free.app' };
const preview = {
  gatewayUrl: 'https://api.preview.align.tech',
  authToken: null,
  tenantId: null,
  mode: 'auth' as const,
};

describe('env resolver', () => {
  it('redirect URI uses ngrok when available', () => {
    expect(resolveOAuthRedirectUri('slack', localNgrok)).toBe(
      'https://abc.ngrok-free.app/oauth/callback/slack',
    );
  });

  it('redirect URI uses localhost when no ngrok', () => {
    expect(resolveOAuthRedirectUri('slack', local)).toBe(
      'http://localhost:8080/oauth/callback/slack',
    );
  });

  it('redirect URI uses cloud URL for preview', () => {
    expect(resolveOAuthRedirectUri('slack', preview)).toBe(
      'https://api.preview.align.tech/oauth/callback/slack',
    );
  });

  it('webhook URL uses ngrok when available', () => {
    expect(resolveWebhookUrl('slack', localNgrok)).toBe(
      'https://abc.ngrok-free.app/webhook/slack/events',
    );
  });

  it('app URL replaces api. prefix with app.', () => {
    expect(resolveAppUrl(preview)).toBe('https://app.preview.align.tech');
  });

  it('app URL for prod', () => {
    const prod = { ...preview, gatewayUrl: 'https://api.align.tech' };
    expect(resolveAppUrl(prod)).toBe('https://app.align.tech');
  });
});
