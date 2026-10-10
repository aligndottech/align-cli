/**
 * The optional work-email prompt at the share moment. NOT telemetry: it is a separate consent, it is
 * described as its own thing in docs/commands.md, and nothing here touches the telemetry state or events.
 *
 * It appears in one place only: `align share` run by a person at a terminal with no team login, right where
 * the one upgrade line already prints. The decision lives in `leadPromptDecision` so every refusal is one
 * named reason. The address is validated here, sent once to the gateway's public lead route, and never
 * stored anywhere on this machine: the config keeps a timestamp and an outcome word, not the address.
 *
 * `align_share` and `align_share_status` (the MCP tools) never import this module: an agent must not
 * collect an email on a person's behalf. Honest limit: an agent that opens its OWN pseudo-terminal passes every
 * terminal check here and can see the prompt; the server's double opt-in (nothing is stored as confirmed until the
 * address's owner clicks) is the backstop, the same stated limit as the typed share confirmation in SECURITY.md (share-lead-wiring.test.ts holds that: "the MCP tool modules do not import the prompt at all").
 */
import { type LeadPromptOutcome, type LeadState } from './config.js';
import { visible } from './share/visible.js';
import pkg from '../../package.json' with { type: 'json' };

/** The consent text version. The privacy page uses the same string: change both together. */
export const LEAD_CONSENT_VERSION = '2026-10-cli-share-1';
export const PRIVACY_URL = 'https://align.tech/privacy';

export const LEAD_CONSENT_LINE = `We will store it to email you about team plans. One confirmation email, unsubscribe any time. Details: ${PRIVACY_URL}.`;
export const LEAD_QUESTION_LINE = 'Want an email when your team can join Align, or to set up a call?';
export const LEAD_INPUT_PROMPT = 'Work email (press Enter to skip):';

const CAP_MS = 5000;
const MAX_RESPONSE_BYTES = 4096;

export type LeadSkipReason = 'not-hosted' | 'has-team-destination' | 'wrapped' | 'ci' | 'suppressed' | 'not-a-terminal' | 'has-login' | 'already-asked';

export interface LeadGateInput {
  env: Record<string, string | undefined>;
  /** stdin, stdout and stderr are all real terminals. */
  tty: boolean;
  hasLogin: boolean;
  inCi: boolean;
  state: LeadState;
  /** The gateway this run talks to (resolved from config, the same one the share path uses). */
  gatewayUrl: string;
  /** Align's own hosted gateway. Only that target may be asked for, or sent, an email. */
  hostedGatewayUrl: string;
  /** The person has joined a team (`align join`): they are not the audience for Align's list. */
  hasTeamDestination: boolean;
}

const sameUrl = (a: string, b: string): boolean => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

const isSet = (v: string | undefined): boolean => v !== undefined && v !== '';

/** Null means ask. Anything else is the one reason it must not. Pure, so the decision table is testable as one. */
export function leadPromptDecision(i: LeadGateInput): LeadSkipReason | null {
  // A self-hosted or preview gateway is not Align's list: no prompt, no send, no flag, no network.
  if (i.hostedGatewayUrl === '' || !sameUrl(i.gatewayUrl, i.hostedGatewayUrl)) return 'not-hosted';
  if (i.hasTeamDestination) return 'has-team-destination';
  if (isSet(i.env['ALIGN_WRAPPED'])) return 'wrapped';
  if (i.inCi) return 'ci';
  if (isSet(i.env['ALIGN_NO_LEAD_PROMPT'])) return 'suppressed';
  if (!i.tty) return 'not-a-terminal';
  if (i.hasLogin) return 'has-login';
  if (i.state.shownAt !== undefined && i.state.version === LEAD_CONSENT_VERSION) return 'already-asked';
  return null;
}

// Zero-width, bidi, line and paragraph separators and exotic spaces, plus punctuation that never belongs in an address.
const FORBIDDEN = /[\s\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff,;:<>()[\]"\\]/u;
const hasControl = (s: string): boolean => [...s].some((c) => { const n = c.codePointAt(0)!; return n < 0x20 || (n >= 0x7f && n <= 0x9f); });

/** The address to send, or null. Trims, lowercases the domain, and refuses anything the server would also refuse. */
export function normaliseEmail(raw: string): string | null {
  const s = raw.trim();
  if (s.length === 0 || s.length > 254 || FORBIDDEN.test(s) || hasControl(s)) return null;
  const parts = s.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || local.length > 64) return null;
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return null;
  return `${local}@${domain.toLowerCase()}`;
}

export type LeadSendOutcome = { kind: 'accepted' } | { kind: 'invalid' } | { kind: 'rate-limited' } | { kind: 'unavailable' } | { kind: 'failed' };

export interface LeadBody { email: string; source: 'cli-share'; consent_version: string; cli_version?: string; os?: 'darwin' | 'linux' | 'win32' }

export function leadBody(email: string): LeadBody {
  const p = process.platform;
  return {
    email,
    source: 'cli-share',
    consent_version: LEAD_CONSENT_VERSION,
    cli_version: pkg.version.slice(0, 32),
    ...(p === 'darwin' || p === 'linux' || p === 'win32' ? { os: p } : {}),
  };
}

