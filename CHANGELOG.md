# Changelog

## [0.31.1](https://github.com/aligndottech/align-cli/compare/cli-v0.31.0...cli-v0.31.1) (2026-09-01)


### Bug Fixes

* **e2e:** assert the WIRE format - stage is a client payload field, cli.funnel.* is server-derived ([#217](https://github.com/aligndottech/align-cli/issues/217)) ([bcb4ca0](https://github.com/aligndottech/align-cli/commit/bcb4ca072f2be09bb86d01659ce85289e0e8a03d))

## [0.31.0](https://github.com/aligndottech/align-cli/compare/cli-v0.30.0...cli-v0.31.0) (2026-09-01)


### Features

* **import:** read the commit body and merges, extract refs, cite git decisions (ALI-792) ([#213](https://github.com/aligndottech/align-cli/issues/213)) ([f6d222a](https://github.com/aligndottech/align-cli/commit/f6d222ab81270a85a03e169c140266a7a2b30396))
* **release:** staged releases with a real-user E2E gate and one-command promotion ([#216](https://github.com/aligndottech/align-cli/issues/216)) ([07bd555](https://github.com/aligndottech/align-cli/commit/07bd555fed44f4758c95e3d7f9cc64600962d183))
* **telemetry:** funnel-stage emitters - first_useful_decision, import_completed, mcp_wired ([#215](https://github.com/aligndottech/align-cli/issues/215)) ([9dad6fd](https://github.com/aligndottech/align-cli/commit/9dad6fd0d315bdb06f7ecfd3934b8d1d43243f7c))

## [0.30.0](https://github.com/aligndottech/align-cli/compare/cli-v0.29.1...cli-v0.30.0) (2026-09-01)


### Features

* **local:** relative linking - each decision's top-3 neighbours join the graph (ALI-785) ([#212](https://github.com/aligndottech/align-cli/issues/212)) ([dbfccbf](https://github.com/aligndottech/align-cli/commit/dbfccbf5cf5708c8defe64be140d108ce83d492f))


### Bug Fixes

* **setup:** open Notion at the developer console's tokens page ([#210](https://github.com/aligndottech/align-cli/issues/210)) ([c85cccc](https://github.com/aligndottech/align-cli/commit/c85cccc7f441467a19573a62b43b3ce331351d50))

## [0.29.1](https://github.com/aligndottech/align-cli/compare/cli-v0.29.0...cli-v0.29.1) (2026-08-31)


### Bug Fixes

* **setup:** Notion tokens are ntn_ now, and Atlassian facts are asked once ([#208](https://github.com/aligndottech/align-cli/issues/208)) ([25e1495](https://github.com/aligndottech/align-cli/commit/25e149510482f787e04eb0626607f3209da3d627))

## [0.29.0](https://github.com/aligndottech/align-cli/compare/cli-v0.28.1...cli-v0.29.0) (2026-08-31)


### ⚠ BREAKING CHANGES

* **setup:** upgrade clack to 1.x, ending doubled keystrokes and phantom submits ([#207](https://github.com/aligndottech/align-cli/issues/207))

### Features

* **setup:** open Linear at the key-creation dialog, not the settings landing ([#205](https://github.com/aligndottech/align-cli/issues/205)) ([c0724e4](https://github.com/aligndottech/align-cli/commit/c0724e4c6ea24548ce1db67db1ff8a8e1861953a))


### Bug Fixes

* **setup:** upgrade clack to 1.x, ending doubled keystrokes and phantom submits ([#207](https://github.com/aligndottech/align-cli/issues/207)) ([2d11fcc](https://github.com/aligndottech/align-cli/commit/2d11fcce96f01e2fe2a5b9705119a8c43ecb612d))

## [0.28.1](https://github.com/aligndottech/align-cli/compare/cli-v0.28.0...cli-v0.28.1) (2026-08-31)


### Bug Fixes

* **setup:** always print token URLs so a failed browser-open is never a dead end ([#203](https://github.com/aligndottech/align-cli/issues/203)) ([86e3a3f](https://github.com/aligndottech/align-cli/commit/86e3a3f2d4531d2a8a8374bd92ed06096cee82f5))

## [0.28.0](https://github.com/aligndottech/align-cli/compare/cli-v0.27.0...cli-v0.28.0) (2026-08-31)


### Features

* **brand:** the mark at 20x6, downscaled from the approved sprite ([#200](https://github.com/aligndottech/align-cli/issues/200)) ([5f28e19](https://github.com/aligndottech/align-cli/commit/5f28e199d6aa7932eb48ed068b6c2aa648e99c41))


### Bug Fixes

* **setup:** end the Bun prompt-crash class, not another instance of it ([#199](https://github.com/aligndottech/align-cli/issues/199)) ([7ddd541](https://github.com/aligndottech/align-cli/commit/7ddd5418c05d2b520ddc5876c02f351a6704a03a))

## [0.27.0](https://github.com/aligndottech/align-cli/compare/cli-v0.26.3...cli-v0.27.0) (2026-08-31)


### ⚠ BREAKING CHANGES

* **local:** true local is PAT-only for every connector; OAuth is the cloud path ([#198](https://github.com/aligndottech/align-cli/issues/198))

### Features

* **local:** secret-free OAuth for GitHub, GitLab, Linear and Zoom (ALI-778) ([#194](https://github.com/aligndottech/align-cli/issues/194)) ([b0de840](https://github.com/aligndottech/align-cli/commit/b0de8407990cc8783677e2269c8d4cee55ba7dd7))
* **local:** true local is PAT-only for every connector; OAuth is the cloud path ([#198](https://github.com/aligndottech/align-cli/issues/198)) ([96ba9a9](https://github.com/aligndottech/align-cli/commit/96ba9a9879d4c03f1d4a327a47693b27b23413ea))
* **setup:** say why true local needs a pasted token ([#193](https://github.com/aligndottech/align-cli/issues/193)) ([4245272](https://github.com/aligndottech/align-cli/commit/42452723477955259c623d1810e696961231c80e))


### Bug Fixes

* **local:** make secret-free OAuth actually reachable, and say the true reason when it is not ([#196](https://github.com/aligndottech/align-cli/issues/196)) ([8318fdc](https://github.com/aligndottech/align-cli/commit/8318fdcdcda586db6676f8930540341f4f7e12fc))
* **local:** one read-only GitHub path, and verify the App can actually see anything ([#195](https://github.com/aligndottech/align-cli/issues/195)) ([c433396](https://github.com/aligndottech/align-cli/commit/c4333965955e7c433ff6fb7a86553ab4129b7a29))
* **setup:** guard every crashing prompt, not just the password one ([#191](https://github.com/aligndottech/align-cli/issues/191)) ([3d83e46](https://github.com/aligndottech/align-cli/commit/3d83e466240a2053624219e816c7a2db1f7c97c8))

## [0.26.3](https://github.com/aligndottech/align-cli/compare/cli-v0.26.2...cli-v0.26.3) (2026-08-31)


### Bug Fixes

* **setup:** crashing prompt no longer kills the run; mark derived from the real logo ([#189](https://github.com/aligndottech/align-cli/issues/189)) ([c253798](https://github.com/aligndottech/align-cli/commit/c2537987698d1f52652db417ae0bc39c26769679))

## [0.26.2](https://github.com/aligndottech/align-cli/compare/cli-v0.26.1...cli-v0.26.2) (2026-08-31)


### Bug Fixes

* **brand:** draw the mark with quadrants, and match the site's headline colours ([#187](https://github.com/aligndottech/align-cli/issues/187)) ([1264883](https://github.com/aligndottech/align-cli/commit/1264883fa64d92df0157516cab86eddd09997e54))

## [0.26.1](https://github.com/aligndottech/align-cli/compare/cli-v0.26.0...cli-v0.26.1) (2026-08-31)


### Bug Fixes

* **ask:** tell people a local model works, because it does ([#185](https://github.com/aligndottech/align-cli/issues/185)) ([3472c68](https://github.com/aligndottech/align-cli/commit/3472c68659757c44b7539920af010e6f1cedeb78))

## [0.26.0](https://github.com/aligndottech/align-cli/compare/cli-v0.25.0...cli-v0.26.0) (2026-08-30)


### Features

* **setup:** ask-first flow, branded CLI, bounded picker, gh token reuse ([#183](https://github.com/aligndottech/align-cli/issues/183)) ([bdd218b](https://github.com/aligndottech/align-cli/commit/bdd218be7c6bab231a749c561b0e4efdfde363b7))

## [0.25.0](https://github.com/aligndottech/align-cli/compare/cli-v0.24.1...cli-v0.25.0) (2026-08-30)


### Features

* **check:** attribute CI checks to platform, PR and head sha (ALI-761) ([#180](https://github.com/aligndottech/align-cli/issues/180)) ([753831a](https://github.com/aligndottech/align-cli/commit/753831a52c4bf359645dfe502279f74a9bf58c4b))
* wire agents automatically, disclose it, and ship the undo (ALI-776) ([#181](https://github.com/aligndottech/align-cli/issues/181)) ([3529d15](https://github.com/aligndottech/align-cli/commit/3529d151557866ad552e68d38d38017346feb1d8))

## [0.24.1](https://github.com/aligndottech/align-cli/compare/cli-v0.24.0...cli-v0.24.1) (2026-08-30)


### Bug Fixes

* a local model gets minutes, not the hosted-API 15 seconds (ALI-775) ([#178](https://github.com/aligndottech/align-cli/issues/178)) ([8cb8881](https://github.com/aligndottech/align-cli/commit/8cb8881a9d21b1f40056d6795a6fdaa7ccede0e1))

## [0.24.0](https://github.com/aligndottech/align-cli/compare/cli-v0.23.1...cli-v0.24.0) (2026-08-30)


### Features

* `align` sets you up, and no command needs an --env flag (ALI-773, ALI-772) ([#176](https://github.com/aligndottech/align-cli/issues/176)) ([eb81028](https://github.com/aligndottech/align-cli/commit/eb8102824a9779a302fd89225a22861041373a90))


### Bug Fixes

* do not claim the graph is empty when only the query matched nothing (ALI-771) ([#174](https://github.com/aligndottech/align-cli/issues/174)) ([92d40d4](https://github.com/aligndottech/align-cli/commit/92d40d48ebf3cc589dc43d2b9ab8312ce7207a9f))
* say how many decisions were actually new on a re-import (ALI-770) ([#173](https://github.com/aligndottech/align-cli/issues/173)) ([c0dac29](https://github.com/aligndottech/align-cli/commit/c0dac29d2ee708f04892801348e1a3de9f9d0206))

## [0.23.1](https://github.com/aligndottech/align-cli/compare/cli-v0.23.0...cli-v0.23.1) (2026-08-30)


### Bug Fixes

* a configured provider that never answered is not "no provider" (ALI-766) ([#170](https://github.com/aligndottech/align-cli/issues/170)) ([6ffb0b1](https://github.com/aligndottech/align-cli/commit/6ffb0b11d5583479d3448db17cf3e2510fe008a9))

## [0.23.0](https://github.com/aligndottech/align-cli/compare/cli-v0.22.0...cli-v0.23.0) (2026-08-30)


### ⚠ BREAKING CHANGES

* engines.node moves from >=20 to >=22.16. That is where node:sqlite is unflagged (22.13) and DatabaseSync.isTransaction exists (22.16). Node 20 is already EOL.

### Features

* on-device embeddings in the standalone binary, via a bundled WASM backend (ALI-744) ([#169](https://github.com/aligndottech/align-cli/issues/169)) ([56c7698](https://github.com/aligndottech/align-cli/commit/56c769875cdaf9fcccd14bf1cab0798bd5a6b7a5))
* ship standalone binaries, and drop the last native dependency (ALI-740) ([#167](https://github.com/aligndottech/align-cli/issues/167)) ([1cd567f](https://github.com/aligndottech/align-cli/commit/1cd567fa6803a887cba9845cc31264add3e31329))
* **telemetry:** anonymous opt-in usage pings for local-only users (ALI-618) ([#165](https://github.com/aligndottech/align-cli/issues/165)) ([1883304](https://github.com/aligndottech/align-cli/commit/18833047c5d5c3a9993d8e89825ef432c94596a3))

## [0.22.0](https://github.com/aligndottech/align-cli/compare/cli-v0.21.2...cli-v0.22.0) (2026-08-29)


### Features

* **action:** name the check_event_id and the remedy on the PR itself (ALI-728) ([#163](https://github.com/aligndottech/align-cli/issues/163)) ([33b7138](https://github.com/aligndottech/align-cli/commit/33b71387bcb182b36595b09bee5d650748883a3f))

## [0.21.2](https://github.com/aligndottech/align-cli/compare/cli-v0.21.1...cli-v0.21.2) (2026-08-28)


### Bug Fixes

* **action:** a WARNING conflict should not block a merge ([63180f4](https://github.com/aligndottech/align-cli/commit/63180f4e5476fa5256e97e7ab830cf73d0f443cd))
* **action:** a WARNING conflict should not block a merge ([4eaaacc](https://github.com/aligndottech/align-cli/commit/4eaaacc00dbf9796eab6a3fe3f2eb72c992684be))
* **action:** mirror every file action.yml resolves, not a list that drifts (ALI-686) ([#160](https://github.com/aligndottech/align-cli/issues/160)) ([3994fb3](https://github.com/aligndottech/align-cli/commit/3994fb3167de5703cb5ca98bf4ce9b5680aae53d))
* **action:** the mirror published an unusable ref, and the test could not see it ([#161](https://github.com/aligndottech/align-cli/issues/161)) ([eae0842](https://github.com/aligndottech/align-cli/commit/eae0842f331bc08c77845ed1ea7bee81cc8c3b84))

## [0.21.1](https://github.com/aligndottech/align-cli/compare/cli-v0.21.0...cli-v0.21.1) (2026-08-27)


### Bug Fixes

* **ci:** cache the embedding model, and stop a huggingface 429 reading as our defect (ALI-713) ([eeed6c1](https://github.com/aligndottech/align-cli/commit/eeed6c1e2fadc82dffb5f072a4be5787e7c8be35))
* **ci:** cache the embedding model, and stop a huggingface 429 reading as our defect (ALI-713) ([b8ec250](https://github.com/aligndottech/align-cli/commit/b8ec250d06f8a3c0e1628948253401c5ec788b2f))
* **search:** a natural-language question no longer misses what its own keywords find (ALI-603) ([32485c0](https://github.com/aligndottech/align-cli/commit/32485c08a94e7da5ad5cdd19d1c1b35a1083d76e))
* **search:** a natural-language question no longer misses what its own keywords find (ALI-603) ([f7c60ed](https://github.com/aligndottech/align-cli/commit/f7c60ed7facb3b9bd2320b14f3411344f9e0999e))
* **search:** see through the punctuation and contractions a real question carries ([6ad1ffb](https://github.com/aligndottech/align-cli/commit/6ad1ffb5bf9042b77eac4214168517288ca471bd))

## [0.21.0](https://github.com/aligndottech/align-cli/compare/cli-v0.20.0...cli-v0.21.0) (2026-08-27)


### Features

* **check:** a human can answer a check that declined to rule (ALI-710) ([6f3dc60](https://github.com/aligndottech/align-cli/commit/6f3dc6066d45d41637f730c9021c57752ef85c7a))
* **check:** a human can answer a check that declined to rule (ALI-710) ([3b805b2](https://github.com/aligndottech/align-cli/commit/3b805b2d845f8123e33f9da7e1c2f5f10bc5d178))
* **check:** deferred adjudication for the advisory hook (ALI-570) ([c9122b6](https://github.com/aligndottech/align-cli/commit/c9122b69096c6cabb3c919abfd1804176b2f9b51))
* **check:** deferred adjudication for the advisory hook (ALI-570) ([d3dcc07](https://github.com/aligndottech/align-cli/commit/d3dcc072fd57c333c99a84120f945a684bda12e3))


### Bug Fixes

* **action:** address the four review comments on the adjudication override (ALI-710) ([b58cd54](https://github.com/aligndottech/align-cli/commit/b58cd54ad23c9532dd3aa8221662de9f80201307))
* **check:** address two fresh-context reviews of the deferred adjudication (ALI-570) ([562c4c3](https://github.com/aligndottech/align-cli/commit/562c4c3656c8b9d5d6f892c09103c7491c5f4164))
* **test:** scope the store permission assertion to POSIX (ALI-570) ([93c82c5](https://github.com/aligndottech/align-cli/commit/93c82c5c1ab08b8b126cb03bed23d93e33a95e8a))

## [0.20.0](https://github.com/aligndottech/align-cli/compare/cli-v0.19.1...cli-v0.20.0) (2026-08-27)


### Features

* **check:** --depth exhaustive - a strict gate pays for the verdict (ALI-708) ([678b50b](https://github.com/aligndottech/align-cli/commit/678b50ba3ff2bdd1ee0ef81c8ce2c35afb1be44f))
* **check:** --depth exhaustive - a strict gate pays for the verdict (ALI-708) ([7491544](https://github.com/aligndottech/align-cli/commit/7491544719a2d03111c62939cbf71110398c4772))


### Bug Fixes

* tell the truth in --block-on-critical's help, fail the smoke loudly on a dropped optional dep, address review ([c9ac6d3](https://github.com/aligndottech/align-cli/commit/c9ac6d3040a04a3c3a75f34cb4008b1587f5bd7d))

## [0.19.1](https://github.com/aligndottech/align-cli/compare/cli-v0.19.0...cli-v0.19.1) (2026-08-26)


### Bug Fixes

* **hook:** stop losing a payload that arrives more than 200ms after the reader attaches ([5ca2cee](https://github.com/aligndottech/align-cli/commit/5ca2ceef55947910e22f0bfaf86e5bfc0d235580))
* **local:** close the setup --local leak, and make the controls able to fail ([33ce2fc](https://github.com/aligndottech/align-cli/commit/33ce2fcbc674893c201e93c6e612b4ffa52099b3))
* **local:** honour the no-phone-home contract, and stop the agent hook calling an LLM ([0f39c6f](https://github.com/aligndottech/align-cli/commit/0f39c6f65a9a63ca97d588aa203b7372ac16e5d8))
* **local:** honour the no-phone-home contract, and stop the agent hook calling an LLM ([5084a0d](https://github.com/aligndottech/align-cli/commit/5084a0d704fcbd9a8dd08b31676bdb49d25fce90))
* **local:** key dedup on (source_url, title) - a constant URL was deleting unrelated decisions ([d339e1a](https://github.com/aligndottech/align-cli/commit/d339e1abdadc389cd2705e7c94265a3a6d00869e))
* **local:** stop duplicating every import, measure the relatedness floor, retract two wrong Windows claims ([8dfd2cf](https://github.com/aligndottech/align-cli/commit/8dfd2cf83bb4fc2ba8939abe04996c878ee82df4))
* **local:** stop duplicating every import, measure the relatedness floor, retract two wrong Windows claims ([859adbf](https://github.com/aligndottech/align-cli/commit/859adbf8b147fc438c667f5191f35054b99badfb))
* **smoke:** run the advisory hook once, and pipe inside the timeout wrapper ([23e90f9](https://github.com/aligndottech/align-cli/commit/23e90f9100ae4107e6b14c951e79bb52e6cb0930))

## [0.19.0](https://github.com/aligndottech/align-cli/compare/cli-v0.18.0...cli-v0.19.0) (2026-08-26)


### Features

* **llm:** advance the fallback chain only on availability failures; discover Ollama models by family (ALI-692) ([41f90d7](https://github.com/aligndottech/align-cli/commit/41f90d783c0047efe9a9b81dd866b8c6f44ce07c))
* **llm:** availability-only fallback + live Ollama family discovery (ALI-692) ([5e54138](https://github.com/aligndottech/align-cli/commit/5e5413881d9192f4b33cd5bae1b2adfb5535f40a))


### Bug Fixes

* **llm:** repair the fallback classification and family floor found by review (ALI-692) ([09d8b91](https://github.com/aligndottech/align-cli/commit/09d8b919c316d7bcc8f9e28ff702920e53645f88))

## [0.18.0](https://github.com/aligndottech/align-cli/compare/cli-v0.17.1...cli-v0.18.0) (2026-08-26)


### Features

* **action:** mirror script to publish the action at a repository root (ALI-686) ([8d3c49e](https://github.com/aligndottech/align-cli/commit/8d3c49e5e32c9390cf95875f5ca4be60e92d00e4))
* **action:** mirror script to publish this action at a repository root ([43d3f52](https://github.com/aligndottech/align-cli/commit/43d3f526e138df282561d598ccb1e934a9424954))


### Bug Fixes

* **ask:** the synthesis prompt licensed confabulation - add the abstention contract, measured ([90634d0](https://github.com/aligndottech/align-cli/commit/90634d025b2565c6485dc76d441194b7a058a06b))
* **ask:** the synthesis prompt licensed confabulation - add the abstention contract, measured ([7721671](https://github.com/aligndottech/align-cli/commit/7721671fb7682d8fc058cbba42f3a38c656113d7))
* **check:** --ci exited 0 when the gateway never answered, so an outage read as a pass ([176ae49](https://github.com/aligndottech/align-cli/commit/176ae49bc9cd0d0d4fae04738403200f418df7f3))
* **check:** --ci outside a git repo exited 1 with no output at all ([6b8afd8](https://github.com/aligndottech/align-cli/commit/6b8afd86a18cc1fec086520357b8dd75dba38ae4))
* **check:** two ways --ci reported a check that could not run as a result (ALI-686) ([a4560c4](https://github.com/aligndottech/align-cli/commit/a4560c41e1649dc2961a46987f091a344c05b528))
* **test:** repair the orphaned `finally` an autofix left in action-mirror ([7ee6ea1](https://github.com/aligndottech/align-cli/commit/7ee6ea1a323fc5f0f73c489e99fa96e896305998))


### Performance Improvements

* **action:** prune the optional ML dependency from the CI install (431MB -&gt; 45MB) ([df3fdb8](https://github.com/aligndottech/align-cli/commit/df3fdb8295518ef3a724e326d8885adf09e91750))
* **action:** prune the optional ML dependency from the CI install, 431MB to 45MB (ALI-686) ([08970a4](https://github.com/aligndottech/align-cli/commit/08970a4e3d351871f43554b179e15491eddb5838))

## [0.17.1](https://github.com/aligndottech/align-cli/compare/cli-v0.17.0...cli-v0.17.1) (2026-08-25)


### Bug Fixes

* **mcp-registry:** registry rejects descriptions over 100 chars - shorten and pin it ([6c47546](https://github.com/aligndottech/align-cli/commit/6c47546ae5f6e70b9a5eb2f04f65556392dfd2a5))
* **mcp-registry:** registry rejects descriptions over 100 chars (ALI-535) ([b4f3bc2](https://github.com/aligndottech/align-cli/commit/b4f3bc28ab07e64800485d78677ab4e8ab3050aa))

## [0.17.0](https://github.com/aligndottech/align-cli/compare/cli-v0.16.0...cli-v0.17.0) (2026-08-25)


### Features

* **mcp-registry:** publish to registry.modelcontextprotocol.io on every release (ALI-535) ([#128](https://github.com/aligndottech/align-cli/issues/128)) ([949c876](https://github.com/aligndottech/align-cli/commit/949c876b489b14b17952b37d58d90100d17cc3f5))


### Bug Fixes

* **setup:** --local tells a logged-in user their bare commands still target the cloud graph ([#129](https://github.com/aligndottech/align-cli/issues/129)) ([cefa6d2](https://github.com/aligndottech/align-cli/commit/cefa6d20eaab9d15071449a909ca3020d84ff392))

## [0.16.0](https://github.com/aligndottech/align-cli/compare/cli-v0.15.0...cli-v0.16.0) (2026-08-25)


### Features

* **cites:** Linear and Jira decisions cite by ticket key, not UUID ([#126](https://github.com/aligndottech/align-cli/issues/126)) ([1dfb5ff](https://github.com/aligndottech/align-cli/commit/1dfb5ffe27d0c2c75732c8935a060484ddc8733a))

## [0.15.0](https://github.com/aligndottech/align-cli/compare/cli-v0.14.1...cli-v0.15.0) (2026-08-25)


### Features

* **ask:** sources carry cite, platform and link - same data as the MCP surface, rendered natively ([#124](https://github.com/aligndottech/align-cli/issues/124)) ([ebec798](https://github.com/aligndottech/align-cli/commit/ebec79838d5a1e94f6a68530067d53e34bb5cb99))

## [0.14.1](https://github.com/aligndottech/align-cli/compare/cli-v0.14.0...cli-v0.14.1) (2026-08-25)


### Bug Fixes

* **import:** no-account users' imports land in the local graph instead of 401ing against cloud (ALI-675) ([#122](https://github.com/aligndottech/align-cli/issues/122)) ([ca69e53](https://github.com/aligndottech/align-cli/commit/ca69e53f568fc555a8cbf8137ee72b7c24e95bc5))

## [0.14.0](https://github.com/aligndottech/align-cli/compare/cli-v0.13.0...cli-v0.14.0) (2026-08-24)


### Features

* **context:** align context sync - write the decision graph into the files agents read (ALI-602) ([#120](https://github.com/aligndottech/align-cli/issues/120)) ([85a5ccc](https://github.com/aligndottech/align-cli/commit/85a5cccec1d219a2d028038f3cd2d6c7a7b4db77))

## [0.13.0](https://github.com/aligndottech/align-cli/compare/cli-v0.12.1...cli-v0.13.0) (2026-08-24)


### Features

* **context:** ALI-196 spike proof - a decisions file Align owns, imported not spliced ([#116](https://github.com/aligndottech/align-cli/issues/116)) ([ea226eb](https://github.com/aligndottech/align-cli/commit/ea226eb9852912571d668daab95bbd7db2837c06))


### Bug Fixes

* **client:** refuse a tenant that nothing authenticates (ALI-462) ([#113](https://github.com/aligndottech/align-cli/issues/113)) ([ea9c653](https://github.com/aligndottech/align-cli/commit/ea9c653f164eaed51ba03dd8cf320c00b1f1af18))
* correct the licence holder and year ([#117](https://github.com/aligndottech/align-cli/issues/117)) ([029b863](https://github.com/aligndottech/align-cli/commit/029b86352b2cf0aa4dc9affd590b0179a9ab2d47))
* **setup:** setup --local completes without a TTY instead of hanging or crashing at the connector prompt ([#118](https://github.com/aligndottech/align-cli/issues/118)) ([eb8e393](https://github.com/aligndottech/align-cli/commit/eb8e39365c0895450c3e1da6f5fffd6a72d0e163))

## [0.12.1](https://github.com/aligndottech/align-cli/compare/cli-v0.12.0...cli-v0.12.1) (2026-08-17)


### Bug Fixes

* **local:** cosine similarity is `relates`, not a conflict caught (ALI-503) ([#111](https://github.com/aligndottech/align-cli/issues/111)) ([98f3a07](https://github.com/aligndottech/align-cli/commit/98f3a07ef939003892764342c0c7cc835acc5750))

## [0.12.0](https://github.com/aligndottech/align-cli/compare/cli-v0.11.0...cli-v0.12.0) (2026-08-17)


### Features

* **action:** anchor conflicts to the files that produced them ([#109](https://github.com/aligndottech/align-cli/issues/109)) ([87b721d](https://github.com/aligndottech/align-cli/commit/87b721dc71f29a70dc03926d25d6f93d25de0105))


### Bug Fixes

* **ask:** refuse to synthesise with an unvetted Ollama model (ALI-420) ([#110](https://github.com/aligndottech/align-cli/issues/110)) ([43c439f](https://github.com/aligndottech/align-cli/commit/43c439f8d1188c187876ea79117f499f3ee503ce))
* **gateway-client:** follow decision-links cursor in getConflicts (ALI-587) ([#106](https://github.com/aligndottech/align-cli/issues/106)) ([f9c9f92](https://github.com/aligndottech/align-cli/commit/f9c9f92437fe701c0ff8f6268b713b1d7eb4bba4))
* honest link listings and active-only conflict counts (ALI-587) ([#108](https://github.com/aligndottech/align-cli/issues/108)) ([0b1f916](https://github.com/aligndottech/align-cli/commit/0b1f91618c47654ba38169f28e8f4eca5c4bd6ce))

## [0.11.0](https://github.com/aligndottech/align-cli/compare/cli-v0.10.0...cli-v0.11.0) (2026-08-15)


### Features

* **check:** --title sends the proposed decision in words, and stop interpolating github.event into shell ([#104](https://github.com/aligndottech/align-cli/issues/104)) ([bfeeb45](https://github.com/aligndottech/align-cli/commit/bfeeb45e06103e847dd206cc460c7559563dd7b9))

## [0.10.0](https://github.com/aligndottech/align-cli/compare/cli-v0.9.0...cli-v0.10.0) (2026-08-14)


### Features

* align import &lt;src&gt; --personal - browser OAuth for imports, no PAT needed (ALI-388) ([#103](https://github.com/aligndottech/align-cli/issues/103)) ([c70b182](https://github.com/aligndottech/align-cli/commit/c70b182bef43d6d7cd14addaebe5712bede4e30b))


### Bug Fixes

* **action:** a no-context result is a complete check, not a failed one ([#99](https://github.com/aligndottech/align-cli/issues/99)) ([62bdd4b](https://github.com/aligndottech/align-cli/commit/62bdd4b872516ad8a347a057e93faaacdfbc109b))
* **action:** remove a stray esac, and gate the action's shell syntax ([#97](https://github.com/aligndottech/align-cli/issues/97)) ([8cb3cd7](https://github.com/aligndottech/align-cli/commit/8cb3cd7c07f37cd84de989b76a21fea1520f44ff))
* **action:** surface the gateway's reason when a check does not complete ([#100](https://github.com/aligndottech/align-cli/issues/100)) ([878c2e0](https://github.com/aligndottech/align-cli/commit/878c2e0e5db495b257a3477321bd06857fed4871))
* surface honesty sweep - five places the CLI claimed more than the code does (ALI-505) ([#102](https://github.com/aligndottech/align-cli/issues/102)) ([d4a9f6e](https://github.com/aligndottech/align-cli/commit/d4a9f6ee51813996fd48f814288885b39ef83273))

## [0.9.0](https://github.com/aligndottech/align-cli/compare/cli-v0.8.1...cli-v0.9.0) (2026-08-04)


### Features

* **check:** add --base for CI, and a reusable GitHub Action ([#93](https://github.com/aligndottech/align-cli/issues/93)) ([03938ed](https://github.com/aligndottech/align-cli/commit/03938ed949e7fdce8618b448dfa96847efa156d0))


### Bug Fixes

* **action:** never report a CLI crash as a conflict ([#94](https://github.com/aligndottech/align-cli/issues/94)) ([7ccdd2c](https://github.com/aligndottech/align-cli/commit/7ccdd2c9b7662bb1790bcc1e8ec4d09263668466))
* **mcp:** say which decision graph this server reads ([#91](https://github.com/aligndottech/align-cli/issues/91)) ([569357b](https://github.com/aligndottech/align-cli/commit/569357bc8ce4107b4b2718e92e9dc8eed95f8a07))

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
