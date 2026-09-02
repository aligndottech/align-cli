import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { tryOpenUrl } from '../lib/open-url.js';
import { execa } from 'execa';
import { clearScreenForPicker, CLI_TOKEN_SOURCES, cliTokenDecision, detectVerifiedCliToken, pickerMaxItems } from '../lib/setup-ux.js';
import { createConfigStore, type EnvName, isFreshInstall } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { type PersonalImportItem, runPersonalImport, runWithConcurrency } from '../lib/personal-import.js';
import { connectDetectedAgents } from './connect-agents.js';
import { setupAgentAlignment } from '../lib/agent-rules.js';
import { isGitRepo } from '../lib/git.js';
import { fetchDocsItems } from '../lib/fetchers/docs.js';
import { createLocalDb } from '../lib/local-db.js';
import { buildFoundSummary, renderFoundSummary } from '../lib/found-summary.js';
import { initLocalMode } from '../lib/local-mode.js';
import { loginInteractive } from '../lib/login-flow.js';
import { resolveAppUrl } from '../lib/env-resolver.js';
import { collectTokensViaOAuth, oauthFlowLabel } from '../lib/personal-oauth.js';
import { isAuthExpiry } from '../lib/errors.js';
import { maybeRequestTelemetryConsent } from '../lib/telemetry-consent.js';
import { commandIntro } from '../lib/brand.js';
import pkg from '../../package.json' with { type: 'json' };
const { version } = pkg;
import { printBanner } from '../lib/brand.js';
import { guardedPrompt } from '../lib/prompt-guard.js';
import { setupSummaryLine, unresolvedGaps } from '../lib/connect-prompt.js';

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
  tokenUrl?: string | ((tokens: Record<string, string>) => string);  // If set, auto-opens this URL in the browser before prompting for the token
  extraFields?: Array<{ key: string; label: string; hint?: string; secret?: boolean }>;
  fetch: (tokens: Record<string, string>) => Promise<PersonalImportItem[]>;
}

