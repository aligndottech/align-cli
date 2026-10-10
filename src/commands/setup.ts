import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { tryOpenUrl } from '../lib/open-url.js';
import { execa } from 'execa';
import { clearScreenForPicker, CLI_TOKEN_SOURCES, cliTokenDecision, detectVerifiedCliToken, pickerMaxItems } from '../lib/setup-ux.js';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { type PersonalImportItem, runPersonalImport, runWithConcurrency } from '../lib/personal-import.js';
import { connectDetectedAgents } from './connect-agents.js';
import { setupAgentAlignment } from '../lib/agent-rules.js';
import { isGitRepo } from '../lib/git.js';
import { currentRepoIdentity } from '../lib/repo-identity.js';
import { fetchDocsItems } from '../lib/fetchers/docs.js';
import { createLocalDb } from '../lib/local-db.js';
import { buildFoundSummary, renderFoundSummary } from '../lib/found-summary.js';
import { createCaptureCollector, toCaptureSource } from '../lib/capture-report.js';
import type { CaptureFetchResult } from '../lib/fetchers/capture.js';
import { CAPTURE_SOURCES } from '../lib/capture-sources.js';
import { GIT_DEFAULT_LIMIT, SYNC_CEILINGS, SYNC_WINDOW_DEFAULT_DAYS } from '../lib/import-defaults.js';
import { fetchWindow, parseSince, type SyncWindow, windowLabel } from '../lib/since.js';
import { initLocalMode } from '../lib/local-mode.js';
import { loginInteractive } from '../lib/login-flow.js';
import { resolveAppUrl } from '../lib/env-resolver.js';
import { collectTokensViaOAuth, oauthFlowLabel } from '../lib/personal-oauth.js';
import { isAuthExpiry } from '../lib/errors.js';
import { commandIntro } from '../lib/brand.js';
import pkg from '../../package.json' with { type: 'json' };
const { version } = pkg;
import { printBanner } from '../lib/brand.js';
import { guardedPrompt } from '../lib/prompt-guard.js';
import { setupSummaryLine, unresolvedGaps } from '../lib/connect-prompt.js';
import { createSetupFunnel, type SetupFunnel } from '../lib/setup-funnel.js';
import { agentAskLine, agentConnectedLine, firstQuestion, orderAgents, projectAgentsFromWritten } from '../lib/next-step.js';
import { projectForeignNotice } from '../lib/foreign-env.js';
import { PICK_CANCELLED, pickAgent } from '../lib/launch/pick-agent.js';
import { InvalidEnvError, routeSetup } from '../lib/setup-route.js';
import { agentByName } from '../lib/launch/agents.js';
import { launchesAfterWizard } from '../lib/launch/launch.js';
import { PROVIDER_LABEL, STORABLE_PROVIDERS } from '../lib/llm-providers.js';
import type { LaunchAgentId } from '../lib/launch/registry/types.js';
import { firstDecision } from '../lib/first-decision.js';

// ---------------------------------------------------------------------------
// Source definitions
// ---------------------------------------------------------------------------

// Connector OAuth scope tier, used to order the multiselect so a solo dev hits
// the frictionless personal-account connectors first:
//  - 'personal':  connect your own account, no admin (GitHub, GitLab, Linear, Notion, Zoom)
//  - 'site':      Atlassian 3LO - per-user consent, scoped to sites you belong to (Jira, Confluence)
//  - 'workspace': needs a workspace/org admin install (Slack, Teams)
type ConnectorTier = 'personal' | 'site' | 'workspace';
const TIER_ORDER: Record<ConnectorTier, number> = { personal: 0, site: 1, workspace: 2 };

// How many connectors import concurrently after auth. Each import is itself
// batch-parallel (runPersonalImport), so this bounds total gateway load.
const IMPORT_CONCURRENCY = 4;

interface SetupSource {
  id: string;
  label: string;
  description: string;
  tier?: ConnectorTier;
  oauthKey?: string;  // If set, uses browser OAuth flow via /oauth/cli-start/:key
  // When set, the connector uses OAuth (oauthKey) only if the named field is left
  // blank (the SaaS default host); a non-blank value (a self-managed host) falls
  // back to the token-paste path. GitLab: gitlab.com → OAuth, self-managed → PAT.
  hostGatedOAuth?: { field: string };
  tokenLabel?: string;
  tokenHint?: string;
  /** The pasted token expires within hours (a Graph access token), so a saved one is usually
   *  dead by the next run: the re-import question defaults to pasting a fresh one. */
  tokenShortLived?: true;
  tokenUrl?: string | ((tokens: Record<string, string>) => string);  // If set, auto-opens this URL in the browser before prompting for the token
  extraFields?: Array<{ key: string; label: string; hint?: string; secret?: boolean }>;
  /** What one fetched item IS, for the capture report (ALI-827) - from CAPTURE_SOURCES. */
  unit: string;
  /** L3: `window` defaults to the plan's six months; `align connect --since` passes its own. */
  fetch: (tokens: Record<string, string>, window?: SyncWindow) => Promise<CaptureFetchResult>;
}

