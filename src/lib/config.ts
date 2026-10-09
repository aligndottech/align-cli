import Conf from 'conf';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mergeWrittenConfig, type WrittenConfig } from './safe-config-write.js';

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

/**
 * ALI-786: the one place the `local` env's default (unconfigured) gateway URL is spelled,
 * so the "you never ran a local setup" guard in gateway-client.ts compares against the
 * same literal DEFAULTS.local uses rather than a second copy of it (code-style.md, "two
 * writers of one fact").
 */
export const LOCAL_DEFAULT_GATEWAY_URL = DEFAULTS.local.gatewayUrl;

/**
 * ALI-618: local-only users have no account, so consent is stored on the machine, not the
 * server. 'granted' / 'declined' are the prompt's two answers and decide USAGE telemetry;
 * 'off' (ALI-954, written by `align telemetry off`) also stops the two default-on beacons -
 * the stored equivalent of `DO_NOT_TRACK=1`. See usage-telemetry.ts's localTierAllows.
 */
export type TelemetryConsent = 'granted' | 'declined' | 'off';

/**
 * One-time, idempotent: if the old suffixed config exists and the new one does not yet,
 * copy it across. `conf`'s default `projectSuffix: 'nodejs'` has been in effect since the
 * CLI's very first `align login`, so this is not a new-feature migration - it is real
 * historical state (cloud auth tokens, tenant ids, and any saved connector tokens) that
 * would otherwise be silently orphaned the moment config.ts starts reading the
 * suffix-free directory. The old file is left in place, never deleted, and an existing
 * file at the new location is never overwritten - this only ever fills a gap.
 *
 * Copilot review on #231: this used to run automatically inside createConfigStore(), so
 * every test that mocks `conf` but not `fs`/`env-paths` was touching the REAL filesystem
 * on whatever machine ran the suite - on a developer's own laptop, silently copying their
 * real ~/.config/align-cli-nodejs/config.json. A migration is a real-process-startup
 * concern, not a store-construction one: the constructor stays pure, and this is called
 * exactly once, from src/index.ts, before any command runs.
 */
export function migrateConfigDirectory(oldDir: string, newDir: string): void {
  const oldFile = path.join(oldDir, 'config.json');
  const newFile = path.join(newDir, 'config.json');
  if (fs.existsSync(newFile) || !fs.existsSync(oldFile)) return;
  fs.mkdirSync(newDir, { recursive: true });
  fs.copyFileSync(oldFile, newFile);
}

/**
 * The two free-tier providers `align setup` guides a user through (ALI-1284). Not the
 * full `AiProvider` union from local-llm.ts: this is specifically the pair the guided
 * setup step offers and persists, not a general secret store for every provider local-llm
 * already resolves from a plain env var.
 */
export type GuidedProviderKey = 'groq' | 'gemini';

