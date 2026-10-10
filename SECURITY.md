# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report them privately via GitHub's **"Report a vulnerability"** button on the
[Security tab](https://github.com/aligndottech/align-cli/security/advisories/new)
of this repository. If you cannot use GitHub Security Advisories, email
**security@align.tech**.

We aim to acknowledge reports within a few business days and will keep you updated
on the fix and disclosure timeline.

## Scope

This repository is the open-source Align CLI and MCP server (`@aligndottech/cli`).

- The CLI connects to your tools **read-only** and stores data either in your own
  personal Align cloud tenant or, with `--local`, in a SQLite database on your
  machine. In `--local` mode the CLI never sends your decisions to Align. What does
  use the network there: a one-time embedding-model download from huggingface.co;
  read-only calls to whichever tools you import from, using the token you supply;
  and, when an AI provider is available (an API key, or a running Ollama, which
  needs none and honours `OLLAMA_HOST`), `align ask`, `align check` and the MCP
  `align_check_alignment` tool calling that provider.
  [docs/local-mode.md](docs/local-mode.md) covers this in detail.
- The hosted Align gateway/graph is a separate service; vulnerabilities in the
  hosted product should also be reported through the channel above.

## Supported versions

We support the latest published version on npm. Please upgrade to the latest
release before reporting, in case the issue is already fixed.

## Sharing from inside a coding agent (`align share`, `align_share`)

`align share` sends decisions from your local graph, and your judgements on them, to your team's
graph. It prints exactly what leaves the machine and names the workspace and account. A
credential-shaped string in a title, summary, URL or note, and any hidden tag characters, are refused on
this machine, and the credential check runs again on the server. There is no `--yes`.

**Who approves depends on the workspace's gateway.** The CLI asks it (`GET /share-requests/config`).

- **Browser approval** (mode `available`, or `required`). The CLI seals the exact payload with AES-256-GCM
  under a random key, sends only the ciphertext to your team's gateway, and prints a link and a short code.
  The key is in the link's `#k=` fragment, which a browser never sends, so the server holds text it cannot
  read until you approve. You open the link in a browser where you are signed in to Align, compare the code,
  read the full text and the destination, and click Approve. Only then does the CLI send the approved bytes.
  Declined, cancelled and expired requests send nothing; Ctrl-C cancels the request.
- **Typed answer** (mode `off`, a gateway without the route, or `--typed` when the mode is `available`). The
  preview is shown on the controlling terminal (`/dev/tty`, or `CONIN$` on Windows) and asks with a default of
  No. A process with no controlling terminal is refused, and so is a run inside an agent that `align` launched
  (`ALIGN_WRAPPED`). That last check is a speed bump, not a lock: an agent can unset the variable.
- **`required`** never reaches the typed path: `--typed` and `--confirm` are refused, and the CLI never posts a
  share directly. If the gateway's answer to the config call is anything but a clean mode or a 404, the CLI
  stops. It never falls back to the typed path on an error.

**What an agent can do.** It can ask: `align share` run inside an agent, and the `align_share` MCP tool, stage a
request and hand you the link and code. `align_share_status` reports whether you answered and, only when the
gateway says you approved, sends exactly what you approved, once, with the same token that staged it. The gateway
refuses the CLI's own token on the approve route, so the agent's CLI credential cannot approve. **That is not the
same as an agent being unable to approve.** Approval needs an authenticated browser session, and an agent can
still obtain one:

- If it can read your mailbox, it can request an email one-time code or magic link and log in with `curl`.
  That session counts as a human one today.
- If it can read your browser's cookie files, or drive your browser (computer use, an extension, Chrome's
  debugging port), it holds or can use a session.
- Production session cookies are set for `.align.tech`, so any server on a sibling `*.align.tech` host receives
  them.

So browser approval raises the bar from one shell line to needing your mailbox or your cookies, and it records
which credential staged the request. **It is not a lock** until a passkey or other step-up credential is added to
the approve step, which is planned and not built. The agent that stages a request also sees the link, and so
the key; it already had the text it sealed, so that adds nothing, but the link is not a secret from the agent.
The code on the page is not a secret either: an agent that runs the CLI relays its own link and code, so only
reading the content on the page defends against a request you did not mean to make.

**Opening the link.** At an interactive terminal on a machine with a browser, `align share` opens the link for
you. On a remote machine, scan the QR code it prints with your phone; approving on a phone with Face ID or a
fingerprint is the strongest way. The link is not a secret from the agent that ran the command, and the QR code is
the same link, so neither is a lock. Before the link reaches a browser launcher, the CLI checks the whole string
against one exact shape (https, the configured app's host, `/share/approve/<id>`, a 43-character key in the
fragment) and starts the launcher with an argument list, never a shell string. On Linux and macOS the launcher's command
line holds the whole link, key included, while it runs, so another local user could read it with `ps`; the key alone
cannot approve anything (that needs your signed-in session and, where enabled, your passkey). Use `--no-open` and the QR
code if that matters on a shared machine.

> **What else this does NOT stop.**
> - **The control only holds once the gateway runs `required`.** In `available`, the browser flow exists but the
>   other ways to complete a share still work: the typed answer on a pseudo-terminal an agent allocates itself
>   (for example with `script`), and a direct call to the gateway with the CLI's token. This CLI cannot change
>   that. The same token can also record ratifications, supersessions and conflict resolutions, and clear
>   alignment checks, through other routes, until the gateway refuses it on them. Until your gateway reports
>   `required` and enforces it on those routes, the remaining control is your agent harness's own approval
>   prompt for shell commands: do not auto-approve commands that run `align share` or open a pseudo-terminal.
> - A share is always attributed to the signed-in user. It can usually be retracted with
>   `align share --retract`, but not always: a share that matched an existing team decision, or was recorded as
>   not yours, cannot be retracted from here, and the judgements it carried stay on the team graph.
> - A share stays on the team graph after you leave. If an admin erases your account, Align removes your name and
>   your judgements from every decision you shared. The decisions stay as the team's record and other people's
>   judgements on them stay. Erasure does not edit the decision text; if it names you or holds your personal data,
>   ask your admin for a separate content removal, which does not exist yet.

Only items that carry a `client_key` are staged (every share item does), so a request can never be a plain
capture that overwrites a teammate's row.

`align_share` (the MCP tool) never sends. On a gateway without browser approval it returns the preview and a
one-time code the person completes with `align share --confirm`, and it tells the agent not to run that. The
code works once, expires after 10 minutes, and is refused if the decision, its judgements, the workspace or
the gateway changed after the preview. Staged browser requests (MCP path only) are kept 0600 in the CLI's private state
directory, because they hold the key and the sealed text. A file is deleted when `align_share_status` finds the
request declined, expired, cancelled, failed or completed; when `align_share` is asked again and finds the earlier
request ended; and by a sweep that runs at the start of each `align share`, `align_share` and `align_share_status`
and removes any file more than 11 minutes past its request's expiry. A request nobody ever checks therefore
stays on disk until one of those runs, and at most 24 hours in any case. The `align share` command keeps the key in
memory and writes no such file.

When the gateway has no browser approval (no route, or mode `off`), `align share` says so on one line before it asks
at the terminal: it does not downgrade silently. A run inside an agent that `align` launched marks its request with
the agent label `wrapped`, so the page can tell it from a person's run (a label the CLI claims, like the machine
name). Every call to the share-request routes has a 15 second deadline (30 for the completion), a size cap on the
answer, and an abort that Ctrl-C reaches; the wait is clamped to the gateway's own lifetimes however far off it
says a request expires.
