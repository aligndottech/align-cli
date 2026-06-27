# Contributing to Align CLI

Thanks for your interest in improving the Align CLI. It is MIT-licensed and
contributions are welcome.

## Getting started

```bash
git clone https://github.com/aligndottech/align-cli
cd align-cli
npm install            # uses npm (package-lock.json), NOT pnpm
npm run dev -- --help  # run the CLI from source
```

Node 20 or newer is required.

## Before you open a PR

Run the full local gate:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
npm run build       # tsc -> dist/
```

All four must pass. Tests are run with coverage in CI against a ratchet floor, so
add tests for new behaviour - the suite drives RED -> GREEN -> REFACTOR (test the
public behaviour, mock only at module/network boundaries).

## Conventions

- **Package manager:** `npm` only. Do not introduce a `pnpm-lock.yaml`.
- **Commits:** conventional-commit style (`fix:`, `feat:`, `test:`, `docs:`, ...).
  Releases are automated from the commit history.
- **No em-dashes** in code comments or docs - use a regular hyphen or " - ".
- **Don't publish manually.** Publishing is gated on a `v*` git tag.

## What lives where

- This repo is the open-source CLI + MCP server.
- The connector SDK (read-only fetchers + transport) lives in
  [`align-connector-sdk`](https://github.com/aligndottech/align-connector-sdk).
- The hosted decision graph + relationship detection is a separate commercial
  gateway and is not in this repo.

## Reporting bugs / security

- Bugs: open an issue with the version (`align --version`), OS, and Node version.
- Security: see [SECURITY.md](./SECURITY.md) - please report privately, not as a
  public issue.
