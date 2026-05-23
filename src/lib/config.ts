import Conf from 'conf';

export type EnvName = 'local' | 'preview' | 'prod';

export interface EnvironmentConfig {
  gatewayUrl: string;
  authToken: string | null;
  tenantId: string | null;
  ngrokUrl?: string;
  mode: 'demo' | 'auth';
}

const DEFAULTS: Record<EnvName, EnvironmentConfig> = {
  local:   { gatewayUrl: 'http://localhost:8080',          authToken: null, tenantId: null, mode: 'demo' },
  preview: { gatewayUrl: 'https://api.preview.align.tech', authToken: null, tenantId: null, mode: 'auth' },
  prod:    { gatewayUrl: 'https://api.align.tech',          authToken: null, tenantId: null, mode: 'auth' },
};

export function createConfigStore() {
  const store = new Conf<{ environments: Record<string, Partial<EnvironmentConfig>>; defaultEnv: EnvName }>({
    projectName: 'align-cli',
    defaults: { environments: {}, defaultEnv: 'prod' },
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
    clear(env: EnvName) {
      const envs = getEnvs();
      const { [env]: _, ...rest } = envs;
      store.set('environments', rest);
    },
  };
}
