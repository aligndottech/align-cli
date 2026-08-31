/**
 * Did the GitHub App sign-in actually get access to anything?
 *
 * A GitHub App's device flow can complete perfectly and yield a token that can see
 * ZERO repositories: user authorization and App INSTALLATION are separate grants,
 * and installing on an organisation is an owner's call. So "connected" is a claim
 * about the mechanism, and this asks about the effect.
 *
 * Without it the failure is silent and lands far away - a scan that imports nothing,
 * which reads as "Align found no decisions" rather than "your org has not installed
 * the App". That is the whole reason the check exists.
 *
 * It is ADVISORY and fails open: an unreachable API returns installed:true with
 * errored:true, because telling someone their org blocked them on the strength of a
 * network blip is worse than staying quiet.
 */

export interface InstallationCheck {
  /** False ONLY on a definite zero-installation answer from GitHub. */
  installed: boolean;
  /** The check could not run. Guidance is suppressed when true. */
  errored: boolean;
  /** Accounts the App is installed on, for the confirmation line. */
  accounts: string[];
}

export async function checkGithubAppInstallation(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<InstallationCheck> {
  try {
    const res = await fetchFn('https://api.github.com/user/installations', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return { installed: true, errored: true, accounts: [] };

    const body = (await res.json()) as {
      total_count?: number;
      installations?: { account?: { login?: string } }[];
    };
    const accounts = (body.installations ?? [])
      .map((i) => i.account?.login)
      .filter((l): l is string => Boolean(l));

    return { installed: (body.total_count ?? 0) > 0, errored: false, accounts };
  } catch {
    return { installed: true, errored: true, accounts: [] };
  }
}