function buildSources(gitAvailable: boolean): SetupSource[] {
  const sources: SetupSource[] = [];

  if (gitAvailable) {
    sources.push({
      id: 'git',
      ...CAPTURE_SOURCES.git,
      description: 'Commit history from this repo - no token needed',
      fetch: async () => {
        const { fetchGitItems } = await import('../lib/fetchers/git.js');
        // The newest commits however old, as before the window (GIT_DEFAULT_LIMIT); only --since changes it.
        return fetchGitItems({ limit: GIT_DEFAULT_LIMIT });
      },
    });
  }

  sources.push(
    {
      id: 'github',
      ...CAPTURE_SOURCES.github,
      description: 'Your PRs and issues',
      tier: 'personal',
      oauthKey: 'github-personal',
      // Token-paste metadata is used only by local mode (cloud uses oauthKey/OAuth).
      tokenLabel: 'Personal access token',
      // The page opens with every permission pre-selected read-only via GitHub's
      // documented query-param pre-fill - choosing scopes was the manual work, so the
      // URL does it. The test pins each param as `read`, so an edit to `write` goes
      // red rather than into review.
      tokenHint: 'Everything is pre-selected (read-only). Click Generate token, then copy it here',
      tokenUrl:
        'https://github.com/settings/personal-access-tokens/new' +
        '?name=Align+CLI+%28read-only%29' +
        '&description=Read-only+import+of+your+PRs+and+issues+into+your+local+Align+graph' +
        '&expires_in=90' +
        '&contents=read&issues=read&pull_requests=read',
      fetch: async (t, w = parseSince(undefined)) => {
        const { fetchGitHubItems, resolveGitHubRepoScope } = await import('../lib/fetchers/github.js');
        // ALI-917: this interactive source has no --repo/--all of its own, so it takes
        // resolveGitHubRepoScope's auto-detect-only path (an empty opts object) - the
        // same default `align connect github` uses. Without it, a token spanning several
        // unrelated repos returns everything across all of them, undifferentiated.
        const repo = await resolveGitHubRepoScope({});
        // L3: items first, then discussion inline up to a request budget (fetchGitHubItems); inside a repo, everyone's items in it.
        return fetchGitHubItems({ token: t['token']!, ...fetchWindow('github', w), ...(repo ? { repo, scope: 'team' as const } : {}) });
      },
    },
    {
      id: 'jira',
      ...CAPTURE_SOURCES.jira,
      description: 'Your issues',
      tier: 'site',
      // Personal/CLI tier is read-only (no write:jira-work). The team/org
      // comment bot keeps write via the `jira` key. See ALI-94.
      oauthKey: 'jira-personal',
      // Local-mode token paste (read-only Atlassian API token + email + site).
      tokenLabel: 'API token',
      tokenHint: 'Click Create API token, name it anything, then copy it here',
      tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      extraFields: [
        { key: 'email', label: 'Atlassian account email' },
        { key: 'domain', label: 'Atlassian domain (yourorg.atlassian.net)' },
      ],
      fetch: async (t, w = parseSince(undefined)) => {
        const { fetchJiraItems } = await import('../lib/fetchers/jira.js');
        return fetchJiraItems({ token: t['token']!, cloudId: t['cloudId'], email: t['email'], domain: t['domain'], ...fetchWindow('jira', w) });
      },
    },
    {
      id: 'confluence',
      ...CAPTURE_SOURCES.confluence,
      description: 'Your pages and documentation',
      tier: 'site',
      // Read-only personal/CLI tier. See ALI-94.
      oauthKey: 'confluence-personal',
      // Local-mode token paste (read-only Atlassian API token + email + site).
      tokenLabel: 'API token',
      tokenHint: 'Click Create API token, name it anything, then copy it here',
      tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      extraFields: [
        { key: 'email', label: 'Atlassian account email' },
        { key: 'domain', label: 'Atlassian domain (yourorg.atlassian.net)' },
      ],
      fetch: async (t, w = parseSince(undefined)) => {
        const { fetchConfluenceItems } = await import('../lib/fetchers/confluence.js');
        return fetchConfluenceItems({ token: t['token']!, cloudId: t['cloudId'], email: t['email'], domain: t['domain'], ...fetchWindow('confluence', w) });
      },
    },
    {
      id: 'slack',
      ...CAPTURE_SOURCES.slack,
      description: 'Decision threads from your channels - may need workspace admin [experimental]',
      tier: 'workspace',
      // Read-only personal/CLI tier (no chat:write). The team/org bot keeps
      // chat:write via the `slack` key. See ALI-94.
      oauthKey: 'slack-personal',
      // Local-mode token paste: a Slack user token (xoxp-) with read scopes only.
      tokenLabel: 'User token (xoxp-...)',
      tokenHint: 'User token with read scopes only: channels:read, channels:history, groups:read, groups:history',
      tokenUrl: 'https://api.slack.com/apps',
      fetch: async (t, w = parseSince(undefined)) => {
        const { fetchSlackItems } = await import('../lib/fetchers/slack.js');
        return fetchSlackItems({ token: t['token']!, ...fetchWindow('slack', w) });
      },
    },
    {
      id: 'teams',
      ...CAPTURE_SOURCES.teams,
      description: 'Channel messages and decisions - may need org/workspace admin consent',
      tier: 'workspace',
      oauthKey: 'teams',
      // Local mode: a Graph access token the user copies from Graph Explorer is a token a
      // person mints themselves, which is the local-mode rule. Until this, Teams was
      // excluded from local setup outright, so "re-run setup and add Teams" was impossible
      // by construction and the only path (align import teams --token) saved nothing.
      tokenLabel: 'Microsoft Graph access token',
      tokenHint:
        'Sign in to Graph Explorer, open the "Access token" tab and copy it. Reading channel messages ' +
        'needs ChannelMessage.Read.All, which your Microsoft 365 admin may have to consent to. ' +
        'The token expires after about an hour; re-run setup to paste a fresh one.',
      tokenUrl: 'https://developer.microsoft.com/en-us/graph/graph-explorer',
      tokenShortLived: true,
      fetch: async (t, w = parseSince(undefined)) => {
        const { fetchTeamsItems } = await import('../lib/fetchers/teams.js');
        return fetchTeamsItems({ token: t['token']!, ...fetchWindow('teams', w) });
      },
    },
    {
      id: 'zoom',
      ...CAPTURE_SOURCES.zoom,
      description: 'Cloud recording transcripts from your meetings',
      tier: 'personal',
      oauthKey: 'zoom',
      fetch: async (t, w = parseSince(undefined)) => {
        const { fetchZoomItems } = await import('../lib/fetchers/zoom.js');
        return fetchZoomItems({ token: t['token']!, ...fetchWindow('zoom', w) });
      },
    },
    {
      id: 'gitlab',
      ...CAPTURE_SOURCES.gitlab,
      description: 'Your merge requests',
      tier: 'personal',
      // gitlab.com → read-only browser OAuth (scope read_api, ALI-102). A
      // self-managed host (custom domain) can't use the fixed gitlab.com OAuth
      // app, so it falls back to the read-only PAT path below.
      oauthKey: 'gitlab-personal',
      hostGatedOAuth: { field: 'domain' },
      tokenLabel: 'Personal access token',
      // Read-only tier: steer users to the read-only scope. `api` would grant
      // write; `read_api` is read-only and all Align's import needs. See ALI-98.
      // read_api arrives pre-selected via GitLab's documented ?name=&scopes= pre-fill,
      // which works on self-managed hosts too - the docs example is gitlab.example.com.
      tokenHint: 'read_api is pre-selected (read-only). Click Create, then copy the token here',
      tokenUrl: (t) => {
        const base = t['domain'] ? `https://${t['domain']}` : 'https://gitlab.com';
        return `${base}/-/user_settings/personal_access_tokens?name=Align+CLI&scopes=read_api`;
      },
      extraFields: [
        { key: 'domain', label: 'GitLab domain (leave blank for gitlab.com)' },
      ],
      fetch: async (t, w = parseSince(undefined)) => {
        const { fetchGitLabItems } = await import('../lib/fetchers/gitlab.js');
        return fetchGitLabItems({ token: t['token']!, domain: t['domain'] || undefined, ...fetchWindow('gitlab', w) });
      },
    },
    {
      id: 'linear',
      ...CAPTURE_SOURCES.linear,
      description: 'Your issues and project discussions',
      tier: 'personal',
      // Read-only personal/CLI tier via browser OAuth (scope `read`), replacing the
      // full-access API-key paste. Requires the Linear OAuth app + sealed creds. See ALI-101.
      oauthKey: 'linear-personal',
      // Local-mode token paste: a Linear personal API key (read-only graph).
      tokenLabel: 'Personal API key (lin_api_...)',
      // Linear documents no pre-fill params for API keys (only linear.new, for
      // issues), so the deepest available link is the creation dialog itself. The
      // slugless form routes to the signed-in user's own workspace - never hardcode
      // a workspace slug here, it 404s for everyone outside that workspace.
      tokenHint: 'Click Create key, then copy it here',
      tokenUrl: 'https://linear.app/settings/account/security/api-keys/new',
      fetch: async (t, w = parseSince(undefined)) => {
        const { fetchLinearItems } = await import('../lib/fetchers/linear.js');
        return fetchLinearItems({ token: t['token']!, ...fetchWindow('linear', w) });
      },
    },
    {
      id: 'notion',
      ...CAPTURE_SOURCES.notion,
      description: 'Your pages and databases',
      tier: 'personal',
      // Read-only personal/CLI tier via browser OAuth (public integration),
      // replacing the internal-integration-secret paste in cloud. Read-only is
      // governed by the integration's capabilities (Read content), not scopes.
      // Requires the Notion OAuth app + sealed creds. See ALI-104.
      oauthKey: 'notion-personal',
      // Local-mode token paste: a read-only internal integration secret.
      tokenLabel: 'Integration secret (ntn_...)',
      // Read-only tier: Align only reads. Notion integration capabilities are set
      // at creation - keep it to "Read content" (no insert/update). See ALI-98.
      tokenHint: 'Create an integration with ONLY "Read content" capability (no insert/update), then copy its Internal Integration Secret',
      // The developer console's tokens page directly, not the legacy my-integrations
      // landing (both resolve; this one is where the secret actually lives - Tom,
      // from a live run, 2026-08-31).
      tokenUrl: 'https://app.notion.com/developers/tokens',
      fetch: async (t, w = parseSince(undefined)) => {
        const { fetchNotionItems } = await import('../lib/fetchers/notion.js');
        return fetchNotionItems({ token: t['token']!, ...fetchWindow('notion', w) });
      },
    },
  );

  return sources;
}

// ---------------------------------------------------------------------------
// Token collection helper
// ---------------------------------------------------------------------------

