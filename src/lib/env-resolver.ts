import type { EnvironmentConfig } from './config.js';

export function resolveOAuthRedirectUri(connectorKey: string, env: EnvironmentConfig): string {
  const base = env.ngrokUrl ?? env.gatewayUrl;
  return `${base}/oauth/callback/${connectorKey}`;
}

export function resolveWebhookUrl(connectorKey: string, env: EnvironmentConfig): string {
  const base = env.ngrokUrl ?? env.gatewayUrl;
  return `${base}/webhook/${connectorKey}/events`;
}

export function resolveAppUrl(env: EnvironmentConfig): string {
  if (env.gatewayUrl.includes('localhost')) return 'http://localhost:5173';
  return env.gatewayUrl.replace('://api.', '://app.');
}
