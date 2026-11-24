# Installing

Two ways in, and both give you the same `align` command.

## The binary, with no Node

```bash
curl -fsSL https://align.tech/install.sh | sh
align
```

One file. Linux, macOS and Windows, x64 and arm64, glibc and musl. You can read
[install.sh](../install.sh) before you pipe it anywhere.

It checks the download against the release's own `SHA256SUMS` and refuses to install on a
mismatch. Two cases it cannot check, and in both it prints `checksum NOT verified` to stderr and
carries on rather than stopping: a release with no `SHA256SUMS`, and a machine with neither
`sha256sum` nor `shasum` on it. That is deliberate, and it means a successful install is not by
itself proof the checksum was verified. Read the line.

`install.sh` is a POSIX shell script. It picks your asset from `uname -s` and `uname -m`, and
the only Windows values it recognises are the ones Git Bash, MSYS and Cygwin report. PowerShell
has no `sh` to pipe into, so **that line does not run in PowerShell at all**. Use npm below, or
download the file by hand.

It installs to `/usr/local/bin` if that is writable, else `~/.local/bin`. Set `ALIGN_INSTALL_DIR`
to choose another directory. It tells you if the directory is not on your `PATH`.

## npm

```bash
npm install -g @aligndottech/cli
align
```

Node 22.19 or newer, which is the floor in this package's `engines` field, set by the agent engine. The local graph is a
SQLite file held through `node:sqlite`, which needs 22.16, where that module is unflagged and
`DatabaseSync.isTransaction` exists. npm warns rather than stops on an older runtime, but `align`
itself checks first: on an older Node it prints the version it found and the floor, and exits 1.

**On Linux, local mode on the npm package needs glibc.** Its on-device embedding runtime (ONNX Runtime) does not load
on musl, so it does not work on Alpine (`node:22-alpine`). Use a glibc image such as `node:22-bookworm-slim`. On Alpine
local mode stops with a message naming that cause, before it downloads anything, and cloud mode (`align login`) is
unaffected. Alpine is not supported for local mode.

## Windows

With Node already installed, in PowerShell:

```powershell
npm install -g @aligndottech/cli
align
```

If `align` is not found afterwards, npm's global prefix is not on your `PATH`. `npm prefix -g`
prints the directory, and `align.cmd` is the file to look for inside it.

With no Node, take the binary from the
[releases page](https://github.com/aligndottech/align-cli/releases/latest):
`align-windows-x64.exe`, or `align-windows-arm64.exe` on an arm machine. Rename it to
`align.exe` and put it somewhere on your `PATH`.

`install.sh` does work on Windows under **Git Bash** or **WSL**. It does not work anywhere else
on that platform, and it tells you so rather than guessing.

## After installing

```bash
align                # set up, then open Align's agent on your graph
align mcp --setup    # find your AI clients, then wire the ones you pick
```

[MCP server](mcp.md) has the per-client config, including VS Code and the JetBrains IDEs.

## Claude Code plugin

```
/plugin marketplace add aligndottech/align-cli
/plugin install align-cli@aligndottech
```

This adds the Align MCP server and the edit-time decision check as plugin hooks. Both run
through `npx`, so no global install is needed. Installing it writes no hooks or settings into
your user or project config. Once Align is set up, the hook keeps a small marker in a private
temp folder so it doesn't repeat the same decision on back-to-back edits.

The plugin starts with no decisions to check against, and until you set Align up the hook says
nothing and writes nothing. The MCP tools need a graph too. Set Align up once, from the repo you
are in:

```
npx @aligndottech/cli
```

It builds the graph from the repo. When it asks to change your agent config, say no: the plugin
already adds the check. After that, `npx @aligndottech/cli connect docs` or `connect git` pulls
in more.

Already ran `align setup` in a project? It wrote the same checks into `.claude/settings.json`,
so with the plugin an edit can be checked twice. Remove the Align hooks from that file, or skip
the plugin.

If you installed it as `align@aligndottech` before the rename, run
`/plugin uninstall align@aligndottech` first, then the install line at the top of this section. In Codex, run
`codex plugin remove align@aligndottech`, then the install line in the Codex section below.

## Codex plugin

```
codex plugin marketplace add aligndottech/align-cli
codex plugin add align-cli@aligndottech
```

This adds the same MCP server and an edit check that is meant to run before each `apply_patch`. Codex's hook is written from the vendor docs. We have seen it run in `codex exec` on Codex CLI 0.153.0 (18 Nov 2026), before and after each of 9 edits, once it was approved. No payload from those runs is saved, so [hook coverage](hook-coverage.md) still lists it as not tested, and an interactive session has not been checked. Codex
installs the plugin without trusting its hooks, so the check does nothing until you open Codex
once and approve it in the hook review. `codex exec` never asks. Like the Claude Code plugin,
installing it writes no hooks or settings into your config, and it stays silent until Align is set up. If you also ran
`align setup`, remove one of the two Align hooks or an edit can be checked twice.