async function collectTokens(
  source: SetupSource,
  seed: Record<string, string> = {},
  opts: { approve?: boolean } = {},
): Promise<Record<string, string> | null> {
  // `seed` pre-populates already-known fields (e.g. a self-managed host gathered
  // up front) so tokenUrl() resolves against the right host.
  const tokens: Record<string, string> = { ...seed };

  // Extra fields first (email, domain for Jira/Confluence). A field the seed
  // already carries is not re-asked - that is what a seed IS, and the cloud
  // host-gate path used to have to filter extraFields by hand to get this.
  for (const field of source.extraFields ?? []) {
    if (tokens[field.key] !== undefined) continue;
    // defaultValue '' so a blank submit renders empty, not the literal "undefined".
    const val = await guardedPrompt(field.label, () =>
      p.text({ message: `  ${field.label}:`, defaultValue: '' }),
    );
    if (val === null) return null;
    if (p.isCancel(val)) return null;
    tokens[field.key] = (val ?? '') as string;
  }

  // Main token. A seeded token skips the whole block - no browser open, no paste.
  if (source.tokenLabel && tokens['token'] === undefined) {
    // No OAuth here, by design (Tom, 2026-08-31, superseding ALI-778's local
    // direction): local mode is the user's personal graph, so the credential is one
    // they mint, scope and revoke themselves. The device-flow/PKCE machinery this
    // block used to try first is deleted - recover it from the history of PR #196 if
    // it is ever wanted again. OAuth lives on the personal-cloud path, where the
    // hosted broker holds the client secrets.

    // Reuse an already-authenticated local CLI before sending anyone to a browser to
    // mint a PAT by hand. Asked for by an outside tester on 2026-08-30 who already had
    // `gh` set up. Declining falls through to the browser flow unchanged.
    const cliSource = CLI_TOKEN_SOURCES[source.id];
    if (cliSource) {
      // Detection verifies read-only-ness BEFORE the decision layer, so --approve can
      // never auto-accept a token that was not positively confirmed (ALI-98). A
      // refusal is said out loud: a silent skip here reads as "gh not installed" when
      // the truth is "gh is installed and its token can write".
      const detected = await detectVerifiedCliToken(cliSource);
      if (detected && 'refused' in detected) {
        p.log.info(chalk.dim(
          `  Found ${cliSource.label}, but will not reuse its token: ${detected.refused}.\n` +
          `  Local mode only ever reads, so paste a read-only token below instead.`,
        ));
      }
      const cliToken = detected && 'token' in detected ? detected.token : null;
      const decision = cliTokenDecision({ token: cliToken, approve: opts.approve ?? false });
      let useCli = decision === 'use';
      if (decision === 'ask') {
        const answer = await p.confirm({
          message: `  Found ${cliSource.label}. Use its token? (no browser, nothing to create)`,
        });
        if (p.isCancel(answer)) return null;
        useCli = answer;
      }
      if (useCli && cliToken) {
        tokens['token'] = cliToken;
        // Say it even under --approve: a scripted run that silently picks up a
        // credential is the thing nobody can audit afterwards.
        p.log.success(`  Using your ${cliSource.label} token.`);
        return tokens;
      }
    }
    if (source.tokenUrl) {
      const url = typeof source.tokenUrl === 'function' ? source.tokenUrl(tokens) : source.tokenUrl;
      // The URL is printed UNCONDITIONALLY, and before the attempt. open() resolving
      // proves a child spawned, not that a tab appeared anywhere the user can see -
      // the 0.28.0 field failure was "Opening..." with nothing opened and no URL to
      // click, on every connector. Modern terminals make the printed URL clickable,
      // so this line IS the fallback.
      p.log.info(chalk.dim(`  Opening ${source.label} in your browser. If nothing opened, visit:\n    ${url}`));
      const opened = await tryOpenUrl(url);
      if (!opened) {
        p.log.warn(`  Could not open a browser here (the opener failed). Use the link above.`);
      }
    }
    if (source.tokenHint) {
      p.log.info(chalk.dim(`  ${source.tokenHint}`));
    }
    const token = await guardedPrompt(source.label, () =>
      p.password({ message: `  ${source.tokenLabel}:` }),
    );
    if (token === null) return null;
    if (p.isCancel(token)) return null;
    tokens['token'] = token as string;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Deterministic auto-alignment (ALI-121)
// ---------------------------------------------------------------------------

// Write the project-local, committed agent-rules files (Claude Code PostToolUse hook +
// CLAUDE.md nudge + Cursor rule) so alignment context fires regardless of model
// discretion. Best-effort: a write failure (read-only dir, weird CWD) must never abort
// onboarding, so we warn and continue.
/**
 * The retry command printed when a connector import fails mid-setup (ALI-675).
 *
 * It must be runnable AS PRINTED by the user this session belongs to. The bare
 * form resolved to the cloud default, so a --local user pasting our own hint
 * got a 401. Same env-naming convention as the MCP config writer: prod is the
 * unmarked default, everything else is explicit.
 */
export function importRetryHint(sourceId: string, envName: EnvName): string {
  return envName === 'prod' ? `align connect ${sourceId}` : `align connect ${sourceId} --env ${envName}`;
}

/**
 * Returns the repo-relative files written (empty when the write failed), so the outro can
 * tell whether the project .mcp.json - the one that wires Claude Code - actually landed
 * (ALI-950). Naming an agent as connected off a write that threw would be false.
 */
function writeAgentAlignment(envName: EnvName): string[] {
  try {
    const foreign: string[] = [];
    const written = setupAgentAlignment({ cwd: process.cwd(), env: envName, onForeign: (file) => foreign.push(file) });
    const foreignLine = projectForeignNotice(foreign);
    if (foreignLine) p.log.info(foreignLine);
    p.log.success(`Auto-alignment configured: ${written.join(', ')}`);
    p.log.info(
      chalk.dim(
        '  A PostToolUse hook will check edits against your decision graph. Claude Code asks ' +
        'once to approve project hooks - accept it to enable automatic alignment.',
      ),
    );
    return written;
  } catch (err) {
    p.log.warn(`Could not write auto-alignment files: ${(err as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Saved AI provider keys
// ---------------------------------------------------------------------------

/**
 * The wizard asks for no AI-provider key. It used to end on ALI-1284's guided Groq + Gemini
 * offer, immediately before bare `align` opened the coding agent - and read in that position
 * the keys looked like something the agent needed (a founder's own 0.48.0 run). They only
 * serve align's own terminal `align ask` prose; inside a wrapped agent the agent writes the
 * prose from the MCP results. `align ask` now offers a key itself, lazily, the first time it
 * has nothing to write prose with (lib/ask-key-offer.ts), and `align ai` chooses or adds one.
 *
 * What --reset keeps doing: clear every saved key and the saved provider choice, so local-llm
 * has nothing saved to use on the next invocation, and re-arm the first-ask offer a "Not now" turned off,
 * so the next `align ask` on a terminal offers again ("redo their setup", lazily). Called
 * early in runSetup, before any auth/TTY-gated exit can skip it (Copilot review, PR #323).
 */
function clearStoredProviderKeys(config: ReturnType<typeof createConfigStore>): void {
  // Clears the STORED (on-disk) value only, and never touches process.env (Copilot review,
  // PR #323, "previously missed"): a key the shell exported is the user's, whatever its value.
  // One line per key actually cleared (M3) - deleting a credential silently is the wrong
  // default for a command people run to fix something else.
  for (const provider of STORABLE_PROVIDERS) {
    if (!config.getProviderKey(provider)) continue;
    config.clearProviderKey(provider);
    p.log.info(`Cleared the saved ${PROVIDER_LABEL[provider]} key.`);
  }
  const pref = config.getLlmPreference().provider;
  if (pref) {
    config.clearLlmPreference();
    p.log.info(`Cleared your saved AI provider choice (${pref}).`);
  }
  config.setAskKeyOfferDismissed(false);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

// Local-embedded onboarding (opt-in via --local): no account, no cloud, no OAuth.
// Initializes the local graph, wires editor MCP configs to --env local, and
// seeds the graph from git history - all on the user's machine. This is the
// privacy/offline escape hatch; the default solo experience is a personal
// cloud tenant (see the cloud path below).
interface LocalValuePhaseResult {
  interactive: boolean;
  config: ReturnType<typeof createConfigStore>;
  localEnv: ReturnType<ReturnType<typeof createConfigStore>['getEnvironment']>;
  localClient: ReturnType<typeof createGatewayClient>;
  dbPath: string;
  // reset travels through the same opts bag the rest of the local phase already threads,
  // rather than becoming a second parameter every caller has to remember to also pass.
  opts: { approve?: boolean; reset?: boolean; launchNext?: boolean; verbose?: boolean };
  /** ALI-827: every source the value phase fetched, for the one report the connector
   *  phase prints at the end. */
  capture: ReturnType<typeof createCaptureCollector>;
  /** ALI-949: the wizard's setup_started / setup_completed emitter, one per run. */
  funnel: SetupFunnel;
  /** ALI-950: the agents wired this run, project config first, for the outro to name. */
  agents: string[];
  /** ALI-950: the first decision the wizard found (git, else docs), for the outro's question. */
  firstFoundTitle: string | undefined;
  /** C5: the coding agent `align` opens next, or null when none is installed or chosen. */
  agent: LaunchAgentId | null;
}

/**
 * Whether bare `align` opens the agent the moment this wizard ends. default-action.ts launches
 * after a launchNext setup when an agent was chosen, and launchIfChosen then declines under
 * ALIGN_WRAPPED / ALIGN_NO_LAUNCH or without a terminal - the same conditions, read here so the
 * outro never says "Opening" for a run where nothing opens.
 */
function willLaunchAgent(agent: LaunchAgentId | null, launchNext: boolean): boolean {
  // localGraph: true - the outro runs only once the local phase has built it.
  return launchNext && launchesAfterWizard({ localGraph: true, agent, isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
}

/**
 * The local outro's one next step, or nothing. No link: the only place to go from here is the
 * agent. When bare `align` is about to open the agent itself the line would be read for half a
 * second and then be false, so it is dropped. With no agent the install hints were already
 * printed once by the pick, and are not repeated here.
 */
function nextStepLine(agent: LaunchAgentId | null, launching: boolean): string | null {
  const label = agent ? agentByName(agent)?.label : undefined;
  if (label) return launching ? null : `Run ${chalk.bold('align')} to open ${label} with your graph.`;
  return `Run ${chalk.bold('align')} once a coding agent is installed.`;
}

/** Thrown inside the docs block to leave it without starting a read; never surfaces. */
class SkipDocs extends Error {}

async function runLocalValuePhase(opts: { approve?: boolean; reset?: boolean; launchNext?: boolean; verbose?: boolean; funnel: SetupFunnel }): Promise<LocalValuePhaseResult> {
  // Without a TTY neither prompt below can work: a piped stdin hangs forever and a closed
  // stdin crashes clack's raw-mode init (uv_tty_init EINVAL) AFTER local setup has already
  // succeeded (align-cli#118). Computed once, up front, and reused by both prompts in this
  // function so a scripted `setup --local` never blocks on either of them.
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  const config = createConfigStore();
  // C5: the coding agent comes first. It is the thing `align` opens at the end, and it is the
  // only question a solo developer is asked before the graph starts to fill. Same table, PATH
  // scan and config key as the launcher, so this IS the launcher's choice (no `align use`).
  // Before initLocalMode on purpose: cancelling here must leave no half-built graph behind.
  const picked = await pickAgent(config, { interactive: Boolean(interactive), approve: opts.approve });
  if (picked === PICK_CANCELLED) { p.cancel('Cancelled.'); process.exit(0); }
  const agent = picked;

  const { dbPath } = await initLocalMode();
  p.log.success('Local graph ready - no account needed, your data stays on this machine.');
  const localEnv = config.getEnvironment('local');
  const localClient = createGatewayClient(localEnv);
  const capture = createCaptureCollector();

  // ALI-949: local setup has begun. Sends now on a re-run (consent already on disk); on a
  // first run it cannot, and the post-consent offer below is the one that lands. Fire-and-
  // forget: a slow gateway never delays the value moment.
  void opts.funnel.started(localEnv);

  // ALI-794: value before questions. Git needs no credential and no consent, so it runs
  // before anything is asked - the found-decisions summary below is what "here is what I
  // found" means, and it has to exist before the agent-wiring/consent/connector steps that
  // used to come first for no reason other than that is the order they were written in.
  let firstFoundTitle: string | undefined;
  // Additive re-run (Tom, 2026-09-03): a second `align setup --local` must not walk the
  // whole first-run flow again. The graph decides, not a memory of the last run: if this
  // repo already has GIT decisions stamped with its identity, the git scan is skipped and
  // the refresh command named; same for repo docs, read off the blob URLs the docs importer
  // writes. Git rows specifically: a hand-captured PR stamps the same repo and is not a
  // scanned history. A repo the graph has never seen still gets the first-run value moment.
  // One git subprocess, not two: currentRepoIdentity is null exactly when this is not a git
  // repo, and never null inside one (a repo with no remote resolves to its root path), so
  // it answers isGitRepo as a by-product (Copilot, #249).
  const repo = await currentRepoIdentity();
  const inGitRepo = repo !== null;
  let repoKnown = false;
  let docsKnown = false;
  if (inGitRepo) {
    {
      const knownDb = createLocalDb(dbPath);
      try {
        const gitCount = knownDb.gitDecisionCount(repo);
        repoKnown = gitCount > 0;
        if (repoKnown) {
          console.log('');
          p.log.info(
            chalk.dim(`Git: ${gitCount} decisions from ${repo} are already in your graph. \`align connect git --env local\` refreshes them.`),
          );
        }
        docsKnown = knownDb.hasDocsForRepo(repo);
      } finally {
        knownDb.close();
      }
    }
  }
  if (inGitRepo && !repoKnown) {
    console.log('');
    p.log.info(chalk.dim('First import downloads a local embedding model (~23MB, from huggingface.co), one time.'));
    const gitSpinner = p.spinner();
    gitSpinner.start('Scanning git history...');
    try {
      const gitSource = buildSources(true).find(s => s.id === 'git')!;
      const fetched = await gitSource.fetch({});
      capture.add(toCaptureSource(gitSource, fetched));
      const { items } = fetched;
      if (items.length) {
        gitSpinner.stop(`Found ${items.length} commits worth importing`);
        // quiet: the found-summary box right below replaces the full table + tip block
        // runPersonalImport prints by default (component 2's whole point) - the one compact
        // line quiet mode DOES print is a fine progress marker while the summary is built.
        await runPersonalImport(items, localClient, {
          label: 'Git',
          approve: true,
          appUrl: resolveAppUrl(localEnv),
          local: true,
          quiet: true,
          funnel: { env: localEnv, source: 'git' },
        });
        // The payoff (ALI-215/ALI-794): name real decisions instead of a bare count, so a
        // first-run user can check the summary against their own repo. Read straight back
        // from the db rather than trusting the import's own tally - see buildFoundSummary's
        // comment on why total/linked come from a COUNT, not from `items.length`.
        const summaryDb = createLocalDb(dbPath);
        try {
          const summary = buildFoundSummary(summaryDb);
          firstFoundTitle = summary.recent[0]?.title;
          p.note(renderFoundSummary(summary), 'Found in your history');
        } finally {
          summaryDb.close();
        }
      } else {
        gitSpinner.stop('No decisions found in git history');
      }
    } catch (e) {
      const msg = (e as Error).message;
      // Surface a model/embedding failure distinctly rather than hiding it as a
      // generic "skipped" - otherwise local setup looks successful but the graph is
      // silently empty.
      if (/embedding model|not installed on this platform/i.test(msg)) {
        gitSpinner.stop('Local embedding model unavailable');
        p.log.warn(msg);
      } else {
        gitSpinner.stop('Git import skipped');
      }
    }
  }

  // Deterministic auto-alignment files target the local graph (advisory check runs --env local).
  // Deferred until AFTER the value moment above (ALI-794 component 3): writing project files
  // and asking about telemetry before the user has seen anything real is the footprint-before-
  // value ordering this ticket exists to invert.
  // ALI-793: ADRs + the user's own CLAUDE.md/AGENTS.md content, same zero-auth tier as
  // git above and independent of it - a repo can carry decision-shaped docs with no git
  // history worth mining, or vice versa. fetchDocsItems degrades gracefully with no git
  // remote (falls back to a stable git:// identifier), so this runs unconditionally, and
  // it belongs in the value phase for the same reason git does (ALI-794): it is
  // zero-credential value, so it has to show before the connector/consent questions,
  // not after them.
  console.log('');
  if (docsKnown) {
    p.log.info(chalk.dim('Repo docs: already in your graph. `align connect docs --env local` refreshes them.'));
  }
  const localDocsSpinner = p.spinner();
  if (!docsKnown) localDocsSpinner.start('Reading ADRs and CLAUDE.md/AGENTS.md...');
  try {
    if (docsKnown) throw new SkipDocs();
    const docs = await fetchDocsItems({ limit: SYNC_CEILINGS.docs });
    capture.add(toCaptureSource(CAPTURE_SOURCES.docs, docs));
    const docsItems = docs.items;
    if (docsItems.length) {
      localDocsSpinner.stop(`Found ${docsItems.length} item(s) worth importing`);
      await runPersonalImport(docsItems, localClient, {
        label: 'repo docs',
        approve: true,
        appUrl: resolveAppUrl(localEnv),
        local: true,
        funnel: { env: localEnv, source: 'docs' },
      });
      // ALI-950: a repo can carry decision-shaped docs and no git history worth mining, and
      // the outro's question must name a decision the wizard FOUND, whichever source found
      // it. Read back the same way the git summary does, only when git left nothing to name.
      if (!firstFoundTitle) {
        const docsDb = createLocalDb(dbPath);
        try {
          firstFoundTitle = buildFoundSummary(docsDb).recent[0]?.title;
        } finally {
          docsDb.close();
        }
      }
    } else {
      localDocsSpinner.stop('No ADRs or CLAUDE.md/AGENTS.md content found');
    }
  } catch (e) {
    if (!(e instanceof SkipDocs)) localDocsSpinner.stop(`Docs import skipped - ${(e as Error).message}`);
  }

  const projectAgents = projectAgentsFromWritten(writeAgentAlignment('local'));

  // The agents installed on this machine, not just the ones this project configures. Local
  // setup skipped this and cloud did not, which is backwards: local mode is the one whose
  // entire pitch is an agent on your own machine reading a graph that never leaves it.
  console.log('');
  const localAgents = await connectDetectedAgents('local', { verbose: opts.verbose });

  // ALI-950: whenever ANY agent was wired - the project .mcp.json counts. This used to print
  // only when a GLOBAL config was written, so a Claude-Code-only user, wired through the
  // project file a few lines up, never saw it. The question itself moves to the outro's
  // last line, where it is the one thing left to do.
  const agents = orderAgents({ project: projectAgents, global: localAgents.wired });
  const connectedLine = agentConnectedLine(agents);
  if (connectedLine) {
    console.log('');
    p.log.info(chalk.dim(connectedLine));
  }

  // ALI-949: the first checkpoint at which the local env is initialised, so a local-mode
  // setup_started is offered against it here. (C6: there is no consent question any more - the
  // one-time notice in cli.ts's preAction is the disclosure local sends wait on.)
  void opts.funnel.started(localEnv);

  return { interactive, config, localEnv, localClient, dbPath, opts, capture, funnel: opts.funnel, agents, firstFoundTitle, agent };
}