/** One attempt. No retry, no redirect, a hard time cap and a size cap on what is read back. Never throws. */
export async function postLead(email: string, baseUrl: string, capMs: number = CAP_MS): Promise<LeadSendOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), capMs);
  try {
    const res = await fetch(`${baseUrl.trim().replace(/\/+$/, '')}/leads/team-interest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(leadBody(email)),
      redirect: 'error',
      signal: controller.signal,
    });
    // Read at most a few KB: the answer is tiny, and a server that streams forever must not hold the terminal.
    const reader = res.body?.getReader();
    let seen = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > MAX_RESPONSE_BYTES) { await reader.cancel(); break; }
    }
    if (res.status === 202) return { kind: 'accepted' };
    if (res.status === 422) return { kind: 'invalid' };
    if (res.status === 429) return { kind: 'rate-limited' };
    // The server does not offer the route (an older gateway): permanent for this install, so not a retry.
    if (res.status === 404 || res.status === 405) return { kind: 'unavailable' };
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

export interface LeadStore {
  getLeadState(): LeadState;
  markLeadPromptShown(version: string): void;
  setLeadOutcome(outcome: LeadPromptOutcome): void;
  clearLeadPromptShown(): void;
}

export interface LeadDeps {
  store: LeadStore;
  env: Record<string, string | undefined>;
  hasLogin: boolean;
  inCi: boolean;
  gatewayUrl: string;
  hostedGatewayUrl: string;
  hasTeamDestination: boolean;
  /** stdin, stdout and stderr are terminals. The controlling terminal itself is proven by `ask`. */
  tty: boolean;
  /** Show `shown` on the controlling terminal, call onShown once visible, return the typed line, or null with no terminal. */
  ask: (shown: string, question: string, onShown: () => void) => Promise<string | null>;
  /** Posts to the resolved gateway URL, the same one the gate compared. */
  post: (email: string) => Promise<LeadSendOutcome>;
  out: (line: string) => void;
}

const DECLINES = /^(n|no|never|no thanks|no thank you)$/i;

/** Runs the whole prompt. Returns what happened, for tests. Never throws: a broken store costs the prompt, never the command. */
export async function maybeAskLead(d: LeadDeps): Promise<'skipped-by-gate' | 'no-terminal' | LeadPromptOutcome | 'not-sent'> {
  try {
    if (leadPromptDecision({ env: d.env, tty: d.tty, hasLogin: d.hasLogin, inCi: d.inCi, gatewayUrl: d.gatewayUrl, hostedGatewayUrl: d.hostedGatewayUrl, hasTeamDestination: d.hasTeamDestination, state: d.store.getLeadState() }) !== null) return 'skipped-by-gate';
    const shown = `${LEAD_QUESTION_LINE}\n${LEAD_CONSENT_LINE}`;
    // Marked as soon as the person can see it, so Ctrl-C or end of input still counts as asked.
    let line = await d.ask(shown, LEAD_INPUT_PROMPT, () => d.store.markLeadPromptShown(LEAD_CONSENT_VERSION));
    if (line === null) return 'no-terminal';
    let email = normaliseEmail(line);
    if (line.trim() !== '' && DECLINES.test(line.trim())) { d.store.setLeadOutcome('declined'); return 'declined'; }
    if (line.trim() !== '' && email === null) {
      d.out('That does not look like an email address. Try once more, or press Enter to skip.');
      line = (await d.ask('', LEAD_INPUT_PROMPT, () => undefined)) ?? '';
      email = normaliseEmail(line);
    }
    if (email === null) return 'skipped'; // Enter, Ctrl-C, end of input, or a second bad address: asked, and not again
    const sent = await d.post(email);
    if (sent.kind === 'accepted') {
      d.store.setLeadOutcome('submitted');
      d.out(`We sent a confirmation email to ${visible(email)}. Check your inbox.`);
      return 'submitted';
    }
    if (sent.kind === 'invalid') {
      d.out('The server did not accept that address, so nothing was saved.');
      return 'skipped';
    }
    if (sent.kind === 'unavailable') {
      // Permanent: keep the asked mark, or every share on this server would ask again and fail the same way.
      d.out('Email sign-up is not available from this server yet. Nothing was sent.');
      return 'skipped';
    }
    // A timeout or a 5xx may mean the server already took the address; a later share asking again is absorbed by
    // the server's one-confirmation-per-24-hours rule, so the person gets no second email inside a day.
    // Nothing reached the server's list: forget that we asked, so a later share can offer it again.
    d.store.clearLeadPromptShown();
    d.out(sent.kind === 'rate-limited' ? 'Too many requests just now. Nothing was sent. Try again later.' : 'Could not reach the server. Nothing was sent.');
    return 'not-sent';
  } catch {
    return 'skipped-by-gate';
  }
}

export interface LeadPromptWiring {
  store: LeadStore & { listTeamDestinationNames(): string[] };
  /** The gateway this share resolved to: compared with the hosted one, never posted to. */
  cloudGatewayUrl: string;
  hostedGatewayUrl: string;
  env: Record<string, string | undefined>;
  inCi: boolean;
  tty: boolean;
  ask: LeadDeps['ask'];
  out: (line: string) => void;
}

/**
 * What `align share` hands the run as its lead prompt. Two rules live here so a test can hold them:
 * a saved team destination switches the prompt off, and the address is posted to Align's hosted gateway
 * as Align spells it, never to whatever the run resolved (a self-host, or an environment override that merely
 * matches after normalising).
 */
export function leadPromptFor(w: LeadPromptWiring): () => ReturnType<typeof maybeAskLead> {
  return () => maybeAskLead({
    store: w.store,
    env: w.env,
    hasLogin: false,
    gatewayUrl: w.cloudGatewayUrl,
    hostedGatewayUrl: w.hostedGatewayUrl,
    hasTeamDestination: w.store.listTeamDestinationNames().length > 0,
    inCi: w.inCi,
    tty: w.tty,
    ask: w.ask,
    post: (email) => postLead(email, w.hostedGatewayUrl),
    out: w.out,
  });
}
