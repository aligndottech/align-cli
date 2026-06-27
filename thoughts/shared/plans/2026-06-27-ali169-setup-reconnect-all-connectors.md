# ALI-169: generalize expired-token reconnect to ALL connectors + exhaustive scenario tests

Date: 2026-06-27
Ticket: [ALI-169](https://linear.app/aligndottech/issue/ALI-169) (child of ALI-159 launch readiness)

## The bug (live `align setup --env preview`)

Expired cached connector tokens: only **Atlassian (Jira/Confluence)** got the interactive
"Reconnect now?" recovery. Zoom, GitLab, Linear, Teams 401'd and were silently skipped with
"run align import X later" - permanently broken after one setup run.

## Root cause

`setup.ts` classifies a failed connector fetch (L788-793):

```ts
if (err instanceof AuthExpiredError && source.oauthKey) return { source, authExpired: true };
return { source, error: err as Error };
```

The reconnect loop (L800-840) already handles `authExpired` for ANY `oauthKey` connector. The
gap is purely **classification**: only the CLI's jira.ts/confluence.ts fetchers map a 401 to
`AuthExpiredError` (they catch connector-core's typed `FetcherAuthError`). The other fetchers are
thin delegates to `@aligndottech/connector-core`, whose GitHub/GitLab/Linear/Zoom/Teams/Notion
fetchers throw a **generic `Error`** carrying the status in the message
("GitLab auth failed (401)...", "Zoom API error 401...", Slack "invalid_auth"). Those fall to the
"Skipped X" branch with no reconnect.

## Fix (surgical, single-repo, zero manual-`--token` regression)

Detect auth-expiry by behavior, not just type, and ONLY in the OAuth setup path (gated on
`source.oauthKey`), so the manual `align import <x> --token` error text is untouched.

1. `src/lib/errors.ts`: add `isAuthExpiry(err): boolean` - true for `AuthExpiredError`,
   `FetcherAuthError`, or a generic Error whose message indicates a 401/403 / Slack auth code.
2. `src/commands/setup.ts` L789: `if (source.oauthKey && isAuthExpiry(err))` (+ import swap).

Do NOT touch the fetchers (would need a connector-core/SDK release and would degrade the
`--token` "check your token" message). Follow-up: make all connector-core fetchers throw the
typed `FetcherAuthError` so the CLI can drop the message heuristic (separate align-connector-sdk PR).

## Tests (DoD: green CI predicts the live setup run)

### `src/__tests__/auth-expiry.test.ts` (new) - `isAuthExpiry`
- AuthExpiredError -> true; FetcherAuthError -> true
- generic 401/403 messages for github/gitlab/linear/zoom/teams/notion/jira/confluence -> true
- Slack invalid_auth / not_authed / token_revoked / account_inactive -> true
- non-auth (404, 500, network "fetch failed", plain "boom", "", null, number) -> false

### `src/__tests__/setup.test.ts` (extend) - real-world reconnect scenarios
Using the existing harness (mocked fetchers + clack), mock a fetcher to reject with a realistic
connector-core error, assert the reconnect orchestration:
1. **non-Atlassian generic-401 -> reconnect accepted -> re-fetch -> imported** (the regression):
   Linear/GitLab/Zoom cached-stale -> `Error("... 401 ...")` then retry resolves items.
2. reconnect **declined** -> "Skipping ... Run align setup", no re-OAuth, not imported.
3. reconnect accepted but **re-auth returns null** (waitForCallback fails) -> "re-auth cancelled or failed".
4. reconnect accepted, **retry still fails** -> spinner "Still failed", not imported.
5. **non-auth error (500/404)** -> "Skipped X" + "run align import X later", NO reconnect prompt.
6. **mixed batch**: github ok + gitlab 401->reconnect->ok + linear ok + notion no-items.
7. (regression-guard) Atlassian sibling reconnect still one consent (existing test stays green).