/**
 * The connector-picker tail, shared by every path that reaches local mode: `--local`
 * directly, the login-declined fallback in runCloudSetup, and (ALI-794) the fresh-install
 * flow after the upgrade question comes back "stay local". Split out of runLocalSetup as a
 * pure extraction - this body is byte-identical to what it replaced, just parameterised on
 * the value phase's result instead of closing over local variables (refactoring.md: a pure
 * move changes only how code is reached, never what it does).
 */
/** What connectLocalSources did for one source (ALI-951): `align connect --json` prints these. */
export interface ConnectedSourceResult {
  id: string;
  label: string;
  found: number;
  imported: number;
  /** Set when the fetch threw; found and imported are 0 then. */
  error?: string;
}

export interface ConnectLocalSourcesOptions {
  interactive: boolean;
  config: ReturnType<typeof createConfigStore>;
  localEnv: ReturnType<ReturnType<typeof createConfigStore>['getEnvironment']>;
  localClient: ReturnType<typeof createGatewayClient>;
  capture: ReturnType<typeof createCaptureCollector>;
  approve: boolean;
  /** ALI-951 (`align connect --source`): skip the picker and connect exactly these ids. */
  preselected?: string[];
  /** ALI-951 (`align connect --token`): fields that skip the paste for every preselected source. */
  seedTokens?: Record<string, string>;
  /** ALI-951 (`align connect --json`): print nothing per source; the caller prints one summary. */
  json?: boolean;
  /** L3 (`align connect --since`): how far back to read. Absent means the plan's six months. */
  window?: SyncWindow;
}

/** The ids `align connect --source` accepts: every local paste-token source, in picker order. */
export function localConnectorIds(): string[] {
  return buildSources(false)
    .filter((s) => s.id !== 'git' && s.tokenLabel)
    .sort((a, b) => TIER_ORDER[a.tier ?? 'personal'] - TIER_ORDER[b.tier ?? 'personal'])
    .map((s) => s.id);
}

/**
 * The picker-and-import tail of local setup: ask which read-only-token sources to connect,
 * collect every credential up front, then fetch and import each one. Extracted from
 * runLocalConnectorPhase for `align connect` (ALI-951), which is this same flow without the
 * wizard around it - one picker, one paste path, one save rule, in one place. The body is
 * the wizard's; `preselected`, `seedTokens` and `json` are the only additions, and each is
 * inert when absent.
 */
