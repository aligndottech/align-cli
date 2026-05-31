# Implementation Plan: `align setup --local` read-only token-paste connectors (ALI-103)

## Overview
Today `align setup --local` (`runLocalSetup`) is git-only. OAuth can't run offline (no hosted browser→gateway callback), so add a connector step that connects the **token-pasteable** sources via **manual read-only token paste**, importing into the local graph. Model: **cloud = OAuth, local = manual read-only tokens.**

## Research Reference (this session)
- `src/commands/setup.ts`: `runLocalSetup()` does `initLocalMode()` → git import via `buildSources(true).find(id==='git')` + `runPersonalImport(items, localClient, …)` → outro. No connector prompts.
- Cloud collect loop branches `if (source.oauthKey && hostGatedOAuth)` / `else if (oauthKey)` / `else if (tokenLabel||extraFields)`. **`collectTokens(source, seed={})`** collects `extraFields` (via `p.text`) then a `p.password` into `tokens.token`; opens `tokenUrl` + shows `tokenHint`.
- Fetcher token needs: github `{token}`, jira/confluence `{token,email,domain(,cloudId)}`, slack `{token}`, linear `{token}`, gitlab `{token,domain}`, notion `{token}`. Teams/Zoom: OAuth/admin only — **no personal PAT** → exclude.
- gitlab + notion already have token-paste metadata. github/jira/confluence/slack/linear are OAuth-only (`oauthKey`) and need `tokenLabel`/`tokenHint`/`tokenUrl`(+`extraFields` for jira/confluence) added. **Cloud is unaffected** — the cloud loop hits `oauthKey` first; `tokenLabel`/`extraFields` are only read by `collectTokens` (the local path).

## Behavior To-Do List
- [ ] B1: `align setup --local` offers a connector multiselect **after** the git import (only sources with a `tokenLabel`).
- [ ] B2: Selecting a connector collects its token via paste and imports the fetched items into the **local** graph (`localClient`).
- [ ] B3: Teams and Zoom are **not** offered in local mode (no personal token).
- [ ] B4: Skipping (empty selection) finishes cleanly — current git-only behavior preserved.
- [ ] B5: Cloud mode is unchanged (OAuth connectors still use the browser flow; adding token metadata doesn't regress it).

## Success Criteria
- [ ] `align setup --local` imports git **and** lets you paste read-only tokens for GitHub/Jira/Confluence/Slack/Linear/GitLab/Notion into the local DB.
- [ ] Teams/Zoom absent from the local connector list.
- [ ] All tests pass · TypeScript compiles · Lint passes · `npm run build` ok.

---

## Phase 1: B5 first (safety) — token metadata on OAuth connectors doesn't touch cloud

### 1.1 RED
Add a test asserting cloud setup still uses OAuth for an OAuth connector after we add `tokenLabel` to it (e.g. GitHub): selecting `github` in cloud mode still calls `waitForCallback` and does **not** prompt `p.password`.
(Existing cloud tests already cover this; extend/confirm one explicitly.)

### 1.2 GREEN
Add token-paste metadata to the OAuth-only connectors in `buildSources` (used only by the local/`collectTokens` path):
- **github**: `tokenLabel: 'Personal access token'`, `tokenUrl: 'https://github.com/settings/tokens'`, `tokenHint: 'Use a read-only token (fine-grained: Contents/Issues/Pull requests = Read)'`
- **jira**: `tokenLabel: 'API token'`, `tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens'`, `extraFields: [{key:'email',label:'Atlassian account email'},{key:'domain',label:'Atlassian domain (yourorg.atlassian.net)'}]`
- **confluence**: same as jira
- **slack**: `tokenLabel: 'User token (xoxp-...)'`, `tokenHint` = the read scopes, `tokenUrl: 'https://api.slack.com/apps'`
- **linear**: `tokenLabel: 'Personal API key (lin_api_...)'`, `tokenUrl: 'https://linear.app/settings/api'`

### 1.3 REFACTOR
Confirm cloud loop precedence (`oauthKey` checked before `tokenLabel`) is intact. No cloud test breaks.

---

## Phase 2: B1 + B2 — local connector step

### 2.1 RED
Test: `align setup --local` with the connector multiselect returning `['linear']` → `p.password` collected, `fetchLinearItems` called, `runPersonalImport` called with the local client. (Mirror `setup.test.ts` mocks; `mockMultiselect` for the connector step, `p.password` mock for the token.)

### 2.2 GREEN
In `runLocalSetup`, after the git import block, add:
```typescript
const localConnectors = buildSources(false)
  .filter((s) => s.id !== 'git' && s.tokenLabel)
  .sort((a, b) => TIER_ORDER[a.tier ?? 'personal'] - TIER_ORDER[b.tier ?? 'personal']);
const selected = await p.multiselect({
  message: 'Connect more sources (read-only token paste)? (skip to finish)',
  options: localConnectors.map((s) => ({ value: s.id, label: s.label, hint: s.description })),
  required: false,
});
if (!p.isCancel(selected)) {
  for (const id of selected as string[]) {
    const source = localConnectors.find((s) => s.id === id)!;
    console.log(''); p.log.step(chalk.bold(source.label));
    const tokens = await collectTokens(source);          // paste path (ignores oauthKey)
    if (!tokens) continue;
    const spinner = p.spinner(); spinner.start(`Fetching from ${source.label}...`);
    try {
      const items = await source.fetch(tokens);
      spinner.stop(`Found ${items.length} items`);
      if (items.length) await runPersonalImport(items, localClient, { label: source.label, approve: true, appUrl: resolveAppUrl(localEnv) });
    } catch (e) { spinner.stop(`Skipped ${source.label} - ${(e as Error).message}`); }
  }
}
```
(Place before the final `p.outro`.)

### 2.3 REFACTOR
De-dup the fetch+import shape with the cloud loop if cheap; otherwise leave (local is simpler — no OAuth/re-auth path).

---

## Phase 3: B3 + B4 — exclusions & skip

### 3.1 RED
- Test: the local connector options do **not** include `teams` or `zoom`.
- Test: empty multiselect → no `p.password`, finishes (outro) — git-only preserved.

### 3.2 GREEN
Covered by the `.filter(s.tokenLabel)` (teams/zoom have none) and the `if (!isCancel) for(...)` guard. Add nothing unless tests fail.

---

## Rollback Plan
Revert the `runLocalSetup` block + the token-metadata additions. Cloud path and existing local git-only behavior are independent (metadata is inert in cloud).

## Open Questions
- GitHub read-only PAT: classic `repo` is read+write; fine-grained read-only is the real read-only path. Hint steers to fine-grained read. Accept (local is the user's own machine/token) or also note classic limitation? (Proposed: hint to fine-grained read-only, accept.)
- Slack user-token (`xoxp`) in local still needs an app with read scopes (same as the manual `align import slack` path). Acceptable for the privacy/offline tier?
