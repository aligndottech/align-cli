# Join your team's graph

Your own graph lives on your laptop. Your team's graph lives on a server: one Align hosts for you,
or one you run yourself. `align join` connects the two without moving anything you already have.

## For the person joining

Your admin sends you a link. You run:

```bash
align join '<the link>'
```

Keep the quotes. The link has `&` in it.

**You have to run this yourself, in your own terminal.** It refuses when input or output is not a
terminal, and inside an agent that `align` launched. There is no flag to get around that, on purpose: joining
gives a server a credential and a place to send your decisions, so a person answers the questions. (An agent that
opens its own pseudo-terminal can still get past a terminal check. That is a limit of any such check, not something
this command solves.)

What happens, in order:

1. The CLI asks the server about the invite. Nothing is saved and no browser opens yet.
2. It prints the two servers it is about to trust, the gateway and the web app, and the org name
   the server gives. That name is chosen by the organisation and is not verified by Align, so it is never a reason
   to trust a link. **If the gateway is not under `align.tech`, you type its host back to confirm. If it is,
   you type `y`.** That is the check against a link someone sent you by mistake or on purpose.
3. Your browser opens the web app. You sign in and click **Give the Align CLI on this computer access**.
4. The server hands the CLI a new token for that org only. The CLI checks it works, then saves it as a
   named destination (the name comes from the org, or `--name`).

It never moves your decisions, never archives a workspace, never expires a token you already have.
It then asks whether `align share` should go to this destination from now on. Nothing sets that for you:
only a `y` does, and the output says "Shares from this machine now go to ...". A later join asks again before
changing it.

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
| `--replace` | Replace a destination with the same name. It shows the old and the new host, makes you type the new host, and asks again if the destination is where your shares go. |

### Using it

```bash
align share --all-ratified          # goes to your share destination
align share <id> --to prod          # one share somewhere else
align ask 'why did we ...' --env acme
align env list                      # your destinations, with both hosts
align logout --env acme             # removes the token, keeps the destination
```

A share prints the gateway host and the org name it goes to, on the `To:` line, before anything is staged. When the
workspace approves shares in the browser, your yes is on that web page, after the preview; when it uses the typed
answer, the yes is at your terminal, after the same preview. The org name there is the organisation's own, and the
line says Align does not verify it.

## What the CLI refuses

- A gateway or web app on plain `http`, except `localhost`.
- A link whose gateway or web app differs from what the server says about itself.
- Joining without a terminal, or inside an agent.
- A link that carries a gateway the server does not confirm as its own. The join page is also told which gateway the
  CLI expects, and refuses a link that points at another one.
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
