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

## npm

```bash
npm install -g @aligndottech/cli
align
```

Node 22.16 or newer, which is the floor in this package's `engines` field. The local graph is a
SQLite file held through `node:sqlite`, and 22.16 is where that module is unflagged and
`DatabaseSync.isTransaction` exists. npm warns rather than stops on an older runtime, so check
`node --version` yourself if `align` behaves oddly on first run.

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
align                # set up, then see your graph and what to do next
align mcp --setup    # find your AI clients, then wire the ones you pick
```

[MCP server](mcp.md) has the per-client config, including VS Code and the JetBrains IDEs.
