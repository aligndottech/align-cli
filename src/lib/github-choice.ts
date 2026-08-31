import * as p from '@clack/prompts';
import chalk from 'chalk';
import { type GithubVariant, githubVariants } from './secret-free-oauth.js';

/**
 * Pick how to sign in to GitHub in true local mode, disclosing the trade.
 *
 * GitHub is the only connector where read-only and no-admin-approval cannot both be
 * had. The read-only guarantee needs a GitHub App, and an App must be installed -
 * which on an org the user does not own is somebody else's decision. The OAuth App
 * needs no install but its `repo` scope is read AND write, because classic OAuth has
 * no read-only-private equivalent.
 *
 * ALI-98 (amended 2026-08-31) allows the write-capable path in true local, where the
 * token never reaches Align's servers. What it prohibits is doing it QUIETLY: the
 * original finding against github-personal was that it "silently falls back to the
 * write bot App". So the cost is stated in the option itself, and again after the
 * choice - not in a log line the user has already scrolled past.
 */
export async function chooseGithubVariant(
  configured: Partial<Record<GithubVariant['id'], string>>,
): Promise<GithubVariant | null> {
  const available = githubVariants().filter((v) => configured[v.id]);
  if (available.length === 0) return null;

  // One real answer is not a choice. Asking anyway costs every user a keystroke to
  // no purpose, which is the same reasoning connect-agents.ts uses for not prompting.
  if (available.length === 1) return available[0]!;

  const picked = await p.select({
    message: '  How would you like to connect GitHub?',
    options: available.map((v) => ({
      value: v.id,
      label: v.label,
      // The disclosure lives HERE, next to the thing being chosen. A warning printed
      // before the prompt is one the user has already scrolled past.
      hint: v.tradeoff || 'recommended, read-only',
    })),
  });
  if (p.isCancel(picked)) return null;

  const variant = available.find((v) => v.id === picked) ?? null;

  // Said twice on purpose for the write-capable path: once to inform the choice, once
  // to confirm what was chosen. Cheap, and it is the difference between a disclosed
  // fallback and the silent one ALI-98 exists to prevent.
  if (variant?.writeCapable) {
    p.log.warn(
      `  ${chalk.bold('This token can write to your repositories.')} Align only ever reads, ` +
      'but the grant itself is read+write because GitHub has no read-only scope for ' +
      'private repos outside a GitHub App. Revoke it any time in GitHub settings.',
    );
  }
  return variant;
}
