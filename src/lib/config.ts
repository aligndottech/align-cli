import Conf from 'conf';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mergeWrittenConfig, type WrittenConfig } from './safe-config-write.js';
import { STORABLE_PROVIDERS, type StoredProviderId } from './llm-providers.js';

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
 * The providers a key can be saved for (ALI-1284 started with Groq and Gemini; the first-ask
 * prompt and `align ai` save any of them). The name is kept for the callers that predate the
 * widening.
 */
export type GuidedProviderKey = StoredProviderId;

/** The stored `align ask` provider preference (`align ai`). Both fields optional. */
export interface LlmPreference { provider?: string; model?: string }

/**
 * Saved provider keys and the saved preference, as data for local-llm's setSavedLlmSource.
 * cli.ts installs it; local-llm reads it on every call. Never written to process.env (H1):
 * every child process inherits process.env, including the coding agent bare `align` opens.
 */
export function savedLlmConfig(config: {
  getProviderKey(provider: GuidedProviderKey): string | null;
  getLlmPreference(): LlmPreference;
}): { keys: Partial<Record<GuidedProviderKey, string>>; provider?: string; model?: string } {
  const keys: Partial<Record<GuidedProviderKey, string>> = {};
  for (const p of STORABLE_PROVIDERS) {
    const k = config.getProviderKey(p);
    if (k) keys[p] = k;
  }
  return { keys, ...config.getLlmPreference() };
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
    llm?: LlmPreference;
    askKeyOfferDismissed?: boolean;
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
    // paste, reused on every later invocation. savedLlmConfig hands it to local-llm as data;
    // it is never written into process.env.
    getProviderKey(provider: GuidedProviderKey): string | null {
      return store.get('providerKeys')?.[provider] ?? null;
    },
    setProviderKey(provider: GuidedProviderKey, key: string) {
      const existing = store.get('providerKeys') ?? {};
      store.set('providerKeys', { ...existing, [provider]: key });
    },
    // ALI-1284 (Copilot review, PR #322): `align setup --reset` needs a real way to stop a
    // previously-stored key from coming back - local-llm reads whatever is stored on every
    // call, so clearing is the only way to stop a saved key being used.
    clearProviderKey(provider: GuidedProviderKey) {
      const existing = store.get('providerKeys') ?? {};
      const { [provider]: _removed, ...rest } = existing;
      store.set('providerKeys', rest);
    },
    // `align ai`: which provider (and optionally model) `align ask` tries first. An exported
    // ALIGN_LLM_PROVIDER wins (preferredProvider in local-llm.ts).
    getLlmPreference(): LlmPreference {
      return store.get('llm') ?? {};
    },
    setLlmPreference(pref: LlmPreference) {
      store.set('llm', pref);
    },
    clearLlmPreference() {
      store.delete('llm');
    },
    // The first-ask key offer's "Not now", remembered so `align ask` does not ask every run.
    // `align setup --reset` clears it; `align ai` is the way back in without a reset.
    isAskKeyOfferDismissed(): boolean {
      return store.get('askKeyOfferDismissed') === true;
    },
    setAskKeyOfferDismissed(dismissed: boolean) {
      if (dismissed) store.set('askKeyOfferDismissed', true);
      else store.delete('askKeyOfferDismissed');
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
