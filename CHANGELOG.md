# Changelog

## [0.65.2](https://github.com/aligndottech/align-cli/compare/cli-v0.65.1...cli-v0.65.2) (2026-10-28)


### Bug Fixes

* **check:** skip blame for prose and lockfiles, and use blame in the MCP pre-edit check ([#495](https://github.com/aligndottech/align-cli/issues/495)) ([ccbff9b](https://github.com/aligndottech/align-cli/commit/ccbff9bff5603132f5e7899c9ccd5ed2ac68d974))
* **detector:** clip an over-long evidence quote instead of discarding the verdict ([#497](https://github.com/aligndottech/align-cli/issues/497)) ([063a5dc](https://github.com/aligndottech/align-cli/commit/063a5dcd68f1e72c6ea795012f8a9ee2512c851d))

## [0.65.1](https://github.com/aligndottech/align-cli/compare/cli-v0.65.0...cli-v0.65.1) (2026-10-28)


### Bug Fixes

* **ask:** drop git trailers from excerpts and print the unreadable-ref hint once ([#489](https://github.com/aligndottech/align-cli/issues/489)) ([5ff0bbc](https://github.com/aligndottech/align-cli/commit/5ff0bbcb6f95a82073dec4b6c96ac7fca99b322b))
* **check:** name the decision that wrote the lines an edit changes ([#490](https://github.com/aligndottech/align-cli/issues/490)) ([89f4973](https://github.com/aligndottech/align-cli/commit/89f49731144e6f96c55ca1fc5916bc434b8b5e70))
* **setup:** keep release bumps out of the first-run box and starter prompts ([#491](https://github.com/aligndottech/align-cli/issues/491)) ([7a96f4a](https://github.com/aligndottech/align-cli/commit/7a96f4a37763f82beadbc5305fe96a633e80de7c))

## [0.65.0](https://github.com/aligndottech/align-cli/compare/cli-v0.64.1...cli-v0.65.0) (2026-10-25)


### Features

* **setup:** the first session teaches itself - three starter prompts, a visible guardrail, truthful copy ([#485](https://github.com/aligndottech/align-cli/issues/485)) ([e0a7f4a](https://github.com/aligndottech/align-cli/commit/e0a7f4ad8ee85e255f2e35a80e18da342bf93116))

## [0.64.1](https://github.com/aligndottech/align-cli/compare/cli-v0.64.0...cli-v0.64.1) (2026-10-24)


### Bug Fixes

* **ci:** stop the npm E2E leg racing its own publish ([#481](https://github.com/aligndottech/align-cli/issues/481)) ([1898fb3](https://github.com/aligndottech/align-cli/commit/1898fb368c7821c2e3f93ec738b3841737a4980e))
* **deps:** bump stale security overrides to patched versions ([#480](https://github.com/aligndottech/align-cli/issues/480)) ([9fec1fb](https://github.com/aligndottech/align-cli/commit/9fec1fba1e322dfeb36981ee1e235965bdc354c4))

## [0.64.0](https://github.com/aligndottech/align-cli/compare/cli-v0.63.0...cli-v0.64.0) (2026-10-24)


### Features

* **setup:** list the files setup will write and ask before writing ([#473](https://github.com/aligndottech/align-cli/issues/473)) ([748d96e](https://github.com/aligndottech/align-cli/commit/748d96e0fdc9bf42ecd92c6fde13bc1657bb467a))
* **setup:** say what to do next when the graph comes out empty or thin ([#472](https://github.com/aligndottech/align-cli/issues/472)) ([21e4ca0](https://github.com/aligndottech/align-cli/commit/21e4ca0c20f6fb58021f1490dc6dbc65320336c8))


### Bug Fixes

* **setup:** decline leaves no connected agent; honest undo text; --env local in the empty-graph hint ([#476](https://github.com/aligndottech/align-cli/issues/476)) ([0b588a7](https://github.com/aligndottech/align-cli/commit/0b588a7164a32d1f19fa2094af3a9ee912fd5eff))
* **setup:** show home paths as ~/... on Windows too ([#478](https://github.com/aligndottech/align-cli/issues/478)) ([a45bc6b](https://github.com/aligndottech/align-cli/commit/a45bc6ba1c0b39e7366f013a76930d24f0245220))
* three follow-ups from the review of the ticket-ref strip ([#475](https://github.com/aligndottech/align-cli/issues/475)) ([#477](https://github.com/aligndottech/align-cli/issues/477)) ([6c4b08a](https://github.com/aligndottech/align-cli/commit/6c4b08a1cdee6e6353dec95be811400c706661e2))

## [0.63.0](https://github.com/aligndottech/align-cli/compare/cli-v0.62.1...cli-v0.63.0) (2026-10-21)


### Features

* **whoami:** show when the login token expires ([#470](https://github.com/aligndottech/align-cli/issues/470)) ([0b22f5f](https://github.com/aligndottech/align-cli/commit/0b22f5f51787df0b3bd33ae6b900853e96104b51))

## [0.62.1](https://github.com/aligndottech/align-cli/compare/cli-v0.62.0...cli-v0.62.1) (2026-10-21)


### Bug Fixes

* **cli:** an expired login says so and tells the user to run align login ([#468](https://github.com/aligndottech/align-cli/issues/468)) ([23462a6](https://github.com/aligndottech/align-cli/commit/23462a633ba0d0e0ac99213a76c30dd08b19f68f))

## [0.62.0](https://github.com/aligndottech/align-cli/compare/cli-v0.61.0...cli-v0.62.0) (2026-10-21)


### Features

* **glossary:** align glossary review lists proposed aliases, read-only ([#466](https://github.com/aligndottech/align-cli/issues/466)) ([e61bb51](https://github.com/aligndottech/align-cli/commit/e61bb511aa0c870e37bc06de4b39d467183a4a8c))
* **mcp:** MCP call log in the opt-in local trace file ([#463](https://github.com/aligndottech/align-cli/issues/463)) ([399e313](https://github.com/aligndottech/align-cli/commit/399e31379e9fc8b9f3950da3ee6c78feebeca38b))

## [0.61.0](https://github.com/aligndottech/align-cli/compare/cli-v0.60.0...cli-v0.61.0) (2026-10-20)


### Features

* **search:** fuse a lexical ranking of git commits with the dense one ([#451](https://github.com/aligndottech/align-cli/issues/451)) ([a61a5a3](https://github.com/aligndottech/align-cli/commit/a61a5a312f169804b9ae288c73f54cb041769518))
* **trace:** local LLM trace file, never sent ([#461](https://github.com/aligndottech/align-cli/issues/461)) ([5868134](https://github.com/aligndottech/align-cli/commit/5868134620432a31369f7352c602198e10440106))


### Bug Fixes

* **capture:** say plainly and exit 1 when the gateway cannot read the link ([#460](https://github.com/aligndottech/align-cli/issues/460)) ([9e535c3](https://github.com/aligndottech/align-cli/commit/9e535c3e2094b4ec5e2b7dee1f2695b5bfd918dd))
* page through all suggestions when approving a scan ([#457](https://github.com/aligndottech/align-cli/issues/457)) ([05ff65e](https://github.com/aligndottech/align-cli/commit/05ff65edb5f829337be6785e3e9ace7a6dc4a76d))
* **release:** the MCP registry publish passes when the registry already holds this exact version ([#459](https://github.com/aligndottech/align-cli/issues/459)) ([3144dcc](https://github.com/aligndottech/align-cli/commit/3144dccdbe9d559e965047f3ff2aa2f00c2eee78))
* **test:** close read-only sqlite handles in lexical-store tests so Windows can delete the temp db ([#458](https://github.com/aligndottech/align-cli/issues/458)) ([bc627a2](https://github.com/aligndottech/align-cli/commit/bc627a28715ff36f1d974b3c8283cabd63955c53))

## [0.60.0](https://github.com/aligndottech/align-cli/compare/cli-v0.59.0...cli-v0.60.0) (2026-10-19)


### Features

* **import:** first run reads merged PR descriptions of a GitHub origin ([#454](https://github.com/aligndottech/align-cli/issues/454)) ([de299bc](https://github.com/aligndottech/align-cli/commit/de299bcd760edb7beaec7db47827ee537e1e9e96))


### Bug Fixes

* **ask:** ground model-written answers in stated reasons and abstain when none is stated ([#453](https://github.com/aligndottech/align-cli/issues/453)) ([96a310c](https://github.com/aligndottech/align-cli/commit/96a310c152e4ff9988c17b9cbc4339fe5a45bb3d))

## [0.59.0](https://github.com/aligndottech/align-cli/compare/cli-v0.58.0...cli-v0.59.0) (2026-10-19)


### Features

* **ask:** show the stated reason from the commit message ([#448](https://github.com/aligndottech/align-cli/issues/448)) ([0ec9551](https://github.com/aligndottech/align-cli/commit/0ec955128e2922b3e399a64b145d40be65f31a5d))

## [0.58.0](https://github.com/aligndottech/align-cli/compare/cli-v0.57.1...cli-v0.58.0) (2026-10-19)


### Features

* **search:** reach the whole git history on first import, and import faster ([#447](https://github.com/aligndottech/align-cli/issues/447)) ([5170eb9](https://github.com/aligndottech/align-cli/commit/5170eb9bb68182eb5b15a5f967f7e925e1308ef8))


### Bug Fixes

* **ask:** scannable, honest list when no answer is written ([#442](https://github.com/aligndottech/align-cli/issues/442)) ([bcf891d](https://github.com/aligndottech/align-cli/commit/bcf891de0232b1e45cc65611e1e4ac704d44356a))
* **hooks:** Copilot hook exits 0 when align is not on PATH ([#439](https://github.com/aligndottech/align-cli/issues/439)) ([2bd1722](https://github.com/aligndottech/align-cli/commit/2bd17222a744c746ee452b8754e550749f7a712c))
* **setup:** first-run output stops saying untrue or broken things ([#443](https://github.com/aligndottech/align-cli/issues/443)) ([37198f5](https://github.com/aligndottech/align-cli/commit/37198f515446504092ca9f114c58e5addd28bd6b))
* **undo:** keep first-run backups of project files outside the repo ([#444](https://github.com/aligndottech/align-cli/issues/444)) ([0d72d61](https://github.com/aligndottech/align-cli/commit/0d72d61198d52629cf3f2fa7caf91bf93cf63a0b))
* **undo:** record first-run project writes so align use --undo removes them ([#441](https://github.com/aligndottech/align-cli/issues/441)) ([0bacb7c](https://github.com/aligndottech/align-cli/commit/0bacb7ccebdb723c2eba9643d0f0a58dfeb4e69c))
* **windows:** platform-correct claude-presence, undo-first-run and backup tests ([#445](https://github.com/aligndottech/align-cli/issues/445)) ([30e6f83](https://github.com/aligndottech/align-cli/commit/30e6f83ce8bb0eecea086dccddd8e4d8b3a0cd59))


### Performance Improvements

* **install:** download the on-device runtime on first use, 779 MB to 45 MB ([#446](https://github.com/aligndottech/align-cli/issues/446)) ([68ef9b3](https://github.com/aligndottech/align-cli/commit/68ef9b35fe0d5bae63e01800179da5519d5f7037))

## [0.57.1](https://github.com/aligndottech/align-cli/compare/cli-v0.57.0...cli-v0.57.1) (2026-10-18)


### Bug Fixes

* **cli:** say align is not set up instead of a bare 401 ([#435](https://github.com/aligndottech/align-cli/issues/435)) ([2fef93d](https://github.com/aligndottech/align-cli/commit/2fef93d8e1c0c60570de5ed538df5d7d9f6510cb))
* **cli:** say why align will not start on a Node older than 22.16 ([#434](https://github.com/aligndottech/align-cli/issues/434)) ([ff03030](https://github.com/aligndottech/align-cli/commit/ff03030b13b161258317f482e4560604386c0e77))
* **search:** rerank dense candidates by title so a why-removed question shows its commit ([#436](https://github.com/aligndottech/align-cli/issues/436)) ([b3fecf6](https://github.com/aligndottech/align-cli/commit/b3fecf672fa1717f1e88aa011937c29a92ecbad0))
* **setup:** rank housekeeping commits last in the first-run found box ([#432](https://github.com/aligndottech/align-cli/issues/432)) ([bee3b97](https://github.com/aligndottech/align-cli/commit/bee3b97acdc167ace2694199f9ffe9d4b5772dfc))

## [0.57.0](https://github.com/aligndottech/align-cli/compare/cli-v0.56.0...cli-v0.57.0) (2026-10-18)


### Features

* **doctor:** align doctor, an install preflight that makes a real tools/call ([#431](https://github.com/aligndottech/align-cli/issues/431)) ([29ba1f3](https://github.com/aligndottech/align-cli/commit/29ba1f3f6a983e773424e0a2417a17501e36bad1))


### Bug Fixes

* **hooks:** keep a user's edit inside align's own hook element ([#429](https://github.com/aligndottech/align-cli/issues/429)) ([14b4a6b](https://github.com/aligndottech/align-cli/commit/14b4a6b5fd5ddcfcef256d394c7f67a3b650631a))

## [0.56.0](https://github.com/aligndottech/align-cli/compare/cli-v0.55.1...cli-v0.56.0) (2026-10-15)


### Features

* **setup:** offer saved tokens before the picker; remove align setup ([#425](https://github.com/aligndottech/align-cli/issues/425)) ([b2238f7](https://github.com/aligndottech/align-cli/commit/b2238f737841dbf0644dcdccd18946974c1b80ee))

## [0.55.1](https://github.com/aligndottech/align-cli/compare/cli-v0.55.0...cli-v0.55.1) (2026-10-15)


### Bug Fixes

* Windows CI red on main - real bug + timeout headroom ([#422](https://github.com/aligndottech/align-cli/issues/422)) ([89b6cbf](https://github.com/aligndottech/align-cli/commit/89b6cbf27223afe4bc28609bcd52c74cb4ae1e78))

## [0.55.0](https://github.com/aligndottech/align-cli/compare/cli-v0.54.0...cli-v0.55.0) (2026-10-15)


### Features

* replace the CLI mark with an Align robot icon ([#419](https://github.com/aligndottech/align-cli/issues/419)) ([4b705a6](https://github.com/aligndottech/align-cli/commit/4b705a6dce6cd53415395a306b77f1a3f700dd13))


### Bug Fixes

* **context:** a local graph's decisions file stays out of git ([#418](https://github.com/aligndottech/align-cli/issues/418)) ([498c3dc](https://github.com/aligndottech/align-cli/commit/498c3dc8ca331ebf23b23e6422c790c826592a44))
* **deps:** bump the MCP SDK and proxy-addr inside their ranges to clear the runtime critical ([#417](https://github.com/aligndottech/align-cli/issues/417)) ([439db67](https://github.com/aligndottech/align-cli/commit/439db676dabe8d318d07b1719a1f96ad5711113d))

## [0.54.0](https://github.com/aligndottech/align-cli/compare/cli-v0.53.1...cli-v0.54.0) (2026-10-12)


### Features

* align share is a visible command, the upgrade path from the local graph to a team graph ([#412](https://github.com/aligndottech/align-cli/issues/412)) ([b961b20](https://github.com/aligndottech/align-cli/commit/b961b20557199e2e9738e97302db3a1391b2142d))
* **setup:** a model step that asks once, only when conflict checks cannot run ([#415](https://github.com/aligndottech/align-cli/issues/415)) ([bcb6ece](https://github.com/aligndottech/align-cli/commit/bcb6ece2a86aa7cd447012fb8268e003681f369f))
* **setup:** say at the end of the wizard when no AI model is set up, so conflict checks will not run ([#414](https://github.com/aligndottech/align-cli/issues/414)) ([30ead3f](https://github.com/aligndottech/align-cli/commit/30ead3f9e2e41dca903d523cb19c9c969f8563ed))

## [0.53.1](https://github.com/aligndottech/align-cli/compare/cli-v0.53.0...cli-v0.53.1) (2026-10-12)


### Bug Fixes

* hand agents a trusted absolute align path, not a bare PATH lookup ([#409](https://github.com/aligndottech/align-cli/issues/409)) ([358a6e2](https://github.com/aligndottech/align-cli/commit/358a6e2929c6a372d33dd475e11e978d0d1ff323))
* strict MCP judges accept the trusted absolute align path, and only that one ([#411](https://github.com/aligndottech/align-cli/issues/411)) ([b6aef0e](https://github.com/aligndottech/align-cli/commit/b6aef0ee3898839e6596f72e4fcd82314bef6cc6))

## [0.53.0](https://github.com/aligndottech/align-cli/compare/cli-v0.52.0...cli-v0.53.0) (2026-10-12)


### Features

* **detector:** a local model that did not pass runs v0 by default ([#406](https://github.com/aligndottech/align-cli/issues/406)) ([c86ff51](https://github.com/aligndottech/align-cli/commit/c86ff515b8aa0a73f8d29041d96342a992619cf4))


### Bug Fixes

* **config:** an upgraded user's saved graph path follows the move to ~/.align ([#408](https://github.com/aligndottech/align-cli/issues/408)) ([bcfb556](https://github.com/aligndottech/align-cli/commit/bcfb556cb41a385bc8998c3d9f6bc3cdcd7a10b9))

## [0.52.0](https://github.com/aligndottech/align-cli/compare/cli-v0.51.0...cli-v0.52.0) (2026-10-12)


### Features

* **config:** one home folder, ~/.align, for config and the local graph ([#402](https://github.com/aligndottech/align-cli/issues/402)) ([c9e9865](https://github.com/aligndottech/align-cli/commit/c9e98652d73536f7a911f964f93d2367f91d07a2))

## [0.51.0](https://github.com/aligndottech/align-cli/compare/cli-v0.50.0...cli-v0.51.0) (2026-10-11)


### ⚠ BREAKING CHANGES

* **detector:** the default local relationship detector is now v1. Set ALIGN_DETECTOR=v0 to keep the previous pairwise classifier.

### Features

* **config:** align config detector saves the relationship detector; status shows it ([#398](https://github.com/aligndottech/align-cli/issues/398)) ([d9e5b36](https://github.com/aligndottech/align-cli/commit/d9e5b36be349510403574846e0f587151876323d))
* **config:** team destinations, hardened login loopback (join C2) ([#382](https://github.com/aligndottech/align-cli/issues/382)) ([b51621e](https://github.com/aligndottech/align-cli/commit/b51621e79f475dd801caba55b0b79608681c4415))
* **detector:** default follows the route: v1 on a hosted model, v0 on a local one ([#399](https://github.com/aligndottech/align-cli/issues/399)) ([d3f5df6](https://github.com/aligndottech/align-cli/commit/d3f5df6a4113014bc282ebd56aadb9502992554e))
* **detector:** make v1 the default local relationship detector ([#396](https://github.com/aligndottech/align-cli/issues/396)) ([eaed43e](https://github.com/aligndottech/align-cli/commit/eaed43e24b718b669673ff59676140027419186b))
* **detector:** relationship contract v1 data, parser and golden parse vectors (no behaviour change) ([#380](https://github.com/aligndottech/align-cli/issues/380)) ([322f742](https://github.com/aligndottech/align-cli/commit/322f742bd07262ef00ea664a19c6a1927b45031e))
* **detector:** v1 is the default; the local model is qwen2.5:7b ([#401](https://github.com/aligndottech/align-cli/issues/401)) ([ca93f99](https://github.com/aligndottech/align-cli/commit/ca93f9903d117e216eb42955ca073f423a7f93f7))
* **detector:** v1 local relationship detector behind ALIGN_DETECTOR=v1 ([#388](https://github.com/aligndottech/align-cli/issues/388)) ([7149375](https://github.com/aligndottech/align-cli/commit/71493755910edb69479a9eb6780e50b77ef84d25))
* **env:** unknown environment names fail closed (join C1) ([#381](https://github.com/aligndottech/align-cli/issues/381)) ([10cbc3b](https://github.com/aligndottech/align-cli/commit/10cbc3bf313b25471ace3e756de5c6b38f525aaf))
* **invite:** align invite opens Settings &gt; Team invites instead of calling the API ([#392](https://github.com/aligndottech/align-cli/issues/392)) ([6fda519](https://github.com/aligndottech/align-cli/commit/6fda5198cc65a7feac71ef8f9509d634b4b8bb37))
* **join:** align join &lt;invite link&gt; (join C3) ([#384](https://github.com/aligndottech/align-cli/issues/384)) ([6467f1f](https://github.com/aligndottech/align-cli/commit/6467f1f0c69f7237592195d8c0c7f861d63dc141))
* **join:** callers, renewal and docs for team destinations (join C6) ([#385](https://github.com/aligndottech/align-cli/issues/385)) ([e3946f5](https://github.com/aligndottech/align-cli/commit/e3946f54540b0f489562858a68c7ea1fa189ec3c))
* **local:** harden the local graph at rest (owner-only files, secret redaction, backup exclusion) ([#395](https://github.com/aligndottech/align-cli/issues/395)) ([f1be7e1](https://github.com/aligndottech/align-cli/commit/f1be7e147960ab19d0db8aafc7170f8a41aecdc0))
* **share:** browser approval flow and request-approval MCP tools ([#377](https://github.com/aligndottech/align-cli/issues/377)) ([e849094](https://github.com/aligndottech/align-cli/commit/e849094848bf5e36585b8501f26ba8e913a6b005))
* **share:** no lead prompt once a team destination exists (join C5) ([#387](https://github.com/aligndottech/align-cli/issues/387)) ([aae7fe1](https://github.com/aligndottech/align-cli/commit/aae7fe18eb1d3224f7978f5773e51335ab7700d9))
* **share:** open the approval link automatically or show a QR code ([#379](https://github.com/aligndottech/align-cli/issues/379)) ([4ed10b6](https://github.com/aligndottech/align-cli/commit/4ed10b6aa16a8e5ef5a59f291143d10a8aff34b0))
* **share:** opt-in work email at the share moment (hosted only) ([#386](https://github.com/aligndottech/align-cli/issues/386)) ([569b3c2](https://github.com/aligndottech/align-cli/commit/569b3c2d82b4ad77868406cab2a9b33af8ecbbc9))
* **share:** shares go only to the chosen destination (join C4) ([#383](https://github.com/aligndottech/align-cli/issues/383)) ([4c1eeb2](https://github.com/aligndottech/align-cli/commit/4c1eeb203ac3e0678d972308792865a4f3fd118c))


### Bug Fixes

* **detector:** make v0 the default again; v1 is opt-in ([#397](https://github.com/aligndottech/align-cli/issues/397)) ([66f28a9](https://github.com/aligndottech/align-cli/commit/66f28a94755cef22f696ae1196a4865b87102617))
* **e2e:** run the golden path as a user, not as CI, so the funnel pings are sent ([#372](https://github.com/aligndottech/align-cli/issues/372)) ([db3dd66](https://github.com/aligndottech/align-cli/commit/db3dd66ddd5b23feea3bdf367482494022ce07d6))
* **share:** refuse --open for a foreign gateway from an agent, and fail closed with no tenant id ([#391](https://github.com/aligndottech/align-cli/issues/391)) ([50d56e3](https://github.com/aligndottech/align-cli/commit/50d56e3a4323bb2a5e94c8da68d0075d979c1d0a))

## [0.50.0](https://github.com/aligndottech/align-cli/compare/cli-v0.49.0...cli-v0.50.0) (2026-10-10)


### Features

* **import:** 180-day capture window, ceilings, --since everywhere, align_backfill ([#362](https://github.com/aligndottech/align-cli/issues/362)) ([6455d3e](https://github.com/aligndottech/align-cli/commit/6455d3ea8da3a2e63128eb4606c7dd8704e80ef5))
* **launch:** Goose, Auggie, Continue, Cline and Aider, with hostile-repo hardening ([#360](https://github.com/aligndottech/align-cli/issues/360)) ([61f7e84](https://github.com/aligndottech/align-cli/commit/61f7e843e7dbb5f053cee938d166872c5e4e4639))
* **local-db:** re-key zoom rows on connector-core 0.10.1 (schema v11) ([#369](https://github.com/aligndottech/align-cli/issues/369)) ([530ff84](https://github.com/aligndottech/align-cli/commit/530ff84471a46fb6941d039337220e84301b6452))
* **local:** connector imports never call the classifier; unchanged re-syncs cost nothing ([#355](https://github.com/aligndottech/align-cli/issues/355)) ([81c7246](https://github.com/aligndottech/align-cli/commit/81c7246a539040bd820919e10a20d3691484475d))
* **local:** graph schema v7 - one row per source item, safe twin merge ([#358](https://github.com/aligndottech/align-cli/issues/358)) ([c126b6a](https://github.com/aligndottech/align-cli/commit/c126b6ac9a9f319dca1224c3ca497f9826359d94))
* **mark:** align mark and align_mark - local curation the guardrail honours ([#364](https://github.com/aligndottech/align-cli/issues/364)) ([5980502](https://github.com/aligndottech/align-cli/commit/5980502ccb129c811dfff13cf34ba4856c9e290a))
* **scope:** scope pickers and align_scope with a consent gate ([#365](https://github.com/aligndottech/align-cli/issues/365)) ([5777534](https://github.com/aligndottech/align-cli/commit/5777534754d14d6e5c4d32e823e4936f115d46a8))
* **share:** align share promotes local decisions to the team graph ([#367](https://github.com/aligndottech/align-cli/issues/367)) ([6a87e0f](https://github.com/aligndottech/align-cli/commit/6a87e0f5f3bb5a6c3fa1d15c0e2f98f23b752838))
* **sync:** align sync, comment fill-in, reconnect marking, lock, forget --purge ([#363](https://github.com/aligndottech/align-cli/issues/363)) ([5123de1](https://github.com/aligndottech/align-cli/commit/5123de1fa64ef688c68b8a35c586544766d30209))
* **sync:** refresh connected sources in the background at launch ([#368](https://github.com/aligndottech/align-cli/issues/368)) ([c5283ab](https://github.com/aligndottech/align-cli/commit/c5283ab7a41b1b485d90dc5225c4fc0a90798a2a))
* **telemetry:** content-free sync and mark telemetry with a sticky env opt-out ([#366](https://github.com/aligndottech/align-cli/issues/366)) ([74ca297](https://github.com/aligndottech/align-cli/commit/74ca2976a9c93aa3b4cd12139dcfb86a1c117f2b))
* **telemetry:** usage counts on by default with a one-time notice, off with one command ([#357](https://github.com/aligndottech/align-cli/issues/357)) ([16cedc7](https://github.com/aligndottech/align-cli/commit/16cedc7f07f39d475b044c18378c8b662786099e))


### Bug Fixes

* **launch:** Gemini loads Align's graph again - written-once user entry, real layer rules ([#359](https://github.com/aligndottech/align-cli/issues/359)) ([4765cbf](https://github.com/aligndottech/align-cli/commit/4765cbf344fda4fb104c377977588b396376aa2b))
* **share:** re-vendor the secret patterns from align-stack; pin them with tests ([#371](https://github.com/aligndottech/align-cli/issues/371)) ([ad7d813](https://github.com/aligndottech/align-cli/commit/ad7d8133bfd9d9b3bb353e6ecf36622256c77664))
* **share:** the booking nudge says 30 minutes, matching the booking page ([#370](https://github.com/aligndottech/align-cli/issues/370)) ([8ff1b88](https://github.com/aligndottech/align-cli/commit/8ff1b8847320d2ac0c5626a9d1ba985ecf058d1f))


### Performance Improvements

* **local:** one in-memory similarity matrix per import run, bit-identical scores ([#361](https://github.com/aligndottech/align-cli/issues/361)) ([34cb6d5](https://github.com/aligndottech/align-cli/commit/34cb6d5ef77baa7630c8e2ae706fe02dbb15d351))

## [0.49.0](https://github.com/aligndottech/align-cli/compare/cli-v0.48.0...cli-v0.49.0) (2026-10-09)


### Features

* **ask:** no AI-key step in first run; choose the provider; 14 more providers; saved keys never reach the agent ([#351](https://github.com/aligndottech/align-cli/issues/351)) ([3e859e0](https://github.com/aligndottech/align-cli/commit/3e859e0ff88f43af336bb2ae972152c248b65733))
* **launch:** bare align opens Qwen Code, Factory Droid, Amp, Kiro CLI and Grok Build ([#353](https://github.com/aligndottech/align-cli/issues/353)) ([739796c](https://github.com/aligndottech/align-cli/commit/739796c61f8fa963eaff913560ea6127efe372f7))

## [0.48.0](https://github.com/aligndottech/align-cli/compare/cli-v0.47.1...cli-v0.48.0) (2026-10-09)


### Features

* **launch:** bare align opens Codex, Gemini CLI and Copilot CLI with the local graph ([#348](https://github.com/aligndottech/align-cli/issues/348)) ([b56c4a4](https://github.com/aligndottech/align-cli/commit/b56c4a4c085478483af99ad25578969883b81d56))
* **launch:** the picker lists every supported agent, plus align agents ([#350](https://github.com/aligndottech/align-cli/issues/350)) ([e33f282](https://github.com/aligndottech/align-cli/commit/e33f282fe552101c214e7d8785e27f4299eba6a6))

## [0.47.1](https://github.com/aligndottech/align-cli/compare/cli-v0.47.0...cli-v0.47.1) (2026-10-09)


### Bug Fixes

* **setup:** one calm line for kept agent connections instead of five warnings ([#344](https://github.com/aligndottech/align-cli/issues/344)) ([e93cb07](https://github.com/aligndottech/align-cli/commit/e93cb071056b39d345e05be923029adb739bab31))

## [0.47.0](https://github.com/aligndottech/align-cli/compare/cli-v0.46.1...cli-v0.47.0) (2026-10-09)


### Features

* **launch:** bare `align` opens your coding agent with the local graph injected, Claude Code first ([#340](https://github.com/aligndottech/align-cli/issues/340)) ([b92dad6](https://github.com/aligndottech/align-cli/commit/b92dad6fa320b70f6a552c87d02136de5b6856ac))
* **launch:** OpenCode as a launch target with the local graph injected per session ([#341](https://github.com/aligndottech/align-cli/issues/341)) ([4a62f03](https://github.com/aligndottech/align-cli/commit/4a62f034036567bd3ba7870ace0dd46dff9d8e47))
* **launch:** pi and Cursor CLI launch targets; safe config writer with exact undo ([#343](https://github.com/aligndottech/align-cli/issues/343)) ([cc0fcb4](https://github.com/aligndottech/align-cli/commit/cc0fcb4337c08a374be549f569677bb576c4403a))
* **mcp:** send created_before to drift-check under --created-before ([#331](https://github.com/aligndottech/align-cli/issues/331)) ([dc4b7a2](https://github.com/aligndottech/align-cli/commit/dc4b7a2991b6c251b52c21a29281d5753a049759))
* **setup:** bare align runs a local-first wizard; team logins keep the team graph ([#342](https://github.com/aligndottech/align-cli/issues/342)) ([fe38425](https://github.com/aligndottech/align-cli/commit/fe384258b5c345f56f1dc447458e92ad1aecbea1))

## [0.46.1](https://github.com/aligndottech/align-cli/compare/cli-v0.46.0...cli-v0.46.1) (2026-10-08)


### Bug Fixes

* **mcp:** risks and alternatives in decision rationale fall back to ai like goals ([#336](https://github.com/aligndottech/align-cli/issues/336)) ([8add00d](https://github.com/aligndottech/align-cli/commit/8add00de8b870fb009387e1d09bbc1dfd2cda047))

## [0.46.0](https://github.com/aligndottech/align-cli/compare/cli-v0.45.0...cli-v0.46.0) (2026-10-07)


### Features

* **mcp:** tell agents to give the user a conflict's review_url ([#332](https://github.com/aligndottech/align-cli/issues/332)) ([8f0f1ab](https://github.com/aligndottech/align-cli/commit/8f0f1ab3c5c0fcdc7d9ebca42c01df324d2ec9c2))


### Bug Fixes

* **adjudicate:** refuse a run that is not from a terminal ([#334](https://github.com/aligndottech/align-cli/issues/334)) ([76aa6c3](https://github.com/aligndottech/align-cli/commit/76aa6c3af709025f568cdffbd89775849532f0b2))
* **mcp:** return goals, acceptance criteria and actions in decision rationale ([#335](https://github.com/aligndottech/align-cli/issues/335)) ([73560e4](https://github.com/aligndottech/align-cli/commit/73560e42770fa170cdb2d7c8743b3a6eaf50e080))

## [0.45.0](https://github.com/aligndottech/align-cli/compare/cli-v0.44.0...cli-v0.45.0) (2026-10-04)


### Features

* **mcp:** send created_before to the gateway; align_capture refuses when frozen ([#329](https://github.com/aligndottech/align-cli/issues/329)) ([e9f1c25](https://github.com/aligndottech/align-cli/commit/e9f1c25385356f0896e09e4ef8db821a83e091e4))

## [0.44.0](https://github.com/aligndottech/align-cli/compare/cli-v0.43.0...cli-v0.44.0) (2026-10-03)


### Features

* **mcp:** instruct agents to read later_on_topic before answering ([#328](https://github.com/aligndottech/align-cli/issues/328)) ([1db140f](https://github.com/aligndottech/align-cli/commit/1db140f244aba008d9a177e0bf352be5a06e7cd5))
* **mcp:** pin the later_on_topic contract on align_ask ([#326](https://github.com/aligndottech/align-cli/issues/326)) ([0594cf9](https://github.com/aligndottech/align-cli/commit/0594cf942a0485fe41a9d645f5a2cf486b387474))

## [0.43.0](https://github.com/aligndottech/align-cli/compare/cli-v0.42.0...cli-v0.43.0) (2026-10-03)


### Features

* **mcp:** apply the --created-before as-of cutoff to every read tool ([#325](https://github.com/aligndottech/align-cli/issues/325)) ([4d07c8d](https://github.com/aligndottech/align-cli/commit/4d07c8dfdbe2b952c920e092f48caea2b3e69f17))


### Bug Fixes

* **local:** honour --created-before in local-embedded mode ([#320](https://github.com/aligndottech/align-cli/issues/320)) ([bf84af0](https://github.com/aligndottech/align-cli/commit/bf84af0496b34abb264c3e19084fc8667f376824))

## [0.42.0](https://github.com/aligndottech/align-cli/compare/cli-v0.41.0...cli-v0.42.0) (2026-09-23)


### Features

* **access-capability:** publish the API/CLI-JSON/MCP capability matrix ([#317](https://github.com/aligndottech/align-cli/issues/317)) ([cd652f7](https://github.com/aligndottech/align-cli/commit/cd652f7ae8a4c1a20058b00b444e3457204b0995))
* **local:** type relationships at capture, not just check-time ([#319](https://github.com/aligndottech/align-cli/issues/319)) ([090890b](https://github.com/aligndottech/align-cli/commit/090890bd6dc2968cb6a86e2494073dddc0813a58))

## [0.41.0](https://github.com/aligndottech/align-cli/compare/cli-v0.40.2...cli-v0.41.0) (2026-09-21)


### Features

* **check:** add align review, and stop passing on a clean branch (David's feedback) ([#309](https://github.com/aligndottech/align-cli/issues/309)) ([af54be0](https://github.com/aligndottech/align-cli/commit/af54be02901ddf580bcada1ed3b33816fd8bc4d5))


### Bug Fixes

* **gateway-client:** a bodyless request must not claim to send JSON ([#312](https://github.com/aligndottech/align-cli/issues/312)) ([f0a6f86](https://github.com/aligndottech/align-cli/commit/f0a6f869b8f2d9b13b97d90ff11fe641d5094a6c))
* **git:** mark remotes explicitly rather than inferring them from an origin/ prefix ([#310](https://github.com/aligndottech/align-cli/issues/310)) ([83378e4](https://github.com/aligndottech/align-cli/commit/83378e40689420ab68566659e7fb73c660040e8e))
* **mcp:** never tell an agent "no conflict exists" when the gateway said nothing ([#307](https://github.com/aligndottech/align-cli/issues/307)) ([780844d](https://github.com/aligndottech/align-cli/commit/780844dd3e37f7ef26ad287142a875e0f9bded52))
* **mcp:** write a command Windows can actually spawn ([#314](https://github.com/aligndottech/align-cli/issues/314)) ([53c4bf6](https://github.com/aligndottech/align-cli/commit/53c4bf6424199387d8cd9f1fec65d7a6e4406dd7))
* **plugins:** spawn align through cmd on Windows, decided at runtime ([#315](https://github.com/aligndottech/align-cli/issues/315)) ([208f399](https://github.com/aligndottech/align-cli/commit/208f399a2c6011b2b203db5cfedb060ab7f3da06))

## [0.40.2](https://github.com/aligndottech/align-cli/compare/cli-v0.40.1...cli-v0.40.2) (2026-09-20)


### Bug Fixes

* **mcp:** stop returning the summary as the rationale ([#305](https://github.com/aligndottech/align-cli/issues/305)) ([da7a450](https://github.com/aligndottech/align-cli/commit/da7a450ffd2983906989d3ec52d1d0825ef62c30))

## [0.40.1](https://github.com/aligndottech/align-cli/compare/cli-v0.40.0...cli-v0.40.1) (2026-09-18)


### Bug Fixes

* **e2e:** correct a wrong assumption about the import_completed wire value ([#303](https://github.com/aligndottech/align-cli/issues/303)) ([df9e744](https://github.com/aligndottech/align-cli/commit/df9e7447d232fd8b4eeed06f8d88a0b13617ab58))

## [0.40.0](https://github.com/aligndottech/align-cli/compare/cli-v0.39.0...cli-v0.40.0) (2026-09-18)


### ⚠ BREAKING CHANGES

* **connect:** `align import` no longer runs an import. It exits 2 and names `align connect`. Deprecated in 0.38.0 on 2026-09-09 with a stderr line on every invocation naming both the replacement and this removal version.

### Features

* **connect:** retire the `align import` alias, as its own sunset test demanded ([#300](https://github.com/aligndottech/align-cli/issues/300)) ([a180cd6](https://github.com/aligndottech/align-cli/commit/a180cd678196a83960fc6de0b8dd874a53a98b5e))
* **mcp:** add --created-before flag to bound decision searches ([#302](https://github.com/aligndottech/align-cli/issues/302)) ([ab3a16e](https://github.com/aligndottech/align-cli/commit/ab3a16e2d6440d61ed1c66dcff76ea16fa3a7721))
* **mcp:** port the timeline trio so a customer's agent can reach it ([#296](https://github.com/aligndottech/align-cli/issues/296)) ([45399e7](https://github.com/aligndottech/align-cli/commit/45399e762b09b17d9043377d77cb73ab199c78d1))


### Bug Fixes

* **ci:** pin LF line endings so the docs test stops failing on windows-latest ([#295](https://github.com/aligndottech/align-cli/issues/295)) ([ad66fb7](https://github.com/aligndottech/align-cli/commit/ad66fb78dde1340a7ad80c7e8308c815c9b490b6))
* **mcp:** follow-up - the 11 review findings [#296](https://github.com/aligndottech/align-cli/issues/296) merged without ([#298](https://github.com/aligndottech/align-cli/issues/298)) ([b311736](https://github.com/aligndottech/align-cli/commit/b311736bc0223ad55d8ff2882980a2f4e8173c17))
* **test:** normalise the path separator, so the retirement sweep passes on Windows ([#301](https://github.com/aligndottech/align-cli/issues/301)) ([5ac57d8](https://github.com/aligndottech/align-cli/commit/5ac57d87bcf28b405700a3439e62cc450b6fcf3b))

## [0.39.0](https://github.com/aligndottech/align-cli/compare/cli-v0.38.1...cli-v0.39.0) (2026-09-17)


### Features

* **mcp:** publish readOnlyHint annotations on every tool, so a client can derive the write set ([#293](https://github.com/aligndottech/align-cli/issues/293)) ([4c3d641](https://github.com/aligndottech/align-cli/commit/4c3d641db5661791aade319ecb74e6bd053b39e2))

## [0.38.1](https://github.com/aligndottech/align-cli/compare/cli-v0.38.0...cli-v0.38.1) (2026-09-16)


### Bug Fixes

* **ci:** a shell-suite runner only counts if a pull request reaches it ([#290](https://github.com/aligndottech/align-cli/issues/290)) ([70a9a5e](https://github.com/aligndottech/align-cli/commit/70a9a5e0bded84983a2032fdb45a1fa03205010d))
* **cli:** fall back when a decision title reads as its own policy statement ([#288](https://github.com/aligndottech/align-cli/issues/288)) ([fdafe20](https://github.com/aligndottech/align-cli/commit/fdafe20a565f24b9d27b5e50c3d74968cd452edd))
* **local:** stop fabricating status: 'active' on every local search result ([#292](https://github.com/aligndottech/align-cli/issues/292)) ([f4ab56f](https://github.com/aligndottech/align-cli/commit/f4ab56fed7e04225a9de41d749c6a6060851d74f))
* **test:** match with a herestring so pipefail cannot invert the result ([#291](https://github.com/aligndottech/align-cli/issues/291)) ([5cb75dd](https://github.com/aligndottech/align-cli/commit/5cb75dd72eb48f6ebf01c5710421ca6a32477426))

## [0.38.0](https://github.com/aligndottech/align-cli/compare/cli-v0.37.1...cli-v0.38.0) (2026-09-09)


### Features

* **agents:** the agent side leads with the check - align_check_alignment first, one instruction text with the hosted server, pre-edit hooks for Codex, Cursor and Copilot CLI ([#282](https://github.com/aligndottech/align-cli/issues/282)) ([f630b31](https://github.com/aligndottech/align-cli/commit/f630b3188845114449d7d0b12f0ad28a70fa39d6))
* align invite &lt;email&gt; and the teammate-request funnel signal ([#278](https://github.com/aligndottech/align-cli/issues/278)) ([279672f](https://github.com/aligndottech/align-cli/commit/279672f644facfe13fa9c3a9036d5ef466f07897))
* **cli:** read Claude Code auto-memory as a third session-import pass ([#285](https://github.com/aligndottech/align-cli/issues/285)) ([71571cb](https://github.com/aligndottech/align-cli/commit/71571cb266dc4fe0ac670d90a9c5553c44712556))
* **cli:** session-import funnel stages and the summary line ([#286](https://github.com/aligndottech/align-cli/issues/286)) ([ebb3a1f](https://github.com/aligndottech/align-cli/commit/ebb3a1ffe9ad59e303197f286a72a17cf52cbd05))
* **setup:** the next step is in the agent - the outro names the agent and the question, the second-run card names no CLI verb ([#280](https://github.com/aligndottech/align-cli/issues/280)) ([1057c65](https://github.com/aligndottech/align-cli/commit/1057c65c46db6b5f86a6aab4519a93cfbb4e7b7c))
* **telemetry:** local-mode split - install and setup_completed beacons by default, usage stays consent-gated ([#281](https://github.com/aligndottech/align-cli/issues/281)) ([19c6380](https://github.com/aligndottech/align-cli/commit/19c6380842d3db687dbc101cc654dce32dd753f0))


### Bug Fixes

* **cli:** re-land help tiers and align connect - [#283](https://github.com/aligndottech/align-cli/issues/283) merged into a dead branch, never reached main ([#284](https://github.com/aligndottech/align-cli/issues/284)) ([9cd72b4](https://github.com/aligndottech/align-cli/commit/9cd72b40f06d20e993565df1d3931070a4ded41f))
* **lib:** sync isSyntheticSource/navigableSourceUrl into decision-links.ts ([#275](https://github.com/aligndottech/align-cli/issues/275)) ([71cb4d9](https://github.com/aligndottech/align-cli/commit/71cb4d9ee90fd004d7e5774c89b09184ba72a7dc))
* **telemetry:** the funnel sees the wizard - setup_started/completed, bare align, MCP first_useful_decision ([#279](https://github.com/aligndottech/align-cli/issues/279)) ([ecd4fd2](https://github.com/aligndottech/align-cli/commit/ecd4fd2a16b8cbedba4afb7952cc7d016be16470))

## [0.37.1](https://github.com/aligndottech/align-cli/compare/cli-v0.37.0...cli-v0.37.1) (2026-09-07)


### Bug Fixes

* **import:** address Copilot review findings from [#272](https://github.com/aligndottech/align-cli/issues/272) ([#274](https://github.com/aligndottech/align-cli/issues/274)) ([90fc35f](https://github.com/aligndottech/align-cli/commit/90fc35ffda5825b967ad6e1622c0c130584b50fd))
* **local-import:** tombstones, honest zero-item messaging, local env resolution ([#272](https://github.com/aligndottech/align-cli/issues/272)) ([2be406c](https://github.com/aligndottech/align-cli/commit/2be406c9b25e76fdd7b32ff517f34eee0e825492))
* **local-llm:** allow ask to compose across decisions ([#269](https://github.com/aligndottech/align-cli/issues/269)) ([7fe10b7](https://github.com/aligndottech/align-cli/commit/7fe10b710f653aede8884e71d3d048afdbfd43a5))
* **local-llm:** detect paraphrased abstentions ([#270](https://github.com/aligndottech/align-cli/issues/270)) ([eeaefee](https://github.com/aligndottech/align-cli/commit/eeaefeeabb9c1175bb25f4bf33ec171112c2e286))

## [0.37.0](https://github.com/aligndottech/align-cli/compare/cli-v0.36.0...cli-v0.37.0) (2026-09-07)


### Features

* **import:** scope GitHub import to the current repo by default ([#267](https://github.com/aligndottech/align-cli/issues/267)) ([a719e7d](https://github.com/aligndottech/align-cli/commit/a719e7dc9de1a1ae8d1493c19da88439cd715c25))


### Bug Fixes

* **release:** auto-promote to latest when e2e-release.yml goes green ([#266](https://github.com/aligndottech/align-cli/issues/266)) ([6367b24](https://github.com/aligndottech/align-cli/commit/6367b241a996577fa24e683c84182f3a944df8a4))

## [0.36.0](https://github.com/aligndottech/align-cli/compare/cli-v0.35.0...cli-v0.36.0) (2026-09-07)


### Features

* **lib:** canonical model-facing decision render, TypeScript twin ([#260](https://github.com/aligndottech/align-cli/issues/260)) ([a0cb888](https://github.com/aligndottech/align-cli/commit/a0cb8885027f5868089d2cb13dae1a9c41314ef3))
* **sessions:** free-text session decision extraction, LLM-confirmed ([#265](https://github.com/aligndottech/align-cli/issues/265)) ([b994cd4](https://github.com/aligndottech/align-cli/commit/b994cd40241498b9c237569bbe7846fe76053d31))


### Bug Fixes

* **deps:** resolve real dependabot findings from launch-readiness triage ([#264](https://github.com/aligndottech/align-cli/issues/264)) ([b353e36](https://github.com/aligndottech/align-cli/commit/b353e3672f5abdcf5227caf6f5abe0e4c8eb9e59))
* **llm:** size prompts to the model's real context window ([#258](https://github.com/aligndottech/align-cli/issues/258)) ([3931ccb](https://github.com/aligndottech/align-cli/commit/3931ccb0b8468842d0c7e9ea0fc2912d31dff9a2))

## [0.35.0](https://github.com/aligndottech/align-cli/compare/cli-v0.34.1...cli-v0.35.0) (2026-09-03)


### Features

* agent decisions as claims, CLI half ([#253](https://github.com/aligndottech/align-cli/issues/253)) ([ff5c0f7](https://github.com/aligndottech/align-cli/commit/ff5c0f7614af3e84c323e4a4dd3925e05e74027c))


### Bug Fixes

* **ask:** render the synthesised answer as terminal text, never raw markdown ([#255](https://github.com/aligndottech/align-cli/issues/255)) ([9719871](https://github.com/aligndottech/align-cli/commit/971987181d025251ef93352f7d361c7b399300f5))

## [0.34.1](https://github.com/aligndottech/align-cli/compare/cli-v0.34.0...cli-v0.34.1) (2026-09-03)


### Bug Fixes

* **setup:** show the whole connector list now that the screen is cleared for it, and say when it scrolls ([#251](https://github.com/aligndottech/align-cli/issues/251)) ([759e007](https://github.com/aligndottech/align-cli/commit/759e007615a7185e1862c0dbda149ac9af58dc8b))

## [0.34.0](https://github.com/aligndottech/align-cli/compare/cli-v0.33.1...cli-v0.34.0) (2026-09-03)


### Features

* **setup:** a second setup run adds what you pick and leaves the rest alone ([#249](https://github.com/aligndottech/align-cli/issues/249)) ([383bf5f](https://github.com/aligndottech/align-cli/commit/383bf5f429223d118d0ac922d05a66b8bbf73f51))


### Bug Fixes

* **mcp:** mandate citing and linking a decision, both URLs ([#248](https://github.com/aligndottech/align-cli/issues/248)) ([e6123ae](https://github.com/aligndottech/align-cli/commit/e6123ae5fc9ccb0ce625ef65833b851b00ea6a69))

## [0.33.1](https://github.com/aligndottech/align-cli/compare/cli-v0.33.0...cli-v0.33.1) (2026-09-03)


### Bug Fixes

* **ask:** keep the spinner up for the whole answer, and restore isTTY in a leaky test ([#239](https://github.com/aligndottech/align-cli/issues/239)) ([7ac6f27](https://github.com/aligndottech/align-cli/commit/7ac6f275153018e77cce8a8e43bc61349abd70e0))
* **e2e:** assert the kept commit count, not a coin-flip link between two unrelated commits ([#246](https://github.com/aligndottech/align-cli/issues/246)) ([b462d1f](https://github.com/aligndottech/align-cli/commit/b462d1fac1e5a8446996d5ea65589155884152ca))

## [0.33.0](https://github.com/aligndottech/align-cli/compare/cli-v0.32.2...cli-v0.33.0) (2026-09-02)


### Features

* **capture:** report what each import fetched and skipped ([#240](https://github.com/aligndottech/align-cli/issues/240)) ([8660d47](https://github.com/aligndottech/align-cli/commit/8660d47726fd1b0c699a85af4a69a086ea12f406))
* **local:** source decision dates, the SDK's own skip reasons, honest import defaults ([#242](https://github.com/aligndottech/align-cli/issues/242)) ([487a461](https://github.com/aligndottech/align-cli/commit/487a461bca1000edb14c6c77969476a0af84a5c1))


### Bug Fixes

* **ask:** auto-widen a scoped search that misses, and kill deny-then-deliver abstentions ([#236](https://github.com/aligndottech/align-cli/issues/236)) ([149be27](https://github.com/aligndottech/align-cli/commit/149be271bdfae7702df96ce097a60d660b72b577))
* **capture:** escape the mechanical prefixes, and say what scanned means when unmeasured ([#241](https://github.com/aligndottech/align-cli/issues/241)) ([fdc2fd5](https://github.com/aligndottech/align-cli/commit/fdc2fd5928bfd23d60dc2d98716e10f717fedd7a))
* **setup:** one banner per flow, and stop overpromising "team sharing" ([#237](https://github.com/aligndottech/align-cli/issues/237)) ([b483032](https://github.com/aligndottech/align-cli/commit/b48303265e749721faaf15ffaa5378024215f49f))
* **test:** give decided-at.test.ts a Windows-sized timeout ([#245](https://github.com/aligndottech/align-cli/issues/245)) ([bfd98be](https://github.com/aligndottech/align-cli/commit/bfd98beda09f81679ebf7ba80d981b971eac65a0))

## [0.32.2](https://github.com/aligndottech/align-cli/compare/cli-v0.32.1...cli-v0.32.2) (2026-09-02)


### Bug Fixes

* **local:** converge the config directory conf actually uses with the one every doc claims ([#231](https://github.com/aligndottech/align-cli/issues/231)) ([bfdb1ee](https://github.com/aligndottech/align-cli/commit/bfdb1eeff55a439d2f58a0c5b9cf5341b81379fa))
* **local:** never let a synthesised answer contain an em-dash ([#232](https://github.com/aligndottech/align-cli/issues/232)) ([4320f8d](https://github.com/aligndottech/align-cli/commit/4320f8d49067c9997a0fd005f950d2d7e3a1fadb))

## [0.32.1](https://github.com/aligndottech/align-cli/compare/cli-v0.32.0...cli-v0.32.1) (2026-09-02)


### Bug Fixes

* **e2e:** update the git-import assertion for the summary line and the rationale gate ([#228](https://github.com/aligndottech/align-cli/issues/228)) ([d08d52c](https://github.com/aligndottech/align-cli/commit/d08d52ccb900a0bfbbf6e5cb119b8812efdcc98e))
* **release:** add the missing `done` to the promote workflow's retry loop ([#230](https://github.com/aligndottech/align-cli/issues/230)) ([a29c8f7](https://github.com/aligndottech/align-cli/commit/a29c8f7b95a41dde8fcb40d68600bad16e7ea866))

## [0.32.0](https://github.com/aligndottech/align-cli/compare/cli-v0.31.2...cli-v0.32.0) (2026-09-02)


### Features

* **import:** read ADRs and CLAUDE.md/AGENTS.md as decision candidates ([#222](https://github.com/aligndottech/align-cli/issues/222)) ([725c291](https://github.com/aligndottech/align-cli/commit/725c2916a1fe07f9fc09b77c7972ef463a4fd3e0))
* **local:** gap-driven connect prompt from unresolved refs ([#227](https://github.com/aligndottech/align-cli/issues/227)) ([241eeda](https://github.com/aligndottech/align-cli/commit/241eeda8a4eeb082ead2304d85ccf1e50868fd57))
* **setup:** value before the mode question - fresh align builds the local graph and shows what it found before asking anything ([#224](https://github.com/aligndottech/align-cli/issues/224)) ([90b32b1](https://github.com/aligndottech/align-cli/commit/90b32b115e081fbaf037f8dc81cb1eeb9793a254))


### Bug Fixes

* **import:** require a stated reason before a git commit becomes a decision ([#223](https://github.com/aligndottech/align-cli/issues/223)) ([7878c6e](https://github.com/aligndottech/align-cli/commit/7878c6e6bd39c0c95ea5d0e29bd2fae74a0dcff8))
* **local:** give the local graph a repo dimension ([#225](https://github.com/aligndottech/align-cli/issues/225)) ([6373ff7](https://github.com/aligndottech/align-cli/commit/6373ff7a0594e521bdb23eb609d7898c3b963cbf))
* **release:** retry the npm dist-tag verify read instead of failing on replication lag ([#221](https://github.com/aligndottech/align-cli/issues/221)) ([20b5ea4](https://github.com/aligndottech/align-cli/commit/20b5ea4bcbe44a1b2451b9540afc46bd2e1c1745))

## [0.31.2](https://github.com/aligndottech/align-cli/compare/cli-v0.31.1...cli-v0.31.2) (2026-09-01)


### Bug Fixes

* **local:** keep the read-only tokens setup asks for ([#219](https://github.com/aligndottech/align-cli/issues/219)) ([a478988](https://github.com/aligndottech/align-cli/commit/a478988805707cfd47cfcc090a9d9f23e443ea8f))

## [0.31.1](https://github.com/aligndottech/align-cli/compare/cli-v0.31.0...cli-v0.31.1) (2026-09-01)


### Bug Fixes

* **e2e:** assert the WIRE format - stage is a client payload field, cli.funnel.* is server-derived ([#217](https://github.com/aligndottech/align-cli/issues/217)) ([bcb4ca0](https://github.com/aligndottech/align-cli/commit/bcb4ca072f2be09bb86d01659ce85289e0e8a03d))

## [0.31.0](https://github.com/aligndottech/align-cli/compare/cli-v0.30.0...cli-v0.31.0) (2026-09-01)


### Features

* **import:** read the commit body and merges, extract refs, cite git decisions ([#213](https://github.com/aligndottech/align-cli/issues/213)) ([f6d222a](https://github.com/aligndottech/align-cli/commit/f6d222ab81270a85a03e169c140266a7a2b30396))
* **release:** staged releases with a real-user E2E gate and one-command promotion ([#216](https://github.com/aligndottech/align-cli/issues/216)) ([07bd555](https://github.com/aligndottech/align-cli/commit/07bd555fed44f4758c95e3d7f9cc64600962d183))
* **telemetry:** funnel-stage emitters - first_useful_decision, import_completed, mcp_wired ([#215](https://github.com/aligndottech/align-cli/issues/215)) ([9dad6fd](https://github.com/aligndottech/align-cli/commit/9dad6fd0d315bdb06f7ecfd3934b8d1d43243f7c))

## [0.30.0](https://github.com/aligndottech/align-cli/compare/cli-v0.29.1...cli-v0.30.0) (2026-09-01)


### Features

* **local:** relative linking - each decision's top-3 neighbours join the graph ([#212](https://github.com/aligndottech/align-cli/issues/212)) ([dbfccbf](https://github.com/aligndottech/align-cli/commit/dbfccbf5cf5708c8defe64be140d108ce83d492f))


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

* **local:** secret-free OAuth for GitHub, GitLab, Linear and Zoom ([#194](https://github.com/aligndottech/align-cli/issues/194)) ([b0de840](https://github.com/aligndottech/align-cli/commit/b0de8407990cc8783677e2269c8d4cee55ba7dd7))
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

* **check:** attribute CI checks to platform, PR and head sha ([#180](https://github.com/aligndottech/align-cli/issues/180)) ([753831a](https://github.com/aligndottech/align-cli/commit/753831a52c4bf359645dfe502279f74a9bf58c4b))
* wire agents automatically, disclose it, and ship the undo ([#181](https://github.com/aligndottech/align-cli/issues/181)) ([3529d15](https://github.com/aligndottech/align-cli/commit/3529d151557866ad552e68d38d38017346feb1d8))

## [0.24.1](https://github.com/aligndottech/align-cli/compare/cli-v0.24.0...cli-v0.24.1) (2026-08-30)


### Bug Fixes

* a local model gets minutes, not the hosted-API 15 seconds ([#178](https://github.com/aligndottech/align-cli/issues/178)) ([8cb8881](https://github.com/aligndottech/align-cli/commit/8cb8881a9d21b1f40056d6795a6fdaa7ccede0e1))

## [0.24.0](https://github.com/aligndottech/align-cli/compare/cli-v0.23.1...cli-v0.24.0) (2026-08-30)


### Features

* `align` sets you up, and no command needs an --env flag ([#176](https://github.com/aligndottech/align-cli/issues/176)) ([eb81028](https://github.com/aligndottech/align-cli/commit/eb8102824a9779a302fd89225a22861041373a90))


### Bug Fixes

* do not claim the graph is empty when only the query matched nothing ([#174](https://github.com/aligndottech/align-cli/issues/174)) ([92d40d4](https://github.com/aligndottech/align-cli/commit/92d40d48ebf3cc589dc43d2b9ab8312ce7207a9f))
* say how many decisions were actually new on a re-import ([#173](https://github.com/aligndottech/align-cli/issues/173)) ([c0dac29](https://github.com/aligndottech/align-cli/commit/c0dac29d2ee708f04892801348e1a3de9f9d0206))

## [0.23.1](https://github.com/aligndottech/align-cli/compare/cli-v0.23.0...cli-v0.23.1) (2026-08-30)


### Bug Fixes

* a configured provider that never answered is not "no provider" ([#170](https://github.com/aligndottech/align-cli/issues/170)) ([6ffb0b1](https://github.com/aligndottech/align-cli/commit/6ffb0b11d5583479d3448db17cf3e2510fe008a9))

## [0.23.0](https://github.com/aligndottech/align-cli/compare/cli-v0.22.0...cli-v0.23.0) (2026-08-30)


### ⚠ BREAKING CHANGES

* engines.node moves from >=20 to >=22.16. That is where node:sqlite is unflagged (22.13) and DatabaseSync.isTransaction exists (22.16). Node 20 is already EOL.

### Features

* on-device embeddings in the standalone binary, via a bundled WASM backend ([#169](https://github.com/aligndottech/align-cli/issues/169)) ([56c7698](https://github.com/aligndottech/align-cli/commit/56c769875cdaf9fcccd14bf1cab0798bd5a6b7a5))
* ship standalone binaries, and drop the last native dependency ([#167](https://github.com/aligndottech/align-cli/issues/167)) ([1cd567f](https://github.com/aligndottech/align-cli/commit/1cd567fa6803a887cba9845cc31264add3e31329))
* **telemetry:** anonymous opt-in usage pings for local-only users ([#165](https://github.com/aligndottech/align-cli/issues/165)) ([1883304](https://github.com/aligndottech/align-cli/commit/18833047c5d5c3a9993d8e89825ef432c94596a3))

## [0.22.0](https://github.com/aligndottech/align-cli/compare/cli-v0.21.2...cli-v0.22.0) (2026-08-29)


### Features

* **action:** name the check_event_id and the remedy on the PR itself ([#163](https://github.com/aligndottech/align-cli/issues/163)) ([33b7138](https://github.com/aligndottech/align-cli/commit/33b71387bcb182b36595b09bee5d650748883a3f))

## [0.21.2](https://github.com/aligndottech/align-cli/compare/cli-v0.21.1...cli-v0.21.2) (2026-08-28)


### Bug Fixes

* **action:** a WARNING conflict should not block a merge ([63180f4](https://github.com/aligndottech/align-cli/commit/63180f4e5476fa5256e97e7ab830cf73d0f443cd))
* **action:** a WARNING conflict should not block a merge ([4eaaacc](https://github.com/aligndottech/align-cli/commit/4eaaacc00dbf9796eab6a3fe3f2eb72c992684be))
* **action:** mirror every file action.yml resolves, not a list that drifts ([#160](https://github.com/aligndottech/align-cli/issues/160)) ([3994fb3](https://github.com/aligndottech/align-cli/commit/3994fb3167de5703cb5ca98bf4ce9b5680aae53d))
* **action:** the mirror published an unusable ref, and the test could not see it ([#161](https://github.com/aligndottech/align-cli/issues/161)) ([eae0842](https://github.com/aligndottech/align-cli/commit/eae0842f331bc08c77845ed1ea7bee81cc8c3b84))

## [0.21.1](https://github.com/aligndottech/align-cli/compare/cli-v0.21.0...cli-v0.21.1) (2026-08-27)


### Bug Fixes

* **ci:** cache the embedding model, and stop a huggingface 429 reading as our defect ([eeed6c1](https://github.com/aligndottech/align-cli/commit/eeed6c1e2fadc82dffb5f072a4be5787e7c8be35))
* **ci:** cache the embedding model, and stop a huggingface 429 reading as our defect ([b8ec250](https://github.com/aligndottech/align-cli/commit/b8ec250d06f8a3c0e1628948253401c5ec788b2f))
* **search:** a natural-language question no longer misses what its own keywords find ([32485c0](https://github.com/aligndottech/align-cli/commit/32485c08a94e7da5ad5cdd19d1c1b35a1083d76e))
* **search:** a natural-language question no longer misses what its own keywords find ([f7c60ed](https://github.com/aligndottech/align-cli/commit/f7c60ed7facb3b9bd2320b14f3411344f9e0999e))
* **search:** see through the punctuation and contractions a real question carries ([6ad1ffb](https://github.com/aligndottech/align-cli/commit/6ad1ffb5bf9042b77eac4214168517288ca471bd))

## [0.21.0](https://github.com/aligndottech/align-cli/compare/cli-v0.20.0...cli-v0.21.0) (2026-08-27)


### Features

* **check:** a human can answer a check that declined to rule ([6f3dc60](https://github.com/aligndottech/align-cli/commit/6f3dc6066d45d41637f730c9021c57752ef85c7a))
* **check:** a human can answer a check that declined to rule ([3b805b2](https://github.com/aligndottech/align-cli/commit/3b805b2d845f8123e33f9da7e1c2f5f10bc5d178))
* **check:** deferred adjudication for the advisory hook ([c9122b6](https://github.com/aligndottech/align-cli/commit/c9122b69096c6cabb3c919abfd1804176b2f9b51))
* **check:** deferred adjudication for the advisory hook ([d3dcc07](https://github.com/aligndottech/align-cli/commit/d3dcc072fd57c333c99a84120f945a684bda12e3))


### Bug Fixes

* **action:** address the four review comments on the adjudication override ([b58cd54](https://github.com/aligndottech/align-cli/commit/b58cd54ad23c9532dd3aa8221662de9f80201307))
* **check:** address two fresh-context reviews of the deferred adjudication ([562c4c3](https://github.com/aligndottech/align-cli/commit/562c4c3656c8b9d5d6f892c09103c7491c5f4164))
* **test:** scope the store permission assertion to POSIX ([93c82c5](https://github.com/aligndottech/align-cli/commit/93c82c5c1ab08b8b126cb03bed23d93e33a95e8a))

## [0.20.0](https://github.com/aligndottech/align-cli/compare/cli-v0.19.1...cli-v0.20.0) (2026-08-27)


### Features

* **check:** --depth exhaustive - a strict gate pays for the verdict ([678b50b](https://github.com/aligndottech/align-cli/commit/678b50ba3ff2bdd1ee0ef81c8ce2c35afb1be44f))
* **check:** --depth exhaustive - a strict gate pays for the verdict ([7491544](https://github.com/aligndottech/align-cli/commit/7491544719a2d03111c62939cbf71110398c4772))


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

* **llm:** advance the fallback chain only on availability failures; discover Ollama models by family ([41f90d7](https://github.com/aligndottech/align-cli/commit/41f90d783c0047efe9a9b81dd866b8c6f44ce07c))
* **llm:** availability-only fallback + live Ollama family discovery ([5e54138](https://github.com/aligndottech/align-cli/commit/5e5413881d9192f4b33cd5bae1b2adfb5535f40a))


### Bug Fixes

* **llm:** repair the fallback classification and family floor found by review ([09d8b91](https://github.com/aligndottech/align-cli/commit/09d8b919c316d7bcc8f9e28ff702920e53645f88))

## [0.18.0](https://github.com/aligndottech/align-cli/compare/cli-v0.17.1...cli-v0.18.0) (2026-08-26)


### Features

* **action:** mirror script to publish the action at a repository root ([8d3c49e](https://github.com/aligndottech/align-cli/commit/8d3c49e5e32c9390cf95875f5ca4be60e92d00e4))
* **action:** mirror script to publish this action at a repository root ([43d3f52](https://github.com/aligndottech/align-cli/commit/43d3f526e138df282561d598ccb1e934a9424954))


### Bug Fixes

* **ask:** the synthesis prompt licensed confabulation - add the abstention contract, measured ([90634d0](https://github.com/aligndottech/align-cli/commit/90634d025b2565c6485dc76d441194b7a058a06b))
* **ask:** the synthesis prompt licensed confabulation - add the abstention contract, measured ([7721671](https://github.com/aligndottech/align-cli/commit/7721671fb7682d8fc058cbba42f3a38c656113d7))
* **check:** --ci exited 0 when the gateway never answered, so an outage read as a pass ([176ae49](https://github.com/aligndottech/align-cli/commit/176ae49bc9cd0d0d4fae04738403200f418df7f3))
* **check:** --ci outside a git repo exited 1 with no output at all ([6b8afd8](https://github.com/aligndottech/align-cli/commit/6b8afd86a18cc1fec086520357b8dd75dba38ae4))
* **check:** two ways --ci reported a check that could not run as a result ([a4560c4](https://github.com/aligndottech/align-cli/commit/a4560c41e1649dc2961a46987f091a344c05b528))
* **test:** repair the orphaned `finally` an autofix left in action-mirror ([7ee6ea1](https://github.com/aligndottech/align-cli/commit/7ee6ea1a323fc5f0f73c489e99fa96e896305998))


### Performance Improvements

* **action:** prune the optional ML dependency from the CI install (431MB -&gt; 45MB) ([df3fdb8](https://github.com/aligndottech/align-cli/commit/df3fdb8295518ef3a724e326d8885adf09e91750))
* **action:** prune the optional ML dependency from the CI install, 431MB to 45MB ([08970a4](https://github.com/aligndottech/align-cli/commit/08970a4e3d351871f43554b179e15491eddb5838))

## [0.17.1](https://github.com/aligndottech/align-cli/compare/cli-v0.17.0...cli-v0.17.1) (2026-08-25)


### Bug Fixes

* **mcp-registry:** registry rejects descriptions over 100 chars - shorten and pin it ([6c47546](https://github.com/aligndottech/align-cli/commit/6c47546ae5f6e70b9a5eb2f04f65556392dfd2a5))
* **mcp-registry:** registry rejects descriptions over 100 chars ([b4f3bc2](https://github.com/aligndottech/align-cli/commit/b4f3bc28ab07e64800485d78677ab4e8ab3050aa))

## [0.17.0](https://github.com/aligndottech/align-cli/compare/cli-v0.16.0...cli-v0.17.0) (2026-08-25)


### Features

* **mcp-registry:** publish to registry.modelcontextprotocol.io on every release ([#128](https://github.com/aligndottech/align-cli/issues/128)) ([949c876](https://github.com/aligndottech/align-cli/commit/949c876b489b14b17952b37d58d90100d17cc3f5))


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

* **import:** no-account users' imports land in the local graph instead of 401ing against cloud ([#122](https://github.com/aligndottech/align-cli/issues/122)) ([ca69e53](https://github.com/aligndottech/align-cli/commit/ca69e53f568fc555a8cbf8137ee72b7c24e95bc5))

## [0.14.0](https://github.com/aligndottech/align-cli/compare/cli-v0.13.0...cli-v0.14.0) (2026-08-24)


### Features

* **context:** align context sync - write the decision graph into the files agents read ([#120](https://github.com/aligndottech/align-cli/issues/120)) ([85a5ccc](https://github.com/aligndottech/align-cli/commit/85a5cccec1d219a2d028038f3cd2d6c7a7b4db77))

## [0.13.0](https://github.com/aligndottech/align-cli/compare/cli-v0.12.1...cli-v0.13.0) (2026-08-24)


### Features

* **context:** spike proof - a decisions file Align owns, imported not spliced ([#116](https://github.com/aligndottech/align-cli/issues/116)) ([ea226eb](https://github.com/aligndottech/align-cli/commit/ea226eb9852912571d668daab95bbd7db2837c06))


### Bug Fixes

* **client:** refuse a tenant that nothing authenticates ([#113](https://github.com/aligndottech/align-cli/issues/113)) ([ea9c653](https://github.com/aligndottech/align-cli/commit/ea9c653f164eaed51ba03dd8cf320c00b1f1af18))
* correct the licence holder and year ([#117](https://github.com/aligndottech/align-cli/issues/117)) ([029b863](https://github.com/aligndottech/align-cli/commit/029b86352b2cf0aa4dc9affd590b0179a9ab2d47))
* **setup:** setup --local completes without a TTY instead of hanging or crashing at the connector prompt ([#118](https://github.com/aligndottech/align-cli/issues/118)) ([eb8e393](https://github.com/aligndottech/align-cli/commit/eb8e39365c0895450c3e1da6f5fffd6a72d0e163))

## [0.12.1](https://github.com/aligndottech/align-cli/compare/cli-v0.12.0...cli-v0.12.1) (2026-08-17)


### Bug Fixes

* **local:** cosine similarity is `relates`, not a conflict caught ([#111](https://github.com/aligndottech/align-cli/issues/111)) ([98f3a07](https://github.com/aligndottech/align-cli/commit/98f3a07ef939003892764342c0c7cc835acc5750))

## [0.12.0](https://github.com/aligndottech/align-cli/compare/cli-v0.11.0...cli-v0.12.0) (2026-08-17)


### Features

* **action:** anchor conflicts to the files that produced them ([#109](https://github.com/aligndottech/align-cli/issues/109)) ([87b721d](https://github.com/aligndottech/align-cli/commit/87b721dc71f29a70dc03926d25d6f93d25de0105))


### Bug Fixes

* **ask:** refuse to synthesise with an unvetted Ollama model ([#110](https://github.com/aligndottech/align-cli/issues/110)) ([43c439f](https://github.com/aligndottech/align-cli/commit/43c439f8d1188c187876ea79117f499f3ee503ce))
* **gateway-client:** follow decision-links cursor in getConflicts ([#106](https://github.com/aligndottech/align-cli/issues/106)) ([f9c9f92](https://github.com/aligndottech/align-cli/commit/f9c9f92437fe701c0ff8f6268b713b1d7eb4bba4))
* honest link listings and active-only conflict counts ([#108](https://github.com/aligndottech/align-cli/issues/108)) ([0b1f916](https://github.com/aligndottech/align-cli/commit/0b1f91618c47654ba38169f28e8f4eca5c4bd6ce))

## [0.11.0](https://github.com/aligndottech/align-cli/compare/cli-v0.10.0...cli-v0.11.0) (2026-08-15)


### Features

* **check:** --title sends the proposed decision in words, and stop interpolating github.event into shell ([#104](https://github.com/aligndottech/align-cli/issues/104)) ([bfeeb45](https://github.com/aligndottech/align-cli/commit/bfeeb45e06103e847dd206cc460c7559563dd7b9))

## [0.10.0](https://github.com/aligndottech/align-cli/compare/cli-v0.9.0...cli-v0.10.0) (2026-08-14)


### Features

* align import &lt;src&gt; --personal - browser OAuth for imports, no PAT needed ([#103](https://github.com/aligndottech/align-cli/issues/103)) ([c70b182](https://github.com/aligndottech/align-cli/commit/c70b182bef43d6d7cd14addaebe5712bede4e30b))


### Bug Fixes

* **action:** a no-context result is a complete check, not a failed one ([#99](https://github.com/aligndottech/align-cli/issues/99)) ([62bdd4b](https://github.com/aligndottech/align-cli/commit/62bdd4b872516ad8a347a057e93faaacdfbc109b))
* **action:** remove a stray esac, and gate the action's shell syntax ([#97](https://github.com/aligndottech/align-cli/issues/97)) ([8cb3cd7](https://github.com/aligndottech/align-cli/commit/8cb3cd7c07f37cd84de989b76a21fea1520f44ff))
* **action:** surface the gateway's reason when a check does not complete ([#100](https://github.com/aligndottech/align-cli/issues/100)) ([878c2e0](https://github.com/aligndottech/align-cli/commit/878c2e0e5db495b257a3477321bd06857fed4871))
* surface honesty sweep - five places the CLI claimed more than the code does ([#102](https://github.com/aligndottech/align-cli/issues/102)) ([d4a9f6e](https://github.com/aligndottech/align-cli/commit/d4a9f6ee51813996fd48f814288885b39ef83273))

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

* **mcp:** reject a tool call missing a required argument, naming it ([#83](https://github.com/aligndottech/align-cli/issues/83)) ([20ff703](https://github.com/aligndottech/align-cli/commit/20ff70346e8c623d564b1058e95d711115c7cfb2))

## [0.7.1](https://github.com/aligndottech/align-cli/compare/cli-v0.7.0...cli-v0.7.1) (2026-08-01)


### Bug Fixes

* **deps:** replace @xenova/transformers with @huggingface/transformers ([#82](https://github.com/aligndottech/align-cli/issues/82)) ([ac90653](https://github.com/aligndottech/align-cli/commit/ac90653d585bf065d05e00f86ab4687104550eee))
* **import:** pass --approve and --env through to import subcommands ([#79](https://github.com/aligndottech/align-cli/issues/79)) ([2dfd673](https://github.com/aligndottech/align-cli/commit/2dfd673be9df40f58dc24680538915575e735a39))
* **mcp:** back the MCP server with the local graph for a no-account user ([#81](https://github.com/aligndottech/align-cli/issues/81)) ([46e87da](https://github.com/aligndottech/align-cli/commit/46e87da7a7915f29685836ac26814b314a67968c))

## [0.7.0](https://github.com/aligndottech/align-cli/compare/cli-v0.6.0...cli-v0.7.0) (2026-08-01)


### Features

* **cli:** identify the CLI to the gateway and record one usage event per command ([#77](https://github.com/aligndottech/align-cli/issues/77)) ([b19c9b2](https://github.com/aligndottech/align-cli/commit/b19c9b2f5ebacd95a19494cfe65eff192f2e99a8))

## [0.6.0](https://github.com/aligndottech/align-cli/compare/cli-v0.5.0...cli-v0.6.0) (2026-08-01)


### Features

* **cli:** autonomous "what your graph did for you" value readout ([#74](https://github.com/aligndottech/align-cli/issues/74)) ([5cbf841](https://github.com/aligndottech/align-cli/commit/5cbf841fd3b776bb9c7aefdecb2459c9061e3eff))


### Bug Fixes

* **check:** add an explicit "unknown" state so a check that could not run stops reporting "aligned" ([#76](https://github.com/aligndottech/align-cli/issues/76)) ([c0ea263](https://github.com/aligndottech/align-cli/commit/c0ea263f2c9b109841835af495906f82204ee9fe))
* **local:** consume canonical relationship contract, drop invented types ([#73](https://github.com/aligndottech/align-cli/issues/73)) ([4fdbdb1](https://github.com/aligndottech/align-cli/commit/4fdbdb17cff07641b58be0d20bfb40a6848d202a))
* **local:** deterministic offline relationship detection ([#71](https://github.com/aligndottech/align-cli/issues/71)) ([9f3dbae](https://github.com/aligndottech/align-cli/commit/9f3dbae8c641f1932113b4c59279b9cd00501f17))

## [0.5.0](https://github.com/aligndottech/align-cli/compare/cli-v0.4.2...cli-v0.5.0) (2026-06-28)


### Features

* **setup:** make MCP setup agent-agnostic ([#69](https://github.com/aligndottech/align-cli/issues/69)) ([de2a4b9](https://github.com/aligndottech/align-cli/commit/de2a4b99158f5387ba03aa39245441ab75bd98d1))

## [0.4.2](https://github.com/aligndottech/align-cli/compare/cli-v0.4.1...cli-v0.4.2) (2026-06-27)


### Bug Fixes

* offer expired-token reconnect for all connectors, not just Atlassian ([#67](https://github.com/aligndottech/align-cli/issues/67)) ([ce0b729](https://github.com/aligndottech/align-cli/commit/ce0b72985ba1768a834158f03db24eea57a95f8c))

## [0.4.1](https://github.com/aligndottech/align-cli/compare/cli-v0.4.0...cli-v0.4.1) (2026-06-27)


### Bug Fixes

* repair CLI first-run launch-blockers (local mode, ask/search/check, import git) ([#62](https://github.com/aligndottech/align-cli/issues/62)) ([c2d67a0](https://github.com/aligndottech/align-cli/commit/c2d67a02a488bbbe778a8e48fe35be1be0dc772f))
* make npm i -g robust (optional native ML dep) + OSS hygiene ([#65](https://github.com/aligndottech/align-cli/issues/65)) ([651bfa0](https://github.com/aligndottech/align-cli/commit/651bfa0a88a722d5713d07639e094d0deaf9941d))

## [0.4.0](https://github.com/aligndottech/align-cli/compare/cli-v0.3.0...cli-v0.4.0) (2026-06-03)


### Features

* **llm:** provider-agnostic resolver - generic OpenAI-compatible base URL + Grok ([#58](https://github.com/aligndottech/align-cli/issues/58)) ([64f0ec0](https://github.com/aligndottech/align-cli/commit/64f0ec0c4dea8bde3630337f3f3e64b087bb1694))

## [0.3.0](https://github.com/aligndottech/align-cli/compare/cli-v0.2.0...cli-v0.3.0) (2026-06-02)


### Features

* **setup:** raise free-tier import limits to 250 (connector-core 0.2.0 pagination) ([#56](https://github.com/aligndottech/align-cli/issues/56)) ([1dfbbf2](https://github.com/aligndottech/align-cli/commit/1dfbbf22ce682333e56e1118122e774a71e9c0da))

## [0.2.0](https://github.com/aligndottech/align-cli/compare/cli-v0.1.4...cli-v0.2.0) (2026-06-02)


### Features

* wire CLI onto @aligndottech/connector-core ([#52](https://github.com/aligndottech/align-cli/issues/52)) ([bfb00f3](https://github.com/aligndottech/align-cli/commit/bfb00f3101d210bc1c81bd6ea6c9400abc21ebdc))


### Bug Fixes

* **setup:** one OAuth for shared Atlassian app on reconnect ([#53](https://github.com/aligndottech/align-cli/issues/53)) ([93a7d70](https://github.com/aligndottech/align-cli/commit/93a7d70f27029e9c1d9c143f1a55f2fb65a75210))