export async function connectLocalSources(o: ConnectLocalSourcesOptions): Promise<ConnectedSourceResult[]> {
  const { interactive, config, localEnv, localClient, capture, approve } = o;
  const quiet = o.json === true;
  const window = o.window ?? parseSince(undefined);
  const results: ConnectedSourceResult[] = [];

  // Connectors: local mode connects by a read-only token the user mints themselves,
  // for every connector - their personal graph, their credential. OAuth belongs to
  // the personal-cloud path, where the hosted broker holds the client secrets. (This
  // paragraph has now said three different things; the design statement printed to
  // the user below is the durable version.) Only sources with a tokenLabel are
  // pasteable: Teams pastes a Graph access token, Zoom has no personal token and is
  // excluded. See ALI-103.
  //
  // Asked BEFORE the git scan so every question lands on a clean screen and the rest of
  // setup then runs without stopping. The picker used to sit under a screenful of import
  // output, which is the condition that corrupted clack's redraw for an outside tester.
  const localConnectors = buildSources(false)
    .filter((s) => s.id !== 'git' && s.tokenLabel)
    .sort((a, b) => TIER_ORDER[a.tier ?? 'personal'] - TIER_ORDER[b.tier ?? 'personal']);
  if (o.preselected) {
    const known = new Set(localConnectors.map((s) => s.id));
    const unknown = o.preselected.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new Error(`Unknown source ${unknown.join(', ')}. --source takes one of: ${[...known].join(', ')}.`);
    }
  }
  if (!quiet) console.log('');
  // Say WHY, at the point of use. This reason used to live only in the comment above:
  // the user was sent to a provider page to mint a token with no explanation, which reads
  // as the tool being clumsy rather than as the privacy trade they chose. The constraint
  // is the provider's, not ours - OAuth needs a client secret, and a secret inside a
  // distributed binary is not a secret. See ALI-778.
  if (interactive && localConnectors.length > 0 && !quiet) {
    // ONE story, stated as the design it is (Tom, 2026-08-31, superseding ALI-778's
    // local-OAuth direction): this is the user's PERSONAL graph, so the credential is
    // one they mint, scope and can revoke themselves. Earlier versions blamed the
    // provider ("their sign-in requires a secret"), then blamed us ("the Align app is
    // not published yet"). Both framed the paste as a defect; it is the point.
    p.log.info(
      chalk.dim(
        `Local mode uses read-only tokens you create yourself: this graph is yours,\n` +
        `  so the credential is too - scoped by you, revocable by you. Tokens are\n` +
        `  saved on this machine, readable only by you, and only ever used to read.\n` +
        `  Remove them any time with \`align local forget\`.`,
      ),
    );
  }

  // ALI-802: what a previous run already collected. Until this existed, setup asked for every
  // token on every run - it gathered credentials, spent them on one fetch and never called the
  // store that was sitting there. Read before the picker so the picker can say what is saved.
  const savedTokens = new Map<string, Record<string, string>>();
  for (const source of localConnectors) {
    const saved = config.getConnectorFields('local', source.id);
    if (saved?.['token']) savedTokens.set(source.id, saved);
  }
  if (savedTokens.size > 0 && !quiet && !o.preselected) {
    const connected = localConnectors.filter((s) => savedTokens.has(s.id));
    const names = connected.map((s) => s.label).join(', ');
    // Named out loud, and left alone: a re-run adds what you pick and touches nothing else.
    // Until 2026-09-03 every saved connector was re-fetched on every run, so adding one
    // tool meant re-importing all of them. A log line rather than a prompt, so a scripted
    // run with no terminal still says what it left alone instead of silently doing nothing.
    if (interactive) {
      p.log.info(chalk.dim(`Connected: ${names} (saved read-only tokens). Select one to re-import it, or to replace its token.`));
    } else {
      const refresh = connected.map((s) => `align connect --source ${s.id} --yes`).join(', ');
      p.log.info(chalk.dim(`Connected: ${names} (saved read-only tokens), left alone: no terminal to pick from. Refresh with ${refresh}.`));
    }
  }
  // `interactive` computed once, by the caller - see runLocalValuePhase.
  // ALI-794: the found-summary above sits between this picker and the last clean screen,
  // which is the exact condition that used to corrupt clack's in-place redraw for an
  // outside tester (2026-08-30). Clear first so the picker gets its own canvas.
  const askPicker = interactive && !o.preselected;
  if (askPicker) clearScreenForPicker();
  // A windowed list ends in "..." and reads as cut off; the count turns it into "scroll".
  const maxItems = pickerMaxItems(process.stdout.rows, localConnectors.length);
  const windowed = maxItems < localConnectors.length;
  const selected = o.preselected
    ? o.preselected
    : askPicker
      ? await p.multiselect({
          message: `Connect more sources with a read-only token? (skip to finish${windowed ? `; ${localConnectors.length} sources, scroll for more` : ''})`,
          options: localConnectors.map((s) => ({
            value: s.id,
            label: s.label,
            // A connected connector stays in the list so it can be re-imported, or its expired
            // token replaced, without a separate command. Not selecting it leaves it alone.
            hint: savedTokens.has(s.id) ? 'connected - select to re-import' : s.description,
          })),
          required: false,
          // Without maxItems clack renders all eight and its in-place redraw miscounts
          // once the list is taller than the viewport, painting duplicate rows.
          maxItems,
        })
      : ([] as string[]);

  // Collect every credential up front, so the automatic phase below never stops to ask.
  const localReady: Array<{ source: SetupSource; tokens: Record<string, string>; reused: boolean }> = [];
  if (!p.isCancel(selected)) {
    const atlassianShared: Record<string, string> = {};
    for (const id of selected as string[]) {
      const source = localConnectors.find((s) => s.id === id);
      if (!source) continue;
      if (!quiet) {
        console.log('');
        p.log.step(chalk.bold(source.label));
      }
      // Jira and Confluence share one Atlassian account: same email, same site
      // domain, same id.atlassian.com API token. Ask once, reuse for the other, and
      // SAY so - the same disclosure rule as the gh-token reuse, because a silently
      // absorbed credential is the thing nobody can audit afterwards.
      const isAtlassian = source.id === 'jira' || source.id === 'confluence';
      let seed: Record<string, string> = isAtlassian ? { ...atlassianShared } : {};
      if (isAtlassian && seed['token'] !== undefined && !quiet) {
        p.log.info(chalk.dim('  Using your Atlassian email, domain and API token from the previous connector.'));
      }
      // ALI-951: `--token` (and any other field a flag supplied) seeds every preselected
      // source the way the Atlassian reuse above does - a seeded field is never asked for.
      if (o.seedTokens) seed = { ...seed, ...o.seedTokens };
      // A connected connector that was selected: re-import with the saved token unless the
      // user wants to replace it. Seeding collectTokens with the saved fields is what skips
      // every paste; an empty seed is what asks for them. --approve never stops to ask.
      // Not asked when the seed already carries a token: one Atlassian token is one fact,
      // so a token just pasted for Jira is the one Confluence uses, and offering the saved
      // (older) one instead would hand it a dead credential while the line above says
      // otherwise. A token that lasts hours (Teams) defaults to pasting a fresh one.
      const saved = savedTokens.get(source.id);
      let reused = false;
      if (saved && seed['token'] === undefined) {
        const reuse = approve
          ? true
          : await p.confirm({
              message: source.tokenShortLived
                ? `Re-import ${source.label} with its saved token? It lasts about an hour, so No (paste a fresh one) is usually right`
                : `Re-import ${source.label} with its saved token? (No pastes a new one)`,
              initialValue: !source.tokenShortLived,
            });
        if (p.isCancel(reuse)) continue;
        if (reuse) {
          seed = { ...seed, ...saved };
          reused = true;
        }
      }
      // ALI-951: with no terminal there is nothing to paste into. Name the flag rather than
      // letting clack crash on a closed stdin, which reads as the tool breaking (align-cli#118).
      if (!interactive) {
        const missing = (source.extraFields ?? []).map((f) => f.key).filter((k) => seed[k] === undefined);
        if (source.tokenLabel && seed['token'] === undefined) missing.push('token');
        if (missing.length) {
          const fieldFlags = missing.filter((k) => k !== 'token').map((k) => `--${k} <${k}>`);
          throw new Error(
            `${source.label} needs a ${source.tokenLabel ?? 'token'} and there is no terminal to paste one into. ` +
            `Pass --token <token>${fieldFlags.length ? `, or run align connect ${source.id} ${fieldFlags.join(' ')} --token <token>` : ''}.`,
          );
        }
      }
      const tokens = await collectTokens(source, seed, { approve });
      if (!tokens) continue;
      if (isAtlassian) {
        for (const k of ['email', 'domain', 'token']) {
          if (tokens[k] !== undefined) atlassianShared[k] = tokens[k];
        }
      }
      localReady.push({ source, tokens, reused });
    }
  }

  // Git and repo docs already ran above, in runLocalValuePhase, before the mode/connector
  // questions (ALI-794) - both are zero-credential value and belong in the "here is what I
  // found" moment, not stranded behind the questions this phase exists to ask. This phase
  // is only the automatic import for the paste-token connectors just collected.
  for (const { source, tokens, reused } of localReady) {
    const spinner = quiet ? { start() {}, stop() {} } : p.spinner();
    spinner.start(`Fetching from ${source.label}...`);
    try {
      const fetched = await source.fetch(tokens, window);
      capture.add(toCaptureSource(source, fetched, windowLabel(window.days)));
      const { items } = fetched;
      // Saved only once the fetch it unlocked has succeeded. A token that never worked is not
      // worth remembering, and storing one would turn the next run's honest "paste a token"
      // into a silent empty import. Re-saving an already-saved token is a harmless no-op, so
      // there is one rule here rather than a branch that has to stay in step with the reuse.
      config.saveConnectorFields('local', source.id, tokens);
      spinner.stop(`Found ${items.length} items`);
      let imported = 0;
      if (items.length) {
        imported = await runPersonalImport(items, localClient, {
          label: source.label,
          approve: true,
          appUrl: resolveAppUrl(localEnv),
          local: true,
          quiet: quiet || undefined,
          silent: quiet || undefined,
          funnel: { env: localEnv, source: source.id },
        });
      }
      results.push({ id: source.id, label: source.label, found: items.length, imported });
    } catch (e) {
      const msg = (e as Error).message;
      if (reused && isAuthExpiry(e)) {
        // The provider said the SAVED token is dead. Left saved it would keep the connector
        // "connected" on every later run and hide the gap line the graph would otherwise
        // print. A network error says nothing about the token and leaves it alone; a failed
        // PASTE never reaches here with reused set, and was never saved in the first place.
        config.forgetConnector('local', source.id);
        spinner.stop(`Skipped ${source.label} - its saved token was rejected (${msg}). Token forgotten; run setup again to paste a fresh one.`);
      } else {
        spinner.stop(`Skipped ${source.label} - ${msg}`);
      }
      results.push({ id: source.id, label: source.label, found: 0, imported: 0, error: msg });
    }
  }
  return results;
}

