# Changelog

## [0.8.1](https://github.com/aligndottech/align-cli/compare/cli-v0.8.0...cli-v0.8.1) (2026-08-03)


### Bug Fixes

* **check:** make the editor hook fit its budget, and never fail silently ([#88](https://github.com/aligndottech/align-cli/issues/88)) ([0386b7d](https://github.com/aligndottech/align-cli/commit/0386b7dd2bec3be067127c6d99310cfc9eb1950a))
* **mcp:** give align_ask the repository, citation and relevance floor it never had ([#90](https://github.com/aligndottech/align-cli/issues/90)) ([1357d83](https://github.com/aligndottech/align-cli/commit/1357d83730d0daba1b3ebb348d4946d994010629))

## [0.8.0](https://github.com/aligndottech/align-cli/compare/cli-v0.7.1...cli-v0.8.0) (2026-08-02)


### Features

* **check:** add OpenCode to the deterministic edit guardrail ([#87](https://github.com/aligndottech/align-cli/issues/87)) ([f4661c5](https://github.com/aligndottech/align-cli/commit/f4661c5b27dc4d1d9011f92f56804aed09f567c8))
* **check:** make the deterministic edit guardrail agent-agnostic (pi, Gemini CLI) ([#86](https://github.com/aligndottech/align-cli/issues/86)) ([ef52217](https://github.com/aligndottech/align-cli/commit/ef52217c2a33e3c5983580c5a8483ba65d629344))
* **setup:** add pi as an MCP setup target and write a shared .mcp.json ([#85](https://github.com/aligndottech/align-cli/issues/85)) ([0e53c8d](https://github.com/aligndottech/align-cli/commit/0e53c8d487f5bfd3382e77ebc4708de62a27ebfb))


### Bug Fixes

* **mcp:** reject a tool call missing a required argument, naming it (ALI-425) ([#83](https://github.com/aligndottech/align-cli/issues/83)) ([20ff703](https://github.com/aligndottech/align-cli/commit/20ff70346e8c623d564b1058e95d711115c7cfb2))

## [0.7.1](https://github.com/aligndottech/align-cli/compare/cli-v0.7.0...cli-v0.7.1) (2026-08-01)


### Bug Fixes

* **deps:** replace @xenova/transformers with @huggingface/transformers (ALI-424) ([#82](https://github.com/aligndottech/align-cli/issues/82)) ([ac90653](https://github.com/aligndottech/align-cli/commit/ac90653d585bf065d05e00f86ab4687104550eee))
* **import:** pass --approve and --env through to import subcommands (ALI-422) ([#79](https://github.com/aligndottech/align-cli/issues/79)) ([2dfd673](https://github.com/aligndottech/align-cli/commit/2dfd673be9df40f58dc24680538915575e735a39))
* **mcp:** back the MCP server with the local graph for a no-account user (ALI-423) ([#81](https://github.com/aligndottech/align-cli/issues/81)) ([46e87da](https://github.com/aligndottech/align-cli/commit/46e87da7a7915f29685836ac26814b314a67968c))

## [0.7.0](https://github.com/aligndottech/align-cli/compare/cli-v0.6.0...cli-v0.7.0) (2026-08-01)


### Features

* **cli:** identify the CLI to the gateway and record one usage event per command (ALI-403) ([#77](https://github.com/aligndottech/align-cli/issues/77)) ([b19c9b2](https://github.com/aligndottech/align-cli/commit/b19c9b2f5ebacd95a19494cfe65eff192f2e99a8))

## [0.6.0](https://github.com/aligndottech/align-cli/compare/cli-v0.5.0...cli-v0.6.0) (2026-08-01)


### Features

* **cli:** autonomous "what your graph did for you" value readout (ALI-215) ([#74](https://github.com/aligndottech/align-cli/issues/74)) ([5cbf841](https://github.com/aligndottech/align-cli/commit/5cbf841fd3b776bb9c7aefdecb2459c9061e3eff))


### Bug Fixes

* **check:** add an explicit "unknown" state so a check that could not run stops reporting "aligned" (ALI-414) ([#76](https://github.com/aligndottech/align-cli/issues/76)) ([c0ea263](https://github.com/aligndottech/align-cli/commit/c0ea263f2c9b109841835af495906f82204ee9fe))
* **local:** consume canonical relationship contract, drop invented types (ALI-219) ([#73](https://github.com/aligndottech/align-cli/issues/73)) ([4fdbdb1](https://github.com/aligndottech/align-cli/commit/4fdbdb17cff07641b58be0d20bfb40a6848d202a))
* **local:** deterministic offline relationship detection (ALI-218) ([#71](https://github.com/aligndottech/align-cli/issues/71)) ([9f3dbae](https://github.com/aligndottech/align-cli/commit/9f3dbae8c641f1932113b4c59279b9cd00501f17))

## [0.5.0](https://github.com/aligndottech/align-cli/compare/cli-v0.4.2...cli-v0.5.0) (2026-06-28)


### Features

* **setup:** make MCP setup agent-agnostic ([#69](https://github.com/aligndottech/align-cli/issues/69)) ([de2a4b9](https://github.com/aligndottech/align-cli/commit/de2a4b99158f5387ba03aa39245441ab75bd98d1))

## [0.4.2](https://github.com/aligndottech/align-cli/compare/cli-v0.4.1...cli-v0.4.2) (2026-06-27)


### Bug Fixes

* **ALI-169:** offer expired-token reconnect for all connectors, not just Atlassian ([#67](https://github.com/aligndottech/align-cli/issues/67)) ([ce0b729](https://github.com/aligndottech/align-cli/commit/ce0b72985ba1768a834158f03db24eea57a95f8c))

## [0.4.1](https://github.com/aligndottech/align-cli/compare/cli-v0.4.0...cli-v0.4.1) (2026-06-27)


### Bug Fixes

* **ALI-160:** repair CLI first-run launch-blockers (local mode, ask/search/check, import git) ([#62](https://github.com/aligndottech/align-cli/issues/62)) ([c2d67a0](https://github.com/aligndottech/align-cli/commit/c2d67a02a488bbbe778a8e48fe35be1be0dc772f))
* **ALI-165:** make npm i -g robust (optional native ML dep) + OSS hygiene ([#65](https://github.com/aligndottech/align-cli/issues/65)) ([651bfa0](https://github.com/aligndottech/align-cli/commit/651bfa0a88a722d5713d07639e094d0deaf9941d))

## [0.4.0](https://github.com/aligndottech/align-cli/compare/cli-v0.3.0...cli-v0.4.0) (2026-06-03)


### Features

* **llm:** provider-agnostic resolver - generic OpenAI-compatible base URL + Grok (ALI-133) ([#58](https://github.com/aligndottech/align-cli/issues/58)) ([64f0ec0](https://github.com/aligndottech/align-cli/commit/64f0ec0c4dea8bde3630337f3f3e64b087bb1694))

## [0.3.0](https://github.com/aligndottech/align-cli/compare/cli-v0.2.0...cli-v0.3.0) (2026-06-02)


### Features

* **setup:** raise free-tier import limits to 250 (connector-core 0.2.0 pagination) ([#56](https://github.com/aligndottech/align-cli/issues/56)) ([1dfbbf2](https://github.com/aligndottech/align-cli/commit/1dfbbf22ce682333e56e1118122e774a71e9c0da))

## [0.2.0](https://github.com/aligndottech/align-cli/compare/cli-v0.1.4...cli-v0.2.0) (2026-06-02)


### Features

* wire CLI onto @aligndottech/connector-core [ALI-127] ([#52](https://github.com/aligndottech/align-cli/issues/52)) ([bfb00f3](https://github.com/aligndottech/align-cli/commit/bfb00f3101d210bc1c81bd6ea6c9400abc21ebdc))


### Bug Fixes

* **setup:** one OAuth for shared Atlassian app on reconnect [ALI-130] ([#53](https://github.com/aligndottech/align-cli/issues/53)) ([93a7d70](https://github.com/aligndottech/align-cli/commit/93a7d70f27029e9c1d9c143f1a55f2fb65a75210))