function buildSources(gitAvailable: boolean): SetupSource[] {
  const sources: SetupSource[] = [];

  if (gitAvailable) {
    sources.push({
      id: 'git',
      label: 'Git',
      description: 'Commit history from this repo - no token needed',
      fetch: async () => {
        const { fetchGitItems } = await import('../lib/fetchers/git.js');
        return fetchGitItems({ limit: 500 });
      },
    });
  }

  sources.push(
    {
      id: 'github',
      label: 'GitHub',
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
      fetch: async (t) => {
        const { fetchGitHubItems } = await import('../lib/fetchers/github.js');
        return fetchGitHubItems({ token: t['token']!, limit: 250 });
      },
    },
    {
      id: 'jira',
      label: 'Jira',
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
      fetch: async (t) => {
        const { fetchJiraItems } = await import('../lib/fetchers/jira.js');
        return fetchJiraItems({ token: t['token']!, cloudId: t['cloudId'], email: t['email'], domain: t['domain'], limit: 250 });
      },
    },
    {
      id: 'confluence',
      label: 'Confluence',
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
      fetch: async (t) => {
        const { fetchConfluenceItems } = await import('../lib/fetchers/confluence.js');
        return fetchConfluenceItems({ token: t['token']!, cloudId: t['cloudId'], email: t['email'], domain: t['domain'], limit: 250 });
      },
    },
    {
      id: 'slack',
      label: 'Slack',
      description: 'Decision threads from your channels - may need workspace admin [experimental]',
      tier: 'workspace',
      // Read-only personal/CLI tier (no chat:write). The team/org bot keeps
      // chat:write via the `slack` key. See ALI-94.
      oauthKey: 'slack-personal',
      // Local-mode token paste: a Slack user token (xoxp-) with read scopes only.
      tokenLabel: 'User token (xoxp-...)',
      tokenHint: 'User token with read scopes only: channels:read, channels:history, groups:read, groups:history',
      tokenUrl: 'https://api.slack.com/apps',
      fetch: async (t) => {
        const { fetchSlackItems } = await import('../lib/fetchers/slack.js');
        return fetchSlackItems({ token: t['token']!, limit: 250, daysBack: 90 });
      },
    },
    {
      id: 'teams',
      label: 'Microsoft Teams',
      description: 'Channel messages and decisions - may need org/workspace admin consent',
      tier: 'workspace',
      oauthKey: 'teams',
      fetch: async (t) => {
        const { fetchTeamsItems } = await import('../lib/fetchers/teams.js');
        return fetchTeamsItems({ token: t['token']!, limit: 250 });
      },
    },
    {
      id: 'zoom',
      label: 'Zoom',
      description: 'Cloud recording transcripts from your meetings',
      tier: 'personal',
      oauthKey: 'zoom',
      fetch: async (t) => {
        const { fetchZoomItems } = await import('../lib/fetchers/zoom.js');
        return fetchZoomItems({ token: t['token']!, limit: 50 });
      },
    },
    {
      id: 'gitlab',
      label: 'GitLab',
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
      fetch: async (t) => {
        const { fetchGitLabItems } = await import('../lib/fetchers/gitlab.js');
        return fetchGitLabItems({ token: t['token']!, domain: t['domain'] || undefined, limit: 250 });
      },
    },
    {
      id: 'linear',
      label: 'Linear',
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
      fetch: async (t) => {
        const { fetchLinearItems } = await import('../lib/fetchers/linear.js');
        return fetchLinearItems({ token: t['token']!, limit: 250 });
      },
    },
    {
      id: 'notion',
      label: 'Notion',
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
      fetch: async (t) => {
        const { fetchNotionItems } = await import('../lib/fetchers/notion.js');
        return fetchNotionItems({ token: t['token']!, limit: 250 });
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
  return envName === 'prod' ? `align import ${sourceId}` : `align import ${sourceId} --env ${envName}`;
}

function writeAgentAlignment(envName: EnvName): void {
  try {
    const written = setupAgentAlignment({ cwd: process.cwd(), env: envName });
    p.log.success(`Auto-alignment configured: ${written.join(', ')}`);
    p.log.info(
      chalk.dim(
        '  A PostToolUse hook will check edits against your decision graph. Claude Code asks ' +
        'once to approve project hooks - accept it to enable automatic alignment.',
      ),
    );
  } catch (err) {
    p.log.warn(`Could not write auto-alignment files: ${(err as Error).message}`);
  }
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
  opts: { approve?: boolean };
}

async function runLocalValuePhase(opts: { approve?: boolean } = {}): Promise<LocalValuePhaseResult> {
  // Without a TTY neither prompt below can work: a piped stdin hangs forever and a closed
  // stdin crashes clack's raw-mode init (uv_tty_init EINVAL) AFTER local setup has already
  // succeeded (align-cli#118). Computed once, up front, and reused by both prompts in this
  // function so a scripted `setup --local` never blocks on either of them.
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  const { dbPath } = await initLocalMode();
  p.log.success('Local graph ready - no account needed, your data stays on this machine.');

  const config = createConfigStore();
  const localEnv = config.getEnvironment('local');
  const localClient = createGatewayClient(localEnv);

  // ALI-794: value before questions. Git needs no credential and no consent, so it runs
  // before anything is asked - the found-decisions summary below is what "here is what I
  // found" means, and it has to exist before the agent-wiring/consent/connector steps that
  // used to come first for no reason other than that is the order they were written in.
  let firstFoundTitle: string | undefined;
  if (await isGitRepo()) {
    console.log('');
    p.log.info(chalk.dim('First import downloads a local embedding model (~23MB, from huggingface.co), one time.'));
    const gitSpinner = p.spinner();
    gitSpinner.start('Scanning git history...');
    try {
      const gitSource = buildSources(true).find(s => s.id === 'git')!;
      const items = await gitSource.fetch({});
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
  const localDocsSpinner = p.spinner();
  localDocsSpinner.start('Reading ADRs and CLAUDE.md/AGENTS.md...');
  try {
    const docsItems = await fetchDocsItems({ limit: 500 });
    if (docsItems.length) {
      localDocsSpinner.stop(`Found ${docsItems.length} item(s) worth importing`);
      await runPersonalImport(docsItems, localClient, {
        label: 'repo docs',
        approve: true,
        appUrl: resolveAppUrl(localEnv),
        local: true,
        funnel: { env: localEnv, source: 'docs' },
      });
    } else {
      localDocsSpinner.stop('No ADRs or CLAUDE.md/AGENTS.md content found');
    }
  } catch (e) {
    localDocsSpinner.stop(`Docs import skipped - ${(e as Error).message}`);
  }

  writeAgentAlignment('local');

  // The agents installed on this machine, not just the ones this project configures. Local
  // setup skipped this and cloud did not, which is backwards: local mode is the one whose
  // entire pitch is an agent on your own machine reading a graph that never leaves it.
  console.log('');
  const localAgents = await connectDetectedAgents('local');

  // The "try it" nudge (ALI-794): only when something was actually wired, and phrased against
  // a REAL decision from the summary above when one exists - "why did we X" beats a generic
  // question because it is checkable against the repo the user is sitting in.
  if (localAgents.connected > 0) {
    console.log('');
    p.log.info(chalk.dim('Your agent is connected. Try asking:'));
    p.log.info(chalk.bold(
      firstFoundTitle ? `  "why did we ${firstFoundTitle}?"` : '  "What decisions exist in this codebase?"',
    ));
  }

  // ALI-618: one-time, never asked again once answered. Local mode has no account, so consent
  // is the only thing that can ever turn this on - see usage-telemetry.ts's local-embedded
  // branch, which reads this same stored decision.
  await maybeRequestTelemetryConsent(config, Boolean(interactive));

  return { interactive, config, localEnv, localClient, dbPath, opts };
}

/**
 * The connector-picker tail, shared by every path that reaches local mode: `--local`
 * directly, the login-declined fallback in runCloudSetup, and (ALI-794) the fresh-install
 * flow after the upgrade question comes back "stay local". Split out of runLocalSetup as a
 * pure extraction - this body is byte-identical to what it replaced, just parameterised on
 * the value phase's result instead of closing over local variables (refactoring.md: a pure
 * move changes only how code is reached, never what it does).
 */
async function runLocalConnectorPhase(ctx: LocalValuePhaseResult): Promise<void> {
  const { interactive, config, localEnv, localClient, dbPath, opts } = ctx;

  // Connectors: local mode connects by a read-only token the user mints themselves,
  // for every connector - their personal graph, their credential. OAuth belongs to
  // the personal-cloud path, where the hosted broker holds the client secrets. (This
  // paragraph has now said three different things; the design statement printed to
  // the user below is the durable version.) Only sources with a tokenLabel are
  // pasteable (Teams/Zoom have no personal token → excluded). See ALI-103.
  //
  // Asked BEFORE the git scan so every question lands on a clean screen and the rest of
  // setup then runs without stopping. The picker used to sit under a screenful of import
  // output, which is the condition that corrupted clack's redraw for an outside tester.
  const localConnectors = buildSources(false)
    .filter((s) => s.id !== 'git' && s.tokenLabel)
    .sort((a, b) => TIER_ORDER[a.tier ?? 'personal'] - TIER_ORDER[b.tier ?? 'personal']);
  console.log('');
  // Say WHY, at the point of use. This reason used to live only in the comment above:
  // the user was sent to a provider page to mint a token with no explanation, which reads
  // as the tool being clumsy rather than as the privacy trade they chose. The constraint
  // is the provider's, not ours - OAuth needs a client secret, and a secret inside a
  // distributed binary is not a secret. See ALI-778.
  if (interactive && localConnectors.length > 0) {
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
  if (interactive && savedTokens.size > 0) {
    const names = localConnectors.filter((s) => savedTokens.has(s.id)).map((s) => s.label).join(', ');
    // Named out loud rather than silently reused: a credential nobody can see being used is
    // the one nobody can audit, which is the same reason the gh-token reuse announces itself.
    p.log.info(chalk.dim(`Using your saved read-only tokens for: ${names}.`));
  }
  // `interactive` computed once, at the top of this function - see the comment there.
  // ALI-794: the found-summary above sits between this picker and the last clean screen,
  // which is the exact condition that used to corrupt clack's in-place redraw for an
  // outside tester (2026-08-30). Clear first so the picker gets its own canvas.
  if (interactive) clearScreenForPicker();
  const selected = interactive
    ? await p.multiselect({
        message: 'Connect more sources with a read-only token? (skip to finish)',
        options: localConnectors.map((s) => ({
          value: s.id,
          label: s.label,
          // A saved connector stays in the list so an expired or wrong token can be replaced
          // without a separate command - selecting it asks again and overwrites what is saved.
          hint: savedTokens.has(s.id) ? 'saved - select to replace' : s.description,
        })),
        required: false,
        // Without maxItems clack renders all 7 and its in-place redraw miscounts
        // once the list is taller than the viewport, painting duplicate rows.
        maxItems: pickerMaxItems(process.stdout.rows, localConnectors.length),
      })
    : ([] as string[]);

  // Collect every credential up front, so the automatic phase below never stops to ask.
  const localReady: Array<{ source: SetupSource; tokens: Record<string, string> }> = [];
  if (!p.isCancel(selected)) {
    const atlassianShared: Record<string, string> = {};
    for (const id of selected as string[]) {
      const source = localConnectors.find((s) => s.id === id);
      if (!source) continue;
      console.log('');
      p.log.step(chalk.bold(source.label));
      // Jira and Confluence share one Atlassian account: same email, same site
      // domain, same id.atlassian.com API token. Ask once, reuse for the other, and
      // SAY so - the same disclosure rule as the gh-token reuse, because a silently
      // absorbed credential is the thing nobody can audit afterwards.
      const isAtlassian = source.id === 'jira' || source.id === 'confluence';
      const seed = isAtlassian ? { ...atlassianShared } : {};
      if (isAtlassian && seed['token'] !== undefined) {
        p.log.info(chalk.dim('  Using your Atlassian email, domain and API token from the previous connector.'));
      }
      const tokens = await collectTokens(source, seed, { approve: opts.approve });
      if (!tokens) continue;
      if (isAtlassian) {
        for (const k of ['email', 'domain', 'token']) {
          if (tokens[k] !== undefined) atlassianShared[k] = tokens[k];
        }
      }
      localReady.push({ source, tokens });
    }
  }

  // Saved connectors the user did not pick for replacement still import - that is the whole
  // point of having saved them. Appended after the freshly collected ones so a connector
  // selected for replacement is never also imported with its old token.
  // Cancelling the picker (Esc) means "do no connector work", the same as it does for the
  // collection block above; only an empty SUBMIT means "skip to finish, use what I have". They
  // arrive as different values and must not collapse into the same branch.
  if (!p.isCancel(selected)) {
    const replacing = new Set(selected as string[]);
    for (const source of localConnectors) {
      const saved = savedTokens.get(source.id);
      if (saved && !replacing.has(source.id)) localReady.push({ source, tokens: saved });
    }
  }

  // Git and repo docs already ran above, in runLocalValuePhase, before the mode/connector
  // questions (ALI-794) - both are zero-credential value and belong in the "here is what I
  // found" moment, not stranded behind the questions this phase exists to ask. This phase
  // is only the automatic import for the paste-token connectors just collected.
  for (const { source, tokens } of localReady) {
    const spinner = p.spinner();
    spinner.start(`Fetching from ${source.label}...`);
    try {
      const items = await source.fetch(tokens);
      // Saved only once the fetch it unlocked has succeeded. A token that never worked is not
      // worth remembering, and storing one would turn the next run's honest "paste a token"
      // into a silent empty import. Re-saving an already-saved token is a harmless no-op, so
      // there is one rule here rather than a branch that has to stay in step with the reuse.
      config.saveConnectorFields('local', source.id, tokens);
      spinner.stop(`Found ${items.length} items`);
      if (items.length) {
        await runPersonalImport(items, localClient, {
          label: source.label,
          approve: true,
          appUrl: resolveAppUrl(localEnv),
          local: true,
          funnel: { env: localEnv, source: source.id },
        });
      }
    } catch (e) {
      spinner.stop(`Skipped ${source.label} - ${(e as Error).message}`);
    }
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
      `Bare commands (align ask, align import ...) use the ${bareEnv} cloud graph, not this local one, because ${cause}.\n` +
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

  p.outro(
    `${chalk.green('You are set up in local mode.')}\n` +
    `  Graph: ${chalk.dim(dbPath)}\n` +
    `  Run ${chalk.bold('align')} any time to see your graph and what to do next.\n` +
    // Deliberately NOT "What decisions exist in this codebase?", which this line used to
    // suggest. That question is ABOUT the graph rather than IN it, so on-device search
    // matches nothing and a tester was told his freshly imported graph was empty (ALI-771).
    // It is a fine thing to ask an AGENT over MCP, and a bad first thing to type here.
    `  Ask it something real: ${chalk.bold('align ask "why <a thing you decided>"')}${gapLine ? `\n\n  ${chalk.dim(gapLine)}` : ''}`,
  );
}

// Local-embedded onboarding (opt-in via --local): no account, no cloud, no OAuth. Composes
// the two phases above unchanged - this is exactly what ran before the ALI-794 split, just
// as two calls instead of one function body.
async function runLocalSetup(opts: { approve?: boolean } = {}): Promise<void> {
  const ctx = await runLocalValuePhase(opts);
  await runLocalConnectorPhase(ctx);
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Guided onboarding: connect your tools and configure MCP in one command')
    .option('--env <env>', 'Environment')
    .option('--approve', 'Skip confirmation prompts (for scripted use)')
    .option('--local', 'Set up local-only mode (no account, no cloud)')
    .option('--reset', 'Clear cached OAuth tokens and re-authenticate all connectors')
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
  opts: { env?: EnvName; approve?: boolean; local?: boolean; reset?: boolean } = {},
): Promise<void> {
    const config = createConfigStore();
    const envName = resolveEnv(opts.env);
    const env = config.getEnvironment(envName);
    const client = createGatewayClient(env);

    // The one place a full brand moment belongs: first run, before any questions.
    printBanner({ version });
    p.intro(commandIntro('align setup'));

    // ---- Step 0: Cloud (default) vs local (--local) ----
    // Solo defaults to a personal CLOUD tenant: telemetry, the real cloud
    // relationship classifier, backup, and a clean upgrade path to a team
    // (reuses the personal->org join flow). --local is the opt-in offline
    // escape hatch; --approve runs the cloud path non-interactively.
    //
    // ALI-794: on a genuinely fresh machine (neither mode configured yet), interactively,
    // with neither flag forcing a mode, invert this - build the local graph and show what
    // is in it BEFORE asking anything. A returning user (either mode already set up) is
    // not asked to sit through that again; they keep the question below, same as today.
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    if (!opts.local && !opts.approve && interactive && isFreshInstall(config)) {
      await runFreshSetup({ config, env, client, envName, opts });
      return;
    }

    let mode: 'cloud' | 'local';
    if (opts.local) {
      mode = 'local';
    } else if (opts.approve) {
      mode = 'cloud';
    } else {
      const choice = await p.select({
        message: 'How are you using Align?',
        options: [
          { value: 'cloud', label: 'Cloud (recommended) - your personal decision graph', hint: 'syncs, backed up, upgradeable to a team' },
          { value: 'local', label: 'Local only - private, offline, no account', hint: 'stays on this machine (--local)' },
        ],
        initialValue: 'cloud',
      });
      if (p.isCancel(choice)) { p.cancel('Cancelled.'); process.exit(0); }
      mode = choice as 'cloud' | 'local';
    }

    if (mode === 'local') {
      await runLocalSetup({ approve: opts.approve });
      return;
    }

    await runCloudSetup({ opts, config, env, client, envName });
}

/**
 * ALI-794: the value-first fresh-install flow. Builds and shows the local graph with
 * nothing asked for, THEN offers the upgrade - inverting the mode-question-first order
 * above for the one case that pays for it: nobody has configured anything yet.
 *
 * Choosing cloud hands off to the existing `runCloudSetup`, completely unchanged - its own
 * git scan and agent-file write run again there. Both are idempotent, and re-running them is
 * the accepted cost of the local graph above being a real, usable preview rather than
 * provisional state (component 1's "nothing about the cloud path changes once chosen").
 */
async function runFreshSetup(ctx: {
  config: ReturnType<typeof createConfigStore>;
  env: ReturnType<ReturnType<typeof createConfigStore>['getEnvironment']>;
  client: ReturnType<typeof createGatewayClient>;
  envName: EnvName;
  opts: { approve?: boolean; reset?: boolean };
}): Promise<void> {
  const phase = await runLocalValuePhase({ approve: ctx.opts.approve });

  // Framed by what the graph is missing, not "how are you using Align" in the abstract -
  // there is already a local graph on screen, so the question is whether to extend it.
  //
  // "A path to team sharing", never "for team sharing": choosing cloud creates a
  // PERSONAL tenant (the option's hint says so) and a team is a separate join/upgrade
  // later. The question and the option below must keep agreeing on that - the question
  // overclaimed for a while and a live tester read it as sharing starting here.
  const choice = await p.select({
    message: 'Stay local, or sync to the cloud for backup, richer detection, and a path to team sharing?',
    options: [
      { value: 'local', label: 'Stay local - keep what you just built, private and offline', hint: 'no account' },
      { value: 'cloud', label: 'Sync to the cloud - backup, team upgrade path, richer detection', hint: 'personal tenant' },
    ],
    initialValue: 'local',
  });
  if (p.isCancel(choice)) { p.cancel('Cancelled.'); process.exit(0); }

  if (choice === 'local') {
    await runLocalConnectorPhase(phase);
    return;
  }

  await runCloudSetup(ctx);
}


// Cloud (personal-tenant) onboarding: verify login, wire MCP, seed from git,
// then offer personal-scoped connectors. A personal-email login lands on an
// isolated personal tenant server-side; connectors auto-bind to it.
async function runCloudSetup(ctx: {
  opts: { approve?: boolean; reset?: boolean };
  config: ReturnType<typeof createConfigStore>;
  env: ReturnType<ReturnType<typeof createConfigStore>['getEnvironment']>;
  client: ReturnType<typeof createGatewayClient>;
  envName: EnvName;
}): Promise<void> {
  const { opts, config, env, envName } = ctx;
  let client = ctx.client;

  // ---- Step 1: Auth check (inline login when interactive + unauthenticated) ----
  const authSpinner = p.spinner();
  authSpinner.start('Checking authentication...');
  try {
    const me = await client.whoami();
    authSpinner.stop(`Logged in as ${me.user.email} (${me.tenant?.name ?? envName})`);
  } catch {
    authSpinner.stop('Not authenticated');

    // Scripted runs (--approve) must not block on a browser; fail fast.
    if (opts.approve) {
      p.log.warn(`Run ${chalk.bold('align login')} first, then re-run ${chalk.bold('align setup')}.`);
      process.exit(1);
    }

    const wantLogin = await p.confirm({ message: 'Log in to Align now? (your personal cloud graph)' });
    if (!p.isCancel(wantLogin) && wantLogin) {
      const ok = await loginInteractive(env, envName, config);
      if (!ok) {
        p.log.warn(`Login did not complete. Run ${chalk.bold('align login')} and re-run ${chalk.bold('align setup')}.`);
        process.exit(1);
      }
      // Re-create the client so it carries the freshly stored token.
      client = createGatewayClient(config.getEnvironment(envName));
    } else {
      // Declined cloud login: offer the local escape hatch instead of failing.
      const wantLocal = await p.confirm({ message: 'Set up local-only mode instead? (no account, stays on this machine)' });
      if (!p.isCancel(wantLocal) && wantLocal) {
        await runLocalSetup({ approve: opts.approve });
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
  const agents = await connectDetectedAgents(envName);

  // ---- Step 5b: Deterministic auto-alignment files (hook + nudges) ----
  writeAgentAlignment(envName);

  // ---- Step 6: Git auto-import (zero-auth baseline graph seed) ----
  let totalDecisions = 0;
  const sourcesImported: string[] = [];
  const gitAvailable = await isGitRepo();

  if (gitAvailable) {
    console.log('');
    const gitSpinner = p.spinner();
    gitSpinner.start('Scanning git history...');
    try {
      const gitSource = buildSources(true).find(s => s.id === 'git')!;
      const items = await gitSource.fetch({});
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
    const docsItems = await fetchDocsItems({ limit: 500 });
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
    | { source: SetupSource; items: PersonalImportItem[] }
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
        return { source, items: await source.fetch(tokens) };
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
    if ('items' in result) {
      if (result.items.length) ready.push({ source, items: result.items });
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
        const items = await source.fetch(fresh);
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

  // ---- Outro ----
  const decisionsLine = totalDecisions > 0
    ? `  ${totalDecisions} decisions in your graph`
    : `  No decisions yet - run ${chalk.bold('align import')} to load your history`;
  const sourceLine = sourcesImported.length > 0
    ? `\n  Sources: ${sourcesImported.join(', ')}`
    : '';

  // ---- Step 8: First-query prompt ----
  // Only when something was actually WIRED, not merely detected: telling someone their agent
  // is connected when they declined the prompt would be false.
  //
  // The question stays as it is, deliberately. ALI-771 removed it from the LOCAL outro
  // because typing it into `align ask` matches nothing - it is about the graph rather than in
  // it. Asked of an AGENT over MCP it is a good opening question, because the agent answers
  // it by calling a list tool rather than a similarity search. Different surface, different
  // advice.
  if (agents.connected > 0) {
    console.log('');
    p.log.info(chalk.dim('Your agent is connected. Try asking:'));
    p.log.info(chalk.bold('  "What decisions exist in this codebase?"'));
  }

  const outroText = [
    chalk.bold('Setup complete.\n'),
    decisionsLine,
    sourceLine,
    `\n\n  Run: ${chalk.bold('align ask "any question about your codebase"')}`,
    chalk.dim('\n\n  Want your whole team on a shared decision graph?'),
    chalk.dim('\n  Upgrade by accepting a team invite - your decisions come with you'),
    chalk.dim('\n  (you reconnect your connectors once in the team workspace).'),
    chalk.dim('\n  https://app.align.tech/pricing'),
  ].join('');
  p.outro(outroText);
}