async function runLocalConnectorPhase(ctx: LocalValuePhaseResult): Promise<void> {
  const { interactive, config, localEnv, localClient, dbPath, opts, capture, funnel, agents, firstFoundTitle, agent } = ctx;

  await connectLocalSources({ interactive, config, localEnv, localClient, capture, approve: opts.approve ?? false });

  // ALI-827: what each source fetched and what it could not reach - once, after every
  // import has printed its own line, so the numbers sit together. A source whose fetch
  // THREW is not in it: its spinner line above already named the error, and a row of
  // zeros beside it would read as "fetched nothing" rather than "could not fetch". Empty
  // only when nothing was fetched at all (no git repo, no docs, nothing connected).
  const captureText = capture.render();
  if (captureText) {
    console.log('');
    console.log(captureText);
  }

  // Which graph does a BARE command read after this? resolveEnv with the
  // most local-favouring read preference is the truth: a no-account user is
  // redirected to local and there is nothing to say; a cloud token (or an
  // exported ALIGN_ENV) keeps bare commands on the cloud graph the user did
  // NOT just build. The default deliberately does not move - ALI-87 keeps
  // personal cloud the default and `align env set` its only writer; this
  // warning exists because Session A (2026-08-25) showed the silence reads
  // as the product ignoring an explicit choice.
  const bareEnv = resolveEnv(undefined, { preferLocalEmbedded: true });
  if (bareEnv !== 'local') {
    // Name the actual cause, and never suggest a remedy the cause overrides:
    // an exported ALIGN_ENV beats the stored default, so `align env set local`
    // would silently change nothing while it is set (Copilot, #129).
    const alignEnv = process.env['ALIGN_ENV'];
    const cause = alignEnv
      ? `ALIGN_ENV=${alignEnv} is exported in this shell`
      : 'you are logged in';
    const remedy = alignEnv
      ? `export ${chalk.bold('ALIGN_ENV=local')} (or unset it)`
      : `run ${chalk.bold('align env set local')} to make local the default ` +
        `(${chalk.dim(`align env set ${bareEnv}`)} switches back)`;
    p.log.warn(
      `Bare commands (align ask, align connect ...) use the ${bareEnv} cloud graph, not this local one, because ${cause}.\n` +
      `Add ${chalk.bold('--env local')} per command, or ${remedy}.`,
    );
  }

  // ALI-796: the graph names its own gaps - a ref whose platform has no connected
  // source. Read directly off decision_refs (the same query status.ts/local.ts use),
  // never gate-y: at most one line, and only when there is a real gap to name.
  const refsDb = createLocalDb(dbPath);
  const isConnected = (id: string) => config.getConnectorFields('local', id) !== null;
  const gaps = unresolvedGaps(refsDb.getAllRefs(), isConnected);
  refsDb.close();
  const gapLine = setupSummaryLine(gaps);

  // ALI-950: the last line is the next step, and it happens in the agent - named, with a
  // question about a decision the wizard just found, and no CLI verb. This used to end on
  // `align ask "why <a thing you decided>"`, a prompt verb on the one screen whose job is to
  // send the user into their agent. The gap line, when there is one, sits above it.
  // The 0.48.0 outro said "Open Claude Code in this repo and ask: ..." and align then opened
  // Claude Code itself. When it is about to, the last line says so instead.
  const launching = willLaunchAgent(agent, Boolean(opts.launchNext));
  const launchLabel = launching && agent ? agentByName(agent)?.label : undefined;
  const nextStep = nextStepLine(agent, launching);
  const askLine = launchLabel
    ? `Opening ${launchLabel}. Ask it: ${firstQuestion(firstFoundTitle)}`
    : agentAskLine({ agents, firstTitle: firstFoundTitle, inRepo: true, envName: 'local' });
  p.outro(
    `${chalk.green('You are set up in local mode.')}\n` +
    `  Graph: ${chalk.dim(dbPath)}\n` +
    `${nextStep ? `  ${nextStep}\n` : ''}` +
    `${gapLine ? `\n  ${chalk.dim(gapLine)}\n` : ''}\n` +
    `  ${chalk.bold(askLine)}`,
  );
  // ALI-949: after the outro, never before it - telemetry must not delay what the user is
  // waiting for. Awaited (unlike the other emitters) because this is the wizard's last act
  // and the one row the funnel was blind to; there is nothing left for a 2s worst case to hold up.
  await funnel.completed(localEnv);
}

// Local-embedded onboarding (opt-in via --local): no account, no cloud, no OAuth. Composes
// the two phases above unchanged - this is exactly what ran before the ALI-794 split, just
// as two calls instead of one function body.
async function runLocalSetup(opts: { approve?: boolean; reset?: boolean; launchNext?: boolean; verbose?: boolean; funnel: SetupFunnel }): Promise<void> {
  const ctx = await runLocalValuePhase(opts);
  await runLocalConnectorPhase(ctx);
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Guided onboarding: your local graph by default, your team graph when you are logged in')
    .option('--env <env>', 'local, preview or prod. Logged in to a team? Setup uses it; --env local builds the local graph instead')
    .option('--approve', 'Skip confirmation prompts (for scripted use)')
    .option('--local', 'Same as --env local: build the local graph even if you are logged in to a team')
    .option('--reset', 'Clear cached OAuth tokens, saved AI provider keys and the saved AI provider choice, and redo their setup')
    .option('--verbose', 'List every agent config file setup left as is, with the command to switch it')
    .action(runSetup);
}

/**
 * The onboarding flow, extracted from the `setup` action so `align` with no arguments can run
 * exactly the same thing (ALI-773). A new user's first instinct is to type the tool's name,
 * and that printed a twenty-command help wall.
 *
 * A pure move: the body below is the action's, unchanged apart from indentation. Both callers
 * share one implementation rather than the bare path re-parsing `setup` through Commander,
 * which would fire the postAction telemetry hook twice for one invocation.
 */
export async function runSetup(
  opts: { env?: string; approve?: boolean; local?: boolean; reset?: boolean; launchNext?: boolean; verbose?: boolean } = {},
): Promise<void> {
    const config = createConfigStore();

    // C5: solo is local only, and a team LOGIN means TEAM. Which one this run is comes from
    // routeSetup (a stored token, ALIGN_TOKEN or ALIGN_ENV=prod|preview means team; an
    // explicit --env / --local always wins), so nothing below ever rewires a team user to the
    // local graph unasked. `--local` is kept as the explicit spelling of `--env local`.
    let route;
    try {
      route = routeSetup(opts, config, process.env);
    } catch (err) {
      if (!(err instanceof InvalidEnvError)) throw err;
      console.error(err.message);
      process.exit(1);
    }

    // --reset: clear saved AI provider keys before any auth/TTY-gated exit can skip it
    // (Copilot review, PR #323). Interactive or not - the wizard no longer re-offers keys, so
    // there is nothing for an interactive --reset to wait for; `align ask` offers lazily.
    if (opts.reset) clearStoredProviderKeys(config);

    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

    if (route.kind === 'team') {
      const env = config.getEnvironment(route.env);
      // Without a terminal there is nobody to log in; with one, runCloudSetup offers it inline.
      if (!env.authToken && !interactive) {
        p.log.warn(`Run ${chalk.bold(`align login --env ${route.env}`)} first, then re-run ${chalk.bold('align setup')}.`);
        process.exit(1);
      }
      printBanner({ version });
      p.intro(commandIntro('align setup'));
      await runCloudSetup({ opts, config, env, client: createGatewayClient(env), envName: route.env, funnel: createSetupFunnel() });
      return;
    }

    // The one place a full brand moment belongs: first run, before any questions.
    printBanner({ version });
    p.intro(commandIntro('align setup'));
    if (route.teamLoginUntouched) {
      p.log.info(`Your ${route.teamLoginUntouched} team login is untouched. This sets up the local graph only.`);
    }

    // ALI-949: the wizard's setup_started / setup_completed emitter. NOT offered an env
    // here, where the mode is still unknown: each branch offers its own env at its top -
    // runLocalValuePhase and runCloudSetup - and again once consent / login makes a send
    // possible.
    await runLocalSetup({ approve: opts.approve, reset: opts.reset, launchNext: opts.launchNext, verbose: opts.verbose, funnel: createSetupFunnel() });
}

