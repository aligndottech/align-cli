import Conf from 'conf';
import { randomUUID } from 'node:crypto';

export type EnvName = 'local' | 'preview' | 'prod';

export interface EnvironmentConfig {
  gatewayUrl: string;
  authToken: string | null;
  tenantId: string | null;
  ngrokUrl?: string;
  mode: 'demo' | 'auth' | 'local-embedded';
  localDbPath?: string;
}

const DEFAULTS: Record<EnvName, EnvironmentConfig> = {
  local:   { gatewayUrl: 'http://localhost:8080',          authToken: null, tenantId: null, mode: 'demo' },
  preview: { gatewayUrl: 'https://api.preview.align.tech', authToken: null, tenantId: null, mode: 'auth' },
  prod:    { gatewayUrl: 'https://api.align.tech',          authToken: null, tenantId: null, mode: 'auth' },
};

/**
 * ALI-618: local-embedded mode never makes an HTTP call for its own operations (it reads a
 * local embedded DB - see gateway-client.ts's `createLocalGatewayClient` branch), so the
 * `local` env's `gatewayUrl` above (`http://localhost:8080`) is a leftover from the unrelated
 * self-hosted `demo` mode and nothing real listens there. The anonymous usage ping
 * (usage-telemetry.ts) has to reach somewhere real regardless of which env resolved to
 * local-embedded, so it targets this - Align's actual hosted API, same single source of truth
 * as `DEFAULTS.prod.gatewayUrl` rather than a second literal of the same URL.
 */
export const ALIGN_HOSTED_GATEWAY_URL = DEFAULTS.prod.gatewayUrl;

/** ALI-618: local-only users have no account, so consent is stored on the machine, not the server. */
export type TelemetryConsent = 'granted' | 'declined';

export function createConfigStore() {
  const store = new Conf<{
    environments: Record<string, Partial<EnvironmentConfig>>;
    defaultEnv: EnvName;
    connectorTokens: Record<string, string>;
    installId?: string;
    telemetryConsent?: TelemetryConsent;
  }>({
    projectName: 'align-cli',
    defaults: { environments: {}, defaultEnv: 'prod', connectorTokens: {} },
  });

  const getEnvs = () => store.get('environments') as Record<string, Partial<EnvironmentConfig>>;

  return {
    getEnvironment(env: EnvName): EnvironmentConfig {
      const base = { ...DEFAULTS[env], ...(getEnvs()[env] ?? {}) };
      // Env var overrides - useful for CI and self-hosted deployments
      if (!base.authToken && process.env['ALIGN_TOKEN']) {
        base.authToken = process.env['ALIGN_TOKEN'];
      }
      if (!base.tenantId && process.env['ALIGN_TENANT_ID']) {
        base.tenantId = process.env['ALIGN_TENANT_ID'];
      }
      if (process.env['ALIGN_GATEWAY_URL']) {
        base.gatewayUrl = process.env['ALIGN_GATEWAY_URL'];
      }
      return base;
    },
    setAuthToken(env: EnvName, token: string) {
      const envs = getEnvs();
      store.set('environments', { ...envs, [env]: { ...(envs[env] ?? {}), authToken: token } });
    },
    setTenantId(env: EnvName, tenantId: string) {
      const envs = getEnvs();
      store.set('environments', { ...envs, [env]: { ...(envs[env] ?? {}), tenantId } });
    },
    setNgrokUrl(url: string) {
      const envs = getEnvs();
      store.set('environments', { ...envs, local: { ...(envs['local'] ?? {}), ngrokUrl: url } });
    },
    setDefaultEnv(env: EnvName) { store.set('defaultEnv', env); },
    getDefaultEnv(): EnvName { return store.get('defaultEnv') as EnvName; },
    getConnectorToken(env: EnvName, connectorKey: string): string | null {
      const tokens = store.get('connectorTokens') as Record<string, string>;
      return tokens[`${env}:${connectorKey}`] ?? null;
    },
    setConnectorToken(env: EnvName, connectorKey: string, token: string) {
      const tokens = store.get('connectorTokens') as Record<string, string>;
      store.set('connectorTokens', { ...tokens, [`${env}:${connectorKey}`]: token });
    },
    getConnectorCloudId(env: EnvName, connectorKey: string): string | null {
      const tokens = store.get('connectorTokens') as Record<string, string>;
      return tokens[`${env}:${connectorKey}:cloudId`] ?? null;
    },
    setConnectorCloudId(env: EnvName, connectorKey: string, cloudId: string) {
      const tokens = store.get('connectorTokens') as Record<string, string>;
      store.set('connectorTokens', { ...tokens, [`${env}:${connectorKey}:cloudId`]: cloudId });
    },
    getConnectorSiteBase(env: EnvName, connectorKey: string): string | null {
      const tokens = store.get('connectorTokens') as Record<string, string>;
      return tokens[`${env}:${connectorKey}:siteBase`] ?? null;
    },
    setConnectorSiteBase(env: EnvName, connectorKey: string, siteBase: string) {
      const tokens = store.get('connectorTokens') as Record<string, string>;
      store.set('connectorTokens', { ...tokens, [`${env}:${connectorKey}:siteBase`]: siteBase });
    },
    setLocalMode(dbPath: string) {
      const envs = getEnvs();
      store.set('environments', { ...envs, local: { ...(envs['local'] ?? {}), mode: 'local-embedded', localDbPath: dbPath } });
    },
    clearLocalMode() {
      const envs = getEnvs();
      const updated: Partial<EnvironmentConfig> = { ...(envs['local'] ?? {}) };
      delete updated.localDbPath;
      updated.mode = 'demo';
      store.set('environments', { ...envs, local: updated });
    },
    clear(env: EnvName) {
      const envs = getEnvs();
      const { [env]: _, ...rest } = envs;
      store.set('environments', rest);
    },
    // ALI-618: global to the machine's install, not per-environment - unlike authToken/tenantId,
    // an anonymous local-mode user has no account for either to belong to. Generated once and
    // persisted, never derived from anything identifying (no hostname, no MAC address).
    getInstallId(): string {
      const existing = store.get('installId');
      if (existing) return existing;
      const id = randomUUID();
      store.set('installId', id);
      return id;
    },
    getTelemetryConsent(): TelemetryConsent | undefined {
      return store.get('telemetryConsent');
    },
    setTelemetryConsent(value: TelemetryConsent) {
      store.set('telemetryConsent', value);
    },
  };
}