const PROVIDER_ENV_VAR: Record<GuidedProviderKey, string> = {
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/**
 * Every real env var `local-llm.ts`'s `keyForProvider` accepts for this provider - not just
 * the primary name hydration writes to. Gemini has a second, equally real alias
 * (`GOOGLE_API_KEY`), checked there with `||` ahead of a stored value. Missing this (Copilot
 * review, PR #322) meant a user who exported only `GOOGLE_API_KEY` still got the STORED
 * Gemini key hydrated into `GEMINI_API_KEY`, which then won `keyForProvider`'s own `||` -
 * silently shadowing a real, deliberately-set credential with a possibly-stale stored one.
 */
const PROVIDER_ENV_ALIASES: Record<GuidedProviderKey, readonly string[]> = {
  groq: ['GROQ_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

/**
 * ALI-1284: fills `process.env` from a previously-saved provider key, so `align ask`
 * keeps working on every invocation after the one where `align setup` collected it -
 * without local-llm.ts (which resolves providers from plain env vars, and stays a
 * dependency-free pure module on purpose) ever knowing a config store exists.
 *
 * A real env var always wins and is never overwritten: this is a convenience default,
 * not a second source of truth, the same precedence `getEnvironment` already gives
 * ALIGN_TOKEN/ALIGN_TENANT_ID/ALIGN_GATEWAY_URL above. Checks every alias `keyForProvider`
 * itself accepts (not just the primary name), or hydrating the primary name from storage
 * would outrank a real credential the user set under an alias - see PROVIDER_ENV_ALIASES.
 * Called from the `preAction` Commander hook in cli.ts, before a command's own action runs
 * - never from module scope in index.ts, or a Conf store would be constructed (and its
 * defaults written to disk) for `align --version`, which startup-migration.test.ts pins as
 * untouched on a fresh machine. Never from inside createConfigStore() itself either, for the
 * same reason migrateConfigDirectory is split out (Copilot review, PR #231): a pure
 * constructor stays mockable without needing to stub `process.env` in every test that
 * merely constructs a store.
 */
export function hydrateProviderKeyEnv(
  config: { getProviderKey(provider: GuidedProviderKey): string | null },
  env: Record<string, string | undefined> = process.env,
): void {
  for (const [provider, varName] of Object.entries(PROVIDER_ENV_VAR) as Array<[GuidedProviderKey, string]>) {
    if (PROVIDER_ENV_ALIASES[provider].some((alias) => env[alias])) continue;
    const stored = config.getProviderKey(provider);
    if (stored) env[varName] = stored;
  }
}

export function createConfigStore() {
  const store = new Conf<{
    environments: Record<string, Partial<EnvironmentConfig>>;
    defaultEnv: EnvName;
    connectorTokens: Record<string, string>;
    installId?: string;
    telemetryConsent?: TelemetryConsent;
    agent?: string;
    launchOff?: boolean;
    refusedWrites?: string[];
    writtenConfigs?: Record<string, WrittenConfig>;
    funnelStagesRecorded?: string[];
    providerKeys?: Partial<Record<GuidedProviderKey, string>>;
  }>({
    projectName: 'align-cli',
    // conf's own default is 'nodejs' (node_modules/conf/dist/source/index.js), which
    // writes to ~/.config/align-cli-nodejs - a DIFFERENT directory from the one
    // local-mode.ts hand-computes for the local graph DB (~/.config/align-cli). Found
    // live: `rm -rf ~/.config/align-cli` silently left every saved token, telemetry
    // consent and auth config untouched, one directory over. Disabling the suffix
    // makes this match env-paths('align-cli', { suffix: '' }) - the same call
    // local-mode.ts now makes directly, so there is one authority, not two guesses.
    projectSuffix: '',
    defaults: { environments: {}, defaultEnv: 'prod', connectorTokens: {} },
    // This file holds the read-only tokens local mode asks for, so it is a credential file
    // rather than ordinary config. 0600 is also what the setup copy promises the user.
    configFileMode: 0o600,
  });

  const getEnvs = () => store.get('environments') as Record<string, Partial<EnvironmentConfig>>;
  const getTokens = () => store.get('connectorTokens') as Record<string, string>;

  // Extra fields (an Atlassian email, a GitLab domain) live beside the token under a `field:`
  // segment. The OAuth path already writes `<env>:<key>:cloudId` and `:siteBase` in this same
  // map, and the segment is what stops a connector field of either name colliding with them.
  const fieldPrefix = (env: EnvName, connectorKey: string) => `${env}:${connectorKey}:field:`;

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
    /**
     * Everything local mode collected for one connector: the token plus whatever extra fields
     * that connector asks for. `null` means nothing is stored, which is what setup uses to tell
     * "never connected" from "connected with a token and no extras" - GitHub is the second case,
     * and reading it as the first is how it ended up re-asking on every run (ALI-802).
     */
    getConnectorFields(env: EnvName, connectorKey: string): Record<string, string> | null {
      const tokens = getTokens();
      const token = tokens[`${env}:${connectorKey}`];
      if (token === undefined) return null;

      const prefix = fieldPrefix(env, connectorKey);
      const fields: Record<string, string> = { token };
      for (const [key, value] of Object.entries(tokens)) {
        if (key.startsWith(prefix)) fields[key.slice(prefix.length)] = value;
      }
      return fields;
    },
    saveConnectorFields(env: EnvName, connectorKey: string, fields: Record<string, string>) {
      const { token, ...extras } = fields;
      // An empty token would be stored as a connector that reads as saved and cannot be used:
      // setup's reuse check is truthy so it would ask again, while getConnectorFields and
      // `local forget` would both report a credential that is not there. Refuse it here, where
      // there is one writer, rather than teaching every reader to distrust the value.
      if (!token) throw new Error(`saveConnectorFields: ${connectorKey} needs a non-empty token`);
      const prefix = fieldPrefix(env, connectorKey);
      const updated = { ...getTokens(), [`${env}:${connectorKey}`]: token };
      for (const [name, value] of Object.entries(extras)) updated[`${prefix}${name}`] = value;
      store.set('connectorTokens', updated);
    },
    /** Drops every key this connector owns - token, extra fields, and any OAuth cloudId/siteBase. */
    forgetConnector(env: EnvName, connectorKey: string) {
      const owned = `${env}:${connectorKey}`;
      const kept = Object.fromEntries(
        Object.entries(getTokens()).filter(([key]) => key !== owned && !key.startsWith(`${owned}:`)),
      );
      store.set('connectorTokens', kept);
    },
    /** Every connector in one environment. The other environments' credentials are untouched. */
    forgetAllConnectors(env: EnvName) {
      const kept = Object.fromEntries(
        Object.entries(getTokens()).filter(([key]) => !key.startsWith(`${env}:`)),
      );
      store.set('connectorTokens', kept);
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
    // C1: the coding agent bare `align` launches. Stored as a plain string; the launcher
    // validates it against its closed list, so a stale value from a newer CLI is ignored.
    getAgent(): string | undefined {
      return store.get('agent');
    },
    setAgent(agent: string) {
      store.set('agent', agent);
      // Choosing an agent is the way back on after `align use --undo`.
      store.delete('launchOff');
    },
    // C4: set by `align use --undo` so bare `align` stops opening an agent (and re-adding the
    // configs just restored) until the user picks one again.
    isLaunchOff(): boolean {
      return store.get('launchOff') === true;
    },
    setLaunchOff(off: boolean) {
      if (off) store.set('launchOff', true);
      else store.delete('launchOff');
    },
    clearAgent() {
      store.delete('agent');
    },
    // C4: every other-product config file align wrote (safe-config-write.ts), so
    // `align use --undo` can put each one back. Keyed by absolute path; the whole map is
    // read and set as one value because conf treats a dot in a key as a path separator.
    getWrittenConfigs(): Record<string, WrittenConfig> {
      return store.get('writtenConfigs') ?? {};
    },
    // `entry` is what ONE write added; mergeWrittenConfig folds it into what is already here
    // (the first write's `created` and backup stay, owned entries accumulate).
    recordWrittenConfig(file: string, entry: WrittenConfig) {
      const all = store.get('writtenConfigs') ?? {};
      store.set('writtenConfigs', { ...all, [file]: mergeWrittenConfig(all[file], entry) });
    },
    /** Forget only the files whose undo finished; a skipped file keeps its record. */
    dropWrittenConfigs(files: string[]) {
      const all = { ...(store.get('writtenConfigs') ?? {}) };
      for (const f of files) delete all[f];
      if (Object.keys(all).length === 0) store.delete('writtenConfigs');
      else store.set('writtenConfigs', all);
    },
    // Refused writes (a symlinked agent config): remembered so the one-line notice is printed
    // once, not on every launch.
    wasWriteRefused(file: string): boolean {
      return (store.get('refusedWrites') ?? []).includes(file);
    },
    unmarkWriteRefused(file: string) {
      const all = store.get('refusedWrites') ?? [];
      store.set('refusedWrites', all.filter((f) => f !== file));
    },
    clearRefusedWrites() {
      store.delete('refusedWrites');
    },
    markWriteRefused(file: string) {
      const all = store.get('refusedWrites') ?? [];
      if (!all.includes(file)) store.set('refusedWrites', [...all, file]);
    },
    getTelemetryConsent(): TelemetryConsent | undefined {
      return store.get('telemetryConsent');
    },
    setTelemetryConsent(value: TelemetryConsent) {
      store.set('telemetryConsent', value);
    },
    // ALI-1284: the key `align setup`'s guided free-tier path collected, persisted the same
    // way a local connector's read-only token already is (saveConnectorFields above) - one
    // paste, reused on every later invocation. hydrateProviderKeyEnv is what reads this back
    // into process.env at startup; local-llm.ts itself stays a pure env-reader.
    getProviderKey(provider: GuidedProviderKey): string | null {
      return store.get('providerKeys')?.[provider] ?? null;
    },
    setProviderKey(provider: GuidedProviderKey, key: string) {
      const existing = store.get('providerKeys') ?? {};
      store.set('providerKeys', { ...existing, [provider]: key });
    },
    // ALI-1284 (Copilot review, PR #322): `align setup --reset` needs a real way to stop a
    // previously-stored key from coming back - hydrateProviderKeyEnv re-applies whatever is
    // stored on every invocation, so declining a re-offered key has to clear it, not just
    // skip re-asking for it.
    clearProviderKey(provider: GuidedProviderKey) {
      const existing = store.get('providerKeys') ?? {};
      const { [provider]: _removed, ...rest } = existing;
      store.set('providerKeys', rest);
    },
    // ALI-795: which one-shot funnel stages this install has already emitted. Per-install
    // like installId (a funnel counts an install once); the emitter consults it so the
    // guard has exactly one enforcement point rather than one per call site.
    wasFunnelStageRecorded(stage: string): boolean {
      return (store.get('funnelStagesRecorded') ?? []).includes(stage);
    },
    markFunnelStageRecorded(stage: string): void {
      const existing = store.get('funnelStagesRecorded') ?? [];
      if (!existing.includes(stage)) store.set('funnelStagesRecorded', [...existing, stage]);
    },
  };
}
