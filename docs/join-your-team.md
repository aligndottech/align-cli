# Join your team's graph

Your own graph lives on your laptop. Your team's graph lives on a server: one Align hosts for you,
or one you run yourself. `align join` connects the two without moving anything you already have.

## For the person joining

Your admin sends you a link. You run:

```bash
align join '<the link>'
```

Keep the quotes. The link has `&` in it.

What happens, in order:

1. The CLI asks the server about the invite. Nothing is saved and no browser opens yet.
2. It prints the two servers it is about to trust, the gateway and the web app, and the org name
   the server claims. **If the gateway is not under `align.tech`, you type its host back to confirm.**
   That is the check against a link someone sent you by mistake or on purpose.
3. Your browser opens the web app. You sign in and click **Give the Align CLI on this computer access**.
4. The server hands the CLI a new token for that org only. The CLI checks it works, then saves it as a
   named destination (the name comes from the org, or `--name`).

It never moves your decisions, never archives a workspace, never expires a token you already have.
Your first destination becomes where `align share` goes. A later join asks before changing that.

The access expires after 90 days. The CLI prints the date. Renew it with:

```bash
align login --env <name>
```

### No browser on this machine (SSH, a container)

Joining needs a browser on the same computer. Make a token in the web app instead and save it:

```bash
align login --env <name> --token <token>
```

That needs the destination to exist already, so join once from a machine with a browser.

### Flags

| Flag | Use |
|---|---|
| `--name <name>` | What to call it. 2 to 32 lowercase letters, digits or hyphens, starting with a letter. `prod`, `preview`, `local` and a few other words are reserved. |
| `--gateway <url>` | The server, for a link that does not carry one. |
| `--confirm-host <host>` | Confirm the host without a prompt. Required when there is no terminal. |
| `--replace` | Replace a destination with the same name. |
| `--make-share-destination` | Make this the share destination without asking. |

### Using it

```bash
align share --all-ratified          # goes to your share destination
align share <id> --to prod          # one share somewhere else
align ask 'why did we ...' --env acme
align env list                      # your destinations, with both hosts
align logout --env acme             # removes the token, keeps the destination
```

A share always prints the gateway host it goes to, on the `To:` line, before you say yes.

## What the CLI refuses

- A gateway or web app on plain `http`, except `localhost`.
- A link whose gateway or web app differs from what the server says about itself.
- An unknown `--env` name. It never falls back to prod.
- Using `ALIGN_TOKEN`, `ALIGN_TENANT_ID` or `ALIGN_GATEWAY_URL` for a named destination. They only apply to
  the built-in environments.

## For the admin

```bash
align invite dan@yourcompany.example
```

prints a link. Send it to one person: it works once and expires in 7 days. Listing and revoking invites is
available on the gateway admin API.

### Self-hosted

The link carries your gateway address, so the gateway has to know its own public address:

- Tell the gateway its own public address, for example `https://api.acme.example`. With Helm set
  `gateway.apiBaseUrl` (or the gateway ingress host, which the chart falls back to). Without Helm set
  `PUBLIC_GATEWAY_URL`. It must be `https`, or `http` on `localhost`. The chart's defaults give
  `https://api.align.tech`, so a self-host that leaves them alone writes the wrong address into every link;
  the CLI then refuses the link because the gateway disagrees with it.
- Set `FRONTEND_URL` to the public address of your web app. The CLI uses the address the gateway reports, so a
  wrong value here sends approval links to the wrong place.

Without `PUBLIC_GATEWAY_URL` the link has no gateway, and the person joining must pass `--gateway`.