// Cloud (team) onboarding: verify login, wire MCP, seed from git, then offer
// personal-scoped connectors. Reached through routeSetup's team route: an explicit
// `--env prod|preview`, a stored token or ALIGN_TOKEN, or ALIGN_ENV=prod|preview (a solo
// developer's graph is local, and the gateway no longer creates personal tenants).
// Connectors bind per-user to the team tenant.
async function runCloudSetup(ctx: {
  opts: { approve?: boolean; reset?: boolean; verbose?: boolean };
  config: ReturnType<typeof createConfigStore>;
  env: ReturnType<ReturnType<typeof createConfigStore>['getEnvironment']>;
  client: ReturnType<typeof createGatewayClient>;
  envName: EnvName;
  funnel: SetupFunnel;
}): Promise<void> {
  const { opts, config, env, envName, funnel } = ctx;
  let client = ctx.client;

  // ---- Step 1: Auth check (inline login when interactive + unauthenticated) ----
  const authSpinner = p.spinner();
  authSpinner.start('Checking authentication...');
  try {
    const me = await client.whoami();
    authSpinner.stop(`Logged in as ${me.user.email} (${me.tenant?.name ?? envName})`);
    // ALI-949: cloud setup has begun, and the token is proven good. Offered only AFTER
    // whoami (Copilot on #279): a stale stored token passes the emitter's token check, so an
    // earlier offer would send a request the gateway rejects, count as sent, and suppress the
    // post-login offer below that would have landed. Reached from every route into cloud
    // setup, including the fresh-install upgrade question.
    void funnel.started(config.getEnvironment(envName));
  } catch {
    authSpinner.stop('Not authenticated');

    // Scripted runs (--approve) must not block on a browser; fail fast.
    if (opts.approve) {
      p.log.warn(`Run ${chalk.bold('align login')} first, then re-run ${chalk.bold('align setup')}.`);
      process.exit(1);
    }

    const wantLogin = await p.confirm({ message: 'Log in to Align now? (your team graph)' });
    if (!p.isCancel(wantLogin) && wantLogin) {
      const ok = await loginInteractive(env, envName, config);
      if (!ok) {
        p.log.warn(`Login did not complete. Run ${chalk.bold('align login')} and re-run ${chalk.bold('align setup')}.`);
        process.exit(1);
      }
      // Re-create the client so it carries the freshly stored token.
      client = createGatewayClient(config.getEnvironment(envName));
      // ALI-949: the first checkpoint at which a fresh cloud install's setup_started CAN
      // send - the token exists now. `env` above is the pre-login snapshot, so re-read.
      void funnel.started(config.getEnvironment(envName));
    } else {
      // Declined cloud login: offer the local escape hatch instead of failing.
      const wantLocal = await p.confirm({ message: 'Set up local-only mode instead? (no account, stays on this machine)' });
      if (!p.isCancel(wantLocal) && wantLocal) {
        await runLocalSetup({ approve: opts.approve, reset: opts.reset, funnel });
        return;
      }
      p.log.warn(`Run ${chalk.bold('align login')} when ready, then ${chalk.bold('align setup')}.`);
      process.exit(1);
    }
  }

  // ---- Step 2: PATH check ----
  try {
    // `which` is POSIX; Windows uses `where`.
    await execa(process.platform === 'win32' ? 'where' : 'which', ['align']);
  } catch {
    p.log.warn(
      `The ${chalk.bold('align')} command is not on your PATH. ` +
      `Editor MCP configs won't work until you run: ${chalk.bold('npm install -g @aligndottech/cli')}`,
    );
  }

  // ---- Step 3: Ask which tools the user actually has ----
  // Everything interactive happens before anything runs: pick your sources here, hand
  // over credentials next, and from then on setup does not ask again. This also keeps the
  // picker near the top of a clean screen rather than under a screenful of import output,
  // which is the condition that corrupted clack's in-place redraw for an outside tester.
  // Order by OAuth scope tier so frictionless personal-account connectors come
  // first, then Atlassian (site-scoped), then workspace-admin (Slack/Teams).
  console.log('');
  const connectorSources = buildSources(false)
    .filter(s => s.id !== 'git')
    .sort((a, b) => TIER_ORDER[a.tier ?? 'personal'] - TIER_ORDER[b.tier ?? 'personal']);
  const selectedIds = await p.multiselect({
    message: 'Connect more sources for richer context? (skip to finish)',
    options: connectorSources.map(s => ({ value: s.id, label: s.label, hint: s.description })),
    required: false,
    maxItems: pickerMaxItems(process.stdout.rows, connectorSources.length),
  });
  if (p.isCancel(selectedIds)) { p.cancel('Cancelled.'); process.exit(0); }
  const selectedSources = connectorSources.filter(s => (selectedIds as string[]).includes(s.id));

  // ---- Step 4: Collect all credentials up front (consents back-to-back) ----
  // Interactive auth (browser OAuth, token paste) can only happen one at a
  // time, so we gather every connector's creds first instead of interleaving
  // a slow fetch+import between each sign-in.
  const readyConnectors: Array<{ source: SetupSource; tokens: Record<string, string> }> = [];
  // OAuth keys connected during this run, so an Atlassian sibling (Jira <->
  // Confluence, one shared app + token) reuses the token instead of opening a
  // second browser - even under --reset.
  const connectedThisRun = new Set<string>();
  for (const source of selectedSources) {
    console.log('');
    p.log.step(chalk.bold(source.label));

    let tokens: Record<string, string> = {};
    if (source.oauthKey && source.hostGatedOAuth) {
      // Host-gated: blank host field → OAuth (SaaS default); a self-managed host
      // → token-paste fallback (the fixed OAuth app can't serve arbitrary hosts).
      const gate = source.hostGatedOAuth.field;
      const gateLabel = source.extraFields?.find((f) => f.key === gate)?.label ?? gate;
      const host = await guardedPrompt(gateLabel, () =>
        p.text({ message: `  ${gateLabel}:`, placeholder: 'gitlab.com', defaultValue: '' }),
      );
      if (host === null) continue;
      if (p.isCancel(host)) { p.cancel('Cancelled.'); process.exit(0); }
      // p.text returns undefined on a blank submit (not ''), so coerce before trim.
      const hostValue = (typeof host === 'string' ? host : '').trim();
      if (hostValue) {
        // self-managed → PAT. Seed the host so tokenUrl() targets it, and drop the
        // gate field from extraFields so we don't re-ask it.
        const patSource = { ...source, extraFields: source.extraFields?.filter((f) => f.key !== gate) };
        const collected = await collectTokens(patSource, { [gate]: hostValue }, { approve: opts.approve });
        if (!collected) { p.cancel('Cancelled.'); process.exit(0); }
        tokens = collected;
      } else {
        const collected = await collectTokensViaOAuth(source, client, config, envName, opts.reset ?? false, connectedThisRun);
        if (!collected) {
          p.log.warn(`Skipping ${source.label} - no token obtained.`);
          continue;
        }
        tokens = collected;
      }
    } else if (source.oauthKey) {
      const collected = await collectTokensViaOAuth(source, client, config, envName, opts.reset ?? false, connectedThisRun);
      if (!collected) {
        p.log.warn(`Skipping ${source.label} - no token obtained.`);
        continue;
      }
      tokens = collected;
    } else if (source.tokenLabel || (source.extraFields?.length ?? 0) > 0) {
      const collected = await collectTokens(source, {}, { approve: opts.approve });
      if (!collected) { p.cancel('Cancelled.'); process.exit(0); }
      tokens = collected;
    }
    readyConnectors.push({ source, tokens });
  }

  // ---- Step 5: MCP editor config (before import - this is the payoff) ----
  console.log('');
  // Shared with the local path (ALI-776), which used to skip this entirely - so a local-only
  // user got LESS agent wiring than a cloud one, on the mode where an agent running on your
  // own machine is the whole point.
  //
  // It does NOT ask: it wires every detected agent and discloses each file it touched, with
  // `align mcp --remove` as the undo. This block used to write to a user-level config without
  // a word when exactly one editor was detected and prompt only at two or more, and that
  // multiselect was unguarded, so `align setup --approve` with two agents installed hung.
  const globalAgents = await connectDetectedAgents(envName, { verbose: ctx.opts.verbose });

  // ---- Step 5b: Deterministic auto-alignment files (hook + nudges) ----
  const projectAgents = projectAgentsFromWritten(writeAgentAlignment(envName));
  // ALI-950: project config first - it is the one the user is most likely sitting in.
  const agents = orderAgents({ project: projectAgents, global: globalAgents.wired });

  // ---- Step 6: Git auto-import (zero-auth baseline graph seed) ----
  let totalDecisions = 0;
  const sourcesImported: string[] = [];
  const gitAvailable = await isGitRepo();
  const capture = createCaptureCollector();

  if (gitAvailable) {
    console.log('');
    const gitSpinner = p.spinner();
    gitSpinner.start('Scanning git history...');
    try {
      const gitSource = buildSources(true).find(s => s.id === 'git')!;
      const fetched = await gitSource.fetch({});
      capture.add(toCaptureSource(gitSource, fetched));
      const { items } = fetched;
      // Stop the scan spinner before runPersonalImport - it starts its own
      // progress spinner, and two animated spinners on one line flicker.
      if (items.length) {
        gitSpinner.stop(`Found ${items.length} commits worth importing`);
        const ingested = await runPersonalImport(items, client, {
          label: 'Git',
          approve: true,
          appUrl: resolveAppUrl(env),
          funnel: { env, source: 'git' },
        });
        totalDecisions += ingested;
        if (ingested > 0) sourcesImported.push('Git');
      } else {
        gitSpinner.stop('No decisions found in git history');
      }
    } catch {
      gitSpinner.stop('Git import skipped');
    }
  }

  // ---- Step 6b: Docs auto-import (ADRs + your own CLAUDE.md/AGENTS.md, zero-auth) ----
  // Independent of gitAvailable: fetchDocsItems degrades gracefully with no git remote.
  console.log('');
  const docsSpinner = p.spinner();
  docsSpinner.start('Reading ADRs and CLAUDE.md/AGENTS.md...');
  try {
    const docs = await fetchDocsItems({ limit: SYNC_CEILINGS.docs });
    capture.add(toCaptureSource(CAPTURE_SOURCES.docs, docs));
    const docsItems = docs.items;
    if (docsItems.length) {
      docsSpinner.stop(`Found ${docsItems.length} item(s) worth importing`);
      const ingested = await runPersonalImport(docsItems, client, {
        label: 'repo docs',
        approve: true,
        appUrl: resolveAppUrl(env),
        funnel: { env, source: 'docs' },
      });
      totalDecisions += ingested;
      if (ingested > 0) sourcesImported.push('Docs');
    } else {
      docsSpinner.stop('No ADRs or CLAUDE.md/AGENTS.md content found');
    }
  } catch {
    docsSpinner.stop('Docs import skipped');
  }

  // ---- Step 7: Fetch every connector concurrently (independent network I/O),
  // then import each result sequentially so per-connector output stays readable.
  // Imports are already internally batch-parallel (see runPersonalImport). Auth
  // (step 4) stays sequential because interactive browser/paste must be one at a time. ----
  type FetchResult =
    | { source: SetupSource; fetched: CaptureFetchResult }
    | { source: SetupSource; authExpired: true }
    | { source: SetupSource; error: Error };

  const n = readyConnectors.length;
  const fetchSpinner = p.spinner();
  fetchSpinner.start(`Fetching from ${n} source${n === 1 ? '' : 's'}...`);

  // Each task catches its own errors so one slow or failing connector never
  // blocks the others. An expired/revoked credential (isAuthExpiry) on an OAuth
  // connector is flagged for the interactive reconnect below - covers every
  // connector, not just the Atlassian fetchers that throw the typed AuthExpiredError.
  const fetched = await Promise.all(
    readyConnectors.map(async ({ source, tokens }): Promise<FetchResult> => {
      try {
        return { source, fetched: await source.fetch(tokens) };
      } catch (err) {
        if (source.oauthKey && isAuthExpiry(err)) {
          return { source, authExpired: true };
        }
        return { source, error: err as Error };
      }
    }),
  );
  fetchSpinner.stop(`Fetched ${n} source${n === 1 ? '' : 's'}`);

  // Resolve any expired-token connectors interactively first (sequential, and
  // rare - step 4 just minted fresh tokens), collecting everything ready to import.
  const ready: Array<{ source: SetupSource; items: PersonalImportItem[] }> = [];
  for (const result of fetched) {
    const source = result.source;
    if ('fetched' in result) {
      capture.add(toCaptureSource(source, result.fetched, windowLabel(SYNC_WINDOW_DEFAULT_DAYS)));
      const { items } = result.fetched;
      if (items.length) ready.push({ source, items });
      else p.log.warn(`No items found in ${source.label}.`);
    } else if ('authExpired' in result) {
      // Jira + Confluence share one Atlassian OAuth app, so a single consent
      // reconnects both. If a sibling already reconnected this connector earlier
      // in this loop, its token is fresh - reuse it silently rather than prompting
      // and opening a second browser flow.
      const alreadyReconnected = source.oauthKey ? connectedThisRun.has(source.oauthKey) : false;
      if (!alreadyReconnected) {
        const reauth = await p.confirm({ message: `${oauthFlowLabel(source)} token expired. Reconnect now?` });
        if (p.isCancel(reauth) || !reauth) {
          p.log.warn(`Skipping ${source.label}. Run ${chalk.bold('align setup')} to reconnect.`);
          continue;
        }
      }
      // reset = !alreadyReconnected: force a fresh consent for the first connector,
      // but reuse the shared token (no browser) for the sibling.
      const fresh = await collectTokensViaOAuth(source, client, config, envName, !alreadyReconnected, connectedThisRun);
      if (!fresh) {
        p.log.warn(`Skipping ${source.label} - re-auth cancelled or failed.`);
        continue;
      }
      const retrySpinner = p.spinner();
      retrySpinner.start(`Retrying ${source.label}...`);
      try {
        const fetched = await source.fetch(fresh);
        capture.add(toCaptureSource(source, fetched, windowLabel(SYNC_WINDOW_DEFAULT_DAYS)));
        const { items } = fetched;
        retrySpinner.stop(`Found ${items.length} items`);
        if (items.length) ready.push({ source, items });
        else p.log.warn(`No items found in ${source.label}.`);
      } catch (retryErr) {
        retrySpinner.stop(`Still failed: ${(retryErr as Error).message}`);
      }
    } else {
      p.log.warn(`Skipped ${source.label} - ${result.error.message}`);
      p.log.warn(`You can run ${chalk.bold(importRetryHint(source.id, envName))} later to retry.`);
    }
  }

  // Import every ready connector CONCURRENTLY - the imports (gateway ingest +
  // analysis) are the long pole, so they run in parallel (bounded) in quiet mode.
  // Each prints one compact completion line; the shared footer prints once after.
  if (ready.length) {
    console.log('');
    p.log.step(`Importing from ${ready.length} source${ready.length === 1 ? '' : 's'} in parallel...`);
    const importResults = await runWithConcurrency(
      ready.map(({ source, items }) => async () => {
        const total = await runPersonalImport(items, client, {
          label: source.label,
          approve: true,
          appUrl: resolveAppUrl(env),
          quiet: true,
          funnel: { env, source: source.id },
          // Async ingest (ALI-114): return at DB-write speed; titles + links
          // enrich in the background. Connection counts show as 0 here and fill in later.
          deferEnrichment: true,
        });
        return { label: source.label, total };
      }),
      IMPORT_CONCURRENCY,
    );
    for (const r of importResults) {
      if (r.status === 'fulfilled') {
        totalDecisions += r.value.total;
        if (r.value.total > 0) sourcesImported.push(r.value.label);
      } else {
        p.log.warn(`Import failed: ${(r.reason as Error).message}`);
      }
    }
    console.log('');
    console.log(chalk.dim('Relationships across all your imported tools are detected automatically in the background.'));
    console.log(chalk.dim('Query your graph: align ask "..."  or  align decisions list'));
    console.log('');
  }

  // ALI-827: the capture report, once, after every source has imported.
  const captureText = capture.render();
  if (captureText) {
    console.log(captureText);
    console.log('');
  }

  // ---- Outro ----
  const decisionsLine = totalDecisions > 0
    ? `  ${totalDecisions} decisions in your graph`
    : `  No decisions yet - run ${chalk.bold('align connect')} to load your history`;
  const sourceLine = sourcesImported.length > 0
    ? `\n  Sources: ${sourcesImported.join(', ')}`
    : '';

  // ---- Step 8: the agent is connected, and the next step is in it (ALI-950) ----
  // Only when something was actually WIRED, not merely detected - and the project .mcp.json
  // counts, which it did not before: this printed only for a global config, so a
  // Claude-Code-only user never saw it.
  const connectedLine = agentConnectedLine(agents);
  if (connectedLine) {
    console.log('');
    p.log.info(chalk.dim(connectedLine));
  }

  // The question names a decision the wizard just put in the graph, read straight back
  // rather than trusting the import's tally (same rule as the local found-summary). Only
  // worth a request when something was imported.
  const firstFoundTitle = totalDecisions > 0 ? (await firstDecision(client)).firstTitle : undefined;

  // The last line is the next step, in the agent, with no CLI verb. It used to be
  // `Run: align ask "any question about your codebase"`.
  const outroText = [
    chalk.bold('Setup complete.\n'),
    decisionsLine,
    sourceLine,
    chalk.dim('\n\n  Want your whole team on a shared decision graph?'),
    chalk.dim('\n  Upgrade by accepting a team invite - your decisions come with you'),
    chalk.dim('\n  (you reconnect your connectors once in the team workspace).'),
    chalk.dim('\n  https://app.align.tech/pricing'),
    `\n\n  ${chalk.bold(agentAskLine({ agents, firstTitle: firstFoundTitle, inRepo: true, envName }))}`,
  ].join('');
  p.outro(outroText);
  // ALI-949: after the outro, and against the env as it is NOW (the inline login above may
  // have stored the token after `env` was read). See runLocalConnectorPhase for why awaited.
  await funnel.completed(config.getEnvironment(envName));
}
