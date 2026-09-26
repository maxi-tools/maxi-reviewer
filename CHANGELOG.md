# Changelog

## [1.2.0](https://github.com/maxi-tools/maxi-reviewer/compare/v1.1.0...v1.2.0) (2026-09-26)


### Features

* add an OpenAI-compatible reviewer as a Jules fallback ([47d479a](https://github.com/maxi-tools/maxi-reviewer/commit/47d479ac7c4f29cfbef73691f0b081c28afc0fe5))
* **calibration:** weekly reviewer-profile harvest publishes reviewer-profiles.json ([81e2dc3](https://github.com/maxi-tools/maxi-reviewer/commit/81e2dc3baf39ec2c7f1d51f7255fd38a297d1608))
* **calibration:** weekly reviewer-profile harvest publishes reviewer-profiles.json ([c0d4480](https://github.com/maxi-tools/maxi-reviewer/commit/c0d44807eec63451b71085f858077361f44cb238))
* **harvest:** publish the analysis beside the data, every run ([f13bb84](https://github.com/maxi-tools/maxi-reviewer/commit/f13bb8459a99d4fe143d4e6846a74d8bafaada80))
* **harvest:** publish the analysis beside the data, every run ([0704c7e](https://github.com/maxi-tools/maxi-reviewer/commit/0704c7e90f1f5ed153395006e67153017120e0ba))
* OpenAI-compatible reviewer as a Jules fallback ([b3c5f1c](https://github.com/maxi-tools/maxi-reviewer/commit/b3c5f1cb17377285c6d7e7cf3abf3665af135b64))


### Bug Fixes

* **calibration-harvest:** address CodeRabbit print-width + test-typing findings ([835318a](https://github.com/maxi-tools/maxi-reviewer/commit/835318a4756663fceb5adc8d878274dc72b17b52))
* **calibration-harvest:** address six reviewer findings ([034dd31](https://github.com/maxi-tools/maxi-reviewer/commit/034dd31095f267cd73a858084f7b8af8d3f69ad5))
* **calibration-harvest:** contents:write for release, path-group in README ([a709237](https://github.com/maxi-tools/maxi-reviewer/commit/a709237ce98e49600e2e320ec626c5b4c2399fce))
* **calibration-harvest:** drop metadata from job permissions, cut release with native token ([338ee5b](https://github.com/maxi-tools/maxi-reviewer/commit/338ee5bfe21c2e91eb2d70afe7f08d8ac4ec840c))
* **calibration-harvest:** parenthesise each side of the org-search OR ([53e4bd0](https://github.com/maxi-tools/maxi-reviewer/commit/53e4bd058d5934831f9dad1dd0d7f12635822590))
* **calibration-harvest:** parenthesise each side of the org-search OR ([11571f3](https://github.com/maxi-tools/maxi-reviewer/commit/11571f36b204a78e1d99c23ee47b43375646787d))
* **calibration-harvest:** pin upload-artifact and revert contents:write ([bc1a5f8](https://github.com/maxi-tools/maxi-reviewer/commit/bc1a5f8d82b4e00415116131ca108147921904d8))
* **calibration-harvest:** pin upload-artifact to v7.0.1 ([56f47a3](https://github.com/maxi-tools/maxi-reviewer/commit/56f47a31c810d56f2fd69ed60767d338e79f8079))
* **calibration-harvest:** rename graphql variable away from reserved 'query' key ([bc6d167](https://github.com/maxi-tools/maxi-reviewer/commit/bc6d167dd36d5476dd8014506636a8e1a330d0ac))
* **calibration-harvest:** rename graphql variable away from reserved 'query' key ([f9f078e](https://github.com/maxi-tools/maxi-reviewer/commit/f9f078e6c3a62ffedfe3908a0991d3510848bc85))
* **calibration-harvest:** swap permission-issues for permission-metadata ([02e3517](https://github.com/maxi-tools/maxi-reviewer/commit/02e351747c09f27c8c0642f3b5f7bafa47fd934f))
* **calibration:** normalize leading slashes before bucketing byPath findings ([794ff8d](https://github.com/maxi-tools/maxi-reviewer/commit/794ff8dce8b2fd30036793aa5041765673706126))
* **harvest:** `gh release delete` takes --cleanup-tag, not --cleanup-tags ([9adc8e2](https://github.com/maxi-tools/maxi-reviewer/commit/9adc8e25b16dcff7925ef2d437de84f5735c738d))
* **harvest:** a PR is only un-amendable if every finding on it was read ([44e6a92](https://github.com/maxi-tools/maxi-reviewer/commit/44e6a924d9dbe4f603fdcb3bfd67eb167eed403b))
* **harvest:** a PR nobody could amend is not evidence about a reviewer ([c61f08e](https://github.com/maxi-tools/maxi-reviewer/commit/c61f08e229dae3c714ed5de53d99ca19707d3728))
* **harvest:** a PR nobody could amend is not evidence about a reviewer ([d0f8bc9](https://github.com/maxi-tools/maxi-reviewer/commit/d0f8bc975790a7d3a5322fbbc8a9708b06819386))
* **harvest:** close three holes review found in the [#133](https://github.com/maxi-tools/maxi-reviewer/issues/133) fix itself ([e58da17](https://github.com/maxi-tools/maxi-reviewer/commit/e58da1797d703768de501fc86b04ff366f6c2359))
* **harvest:** get commit paths from REST, and stop publishing a failed ([8eb1628](https://github.com/maxi-tools/maxi-reviewer/commit/8eb1628031cd5765bd8152891d8ca28f51a498fd))
* **harvest:** get commit paths from REST, and stop publishing a failed measurement as data ([3976bc9](https://github.com/maxi-tools/maxi-reviewer/commit/3976bc962f7c63f6061fbb051a732e0f2426dbc6))
* **harvest:** make the accept rate measurable, and let the release publish ([ff00d4b](https://github.com/maxi-tools/maxi-reviewer/commit/ff00d4b79eb5242c021e3146ef0e1e98e489b45e))
* **harvest:** paginate a commit's files, and test the path that carries the behaviour ([ecf08f0](https://github.com/maxi-tools/maxi-reviewer/commit/ecf08f0a8c21a343e7a2da2fc8a89ed0b3612893))
* **harvest:** walk commits on every PR, so `accepted` is reachable ([91e37fe](https://github.com/maxi-tools/maxi-reviewer/commit/91e37fed4fb7ffe8482dbfecb4f5a27aee383b22))
* **jules,calibration:** bound remaining SDK hangs and finish [#61](https://github.com/maxi-tools/maxi-reviewer/issues/61) guards ([fe487b4](https://github.com/maxi-tools/maxi-reviewer/commit/fe487b464b08b01c2cb02e85515e46526813fcfb))
* **jules:** bound hydrate/history calls and repair rounds to the poll deadline ([52fd7fb](https://github.com/maxi-tools/maxi-reviewer/commit/52fd7fb944ab478262127ffb690ef9a410bd514c))
* **profiles:** "accepted" means that file was touched, not that bucket ([b1ccf91](https://github.com/maxi-tools/maxi-reviewer/commit/b1ccf9179ae9d1ea03bd94ce49eabf92fca86404))
* **profiles:** "accepted" means that file was touched, not that bucket ([8fa212d](https://github.com/maxi-tools/maxi-reviewer/commit/8fa212d029137ea15a93e177bd3ce9654bbf0965))
* **report:** keep the table valid when no path group qualifies ([4a23848](https://github.com/maxi-tools/maxi-reviewer/commit/4a2384821760dff4d7064997ee65ec9af5cd3c01))
* **schema,calibration:** deep-validate legacy newComments elements, guard null elements ([597acfd](https://github.com/maxi-tools/maxi-reviewer/commit/597acfdcfcb1369aad2852d5fbd90bf7c8620f8a))

## [1.1.0](https://github.com/maxi-tools/maxi-reviewer/compare/v1.0.0...v1.1.0) (2026-09-18)


### Features

* add agentic retrieval loop (read_file/grep/list_references at PR head) ([ac7a8a4](https://github.com/maxi-tools/maxi-reviewer/commit/ac7a8a4a0bb933c70dbb3b9b208401bd4bda2504))
* add validateRetrievalRequest schema validator ([b38d3d1](https://github.com/maxi-tools/maxi-reviewer/commit/b38d3d1e1c9ed4b4c894dc8d8d9788976f2ad008))
* agentic retrieval loop — let the reviewer read files / grep / list references on demand ([#11](https://github.com/maxi-tools/maxi-reviewer/issues/11)) ([ea1fdb6](https://github.com/maxi-tools/maxi-reviewer/commit/ea1fdb63742f63b43fe232f16a096e601663adfa))
* **anchor:** drift-tolerant finding anchors that survive rebase/force-push ([#16](https://github.com/maxi-tools/maxi-reviewer/issues/16)) ([5e65b0b](https://github.com/maxi-tools/maxi-reviewer/commit/5e65b0b9edbce81f1ddcc52c6bb00dcb4666ad18))
* **anchor:** rebase-stable finding anchors ([#16](https://github.com/maxi-tools/maxi-reviewer/issues/16)) ([6a15e18](https://github.com/maxi-tools/maxi-reviewer/commit/6a15e18731a69b5556fe1cf4ad50dd1d851de62c))
* **calibration:** accept-rate calibration engine over harvested artifacts ([#17](https://github.com/maxi-tools/maxi-reviewer/issues/17)) ([b19c6cb](https://github.com/maxi-tools/maxi-reviewer/commit/b19c6cb0651b7704fdd649523551bc03aa67105b))
* **calibration:** accept-rate calibration engine over harvested artifacts ([#17](https://github.com/maxi-tools/maxi-reviewer/issues/17)) ([4dcf73d](https://github.com/maxi-tools/maxi-reviewer/commit/4dcf73dbbed3fecd69d94113998622b9de1c4ffd))
* **ci-signal:** ingest CI check-runs + test/coverage reports into the review ([#12](https://github.com/maxi-tools/maxi-reviewer/issues/12)) ([c2512b9](https://github.com/maxi-tools/maxi-reviewer/commit/c2512b95c84e32e17439405c87269b3652082890))
* **ci-signal:** ingest CI/test/coverage signal into the review ([#12](https://github.com/maxi-tools/maxi-reviewer/issues/12)) ([9dee5bd](https://github.com/maxi-tools/maxi-reviewer/commit/9dee5bdf346dd2ae21383adbf88b48998d02aca5))
* **dedupe:** dedup against other review bots' active comments ([#15](https://github.com/maxi-tools/maxi-reviewer/issues/15)) ([b94a749](https://github.com/maxi-tools/maxi-reviewer/commit/b94a749dcfdbb7482024e89bf071a2610eb1f7a0))
* **dedupe:** pass other reviewers active findings to the prompt to avoid restating ([#15](https://github.com/maxi-tools/maxi-reviewer/issues/15)) ([d82e002](https://github.com/maxi-tools/maxi-reviewer/commit/d82e002cdc59ab7743eba0fc8ed200c7822952d3))
* exclude generated/vendored artifacts from the reviewed diff ([f9e2c9c](https://github.com/maxi-tools/maxi-reviewer/commit/f9e2c9c5e204833da8b837c04facac0c58e7158a))
* exclude generated/vendored artifacts from the reviewed diff ([#19](https://github.com/maxi-tools/maxi-reviewer/issues/19)) ([454f0f2](https://github.com/maxi-tools/maxi-reviewer/commit/454f0f2173dadcdf69f252572f9218e4e395c128))
* feed surrounding file context to the review prompt ([11a8fb2](https://github.com/maxi-tools/maxi-reviewer/commit/11a8fb291ede3171822c796fb9ccf9b26dff5e75))
* feed surrounding file context to the review prompt ([#10](https://github.com/maxi-tools/maxi-reviewer/issues/10)) ([0203710](https://github.com/maxi-tools/maxi-reviewer/commit/0203710714a9d3f0f5d5d5757400712201116bf3))
* ground review in linked issue acceptance criteria ([#13](https://github.com/maxi-tools/maxi-reviewer/issues/13)) ([c9dfe78](https://github.com/maxi-tools/maxi-reviewer/commit/c9dfe78eb15d6084f77c5de1f637030f88cd6d03))
* ground review in linked issue acceptance criteria ([#13](https://github.com/maxi-tools/maxi-reviewer/issues/13)) ([fbfd49d](https://github.com/maxi-tools/maxi-reviewer/commit/fbfd49d3f887918c4c5357b72756fdec171b8dee))
* refresh the pending review status so a stalled session is visible ([bc25886](https://github.com/maxi-tools/maxi-reviewer/commit/bc2588629d7f2c578aeaf305989e65cc4ca2c3f1))
* refresh the pending review status so a stalled session is visible ([04aa040](https://github.com/maxi-tools/maxi-reviewer/commit/04aa040f374e6519aa69a334304489fffd5229a4))
* **retrieval:** grep robustness — concurrent fetch, truncation signaling, tree-error propagation, invalid-request feedback ([#22](https://github.com/maxi-tools/maxi-reviewer/issues/22)) ([bf3cd9e](https://github.com/maxi-tools/maxi-reviewer/commit/bf3cd9eafdb38b9b03c0fcf89a10059529793d9d))
* **retrieval:** grep robustness follow-ups ([#22](https://github.com/maxi-tools/maxi-reviewer/issues/22)) ([0fa9927](https://github.com/maxi-tools/maxi-reviewer/commit/0fa9927548aca089b37e91b4122beea135b7d710))
* **review:** hold a block verdict to evidence the reader can check ([b9c4dd0](https://github.com/maxi-tools/maxi-reviewer/commit/b9c4dd0bdff0ef5a7ab1775c3afd27090e4a68a3))
* **review:** hold a block verdict to evidence the reader can check ([febcb3a](https://github.com/maxi-tools/maxi-reviewer/commit/febcb3a471992a8e54b84c1b30267c174af567fa))
* say how long the review waited and that it is not a finding ([f772893](https://github.com/maxi-tools/maxi-reviewer/commit/f772893df470bf0749e32ba6e916fad1166d3d63))
* say how long the review waited and that it is not a finding ([a80aec7](https://github.com/maxi-tools/maxi-reviewer/commit/a80aec7ffff892e4d375f75becf864603139d3ab))
* support multi-location / patch-shaped structured fixes ([#14](https://github.com/maxi-tools/maxi-reviewer/issues/14)) ([#24](https://github.com/maxi-tools/maxi-reviewer/issues/24)) ([059dc2a](https://github.com/maxi-tools/maxi-reviewer/commit/059dc2a42cb6a64a73cc4842f5b8103d85331ec4))


### Bug Fixes

* address Codex review on linked-issue grounding ([90ef6ee](https://github.com/maxi-tools/maxi-reviewer/commit/90ef6eec52dbc245a14d4508aa244aaf0aab0b75))
* beat from every poll phase and measure elapsed from review start ([a2729c5](https://github.com/maxi-tools/maxi-reviewer/commit/a2729c51e97110de844f705740e79e1578ca5ab5))
* bind each Sonar token to its step, scope the job-cap assertion, drop persisted credentials ([ed9b176](https://github.com/maxi-tools/maxi-reviewer/commit/ed9b1768757f981afafbd6e1e7d307722d644ff4))
* bound retrieval loop to a shared deadline; cache only genuine 404s; relax JSON-fence regex ([6b9e4af](https://github.com/maxi-tools/maxi-reviewer/commit/6b9e4afdcfb9a1ac8798627ddef10114de602706))
* **ci-signal:** async bounded file reads, GITHUB_RUN_ID self-exclusion, test cleanup, README docs ([2e50cba](https://github.com/maxi-tools/maxi-reviewer/commit/2e50cbaa936321e580c2362d8c24c9a211c70efd))
* **coverage:** set the thresholds to a ratchet the hook can actually pass ([d5cff93](https://github.com/maxi-tools/maxi-reviewer/commit/d5cff93665a73ff36ccfb6ab890523d4cc42ea8b))
* **coverage:** set the thresholds to a ratchet the hook can actually pass ([fb2fc50](https://github.com/maxi-tools/maxi-reviewer/commit/fb2fc5050e0b884202860ddc759596abf3f68db3))
* derive changed-file context from the truncated diff ([2fe3774](https://github.com/maxi-tools/maxi-reviewer/commit/2fe377416dd7d36810cd6ea847507efbaa23a230))
* drop the invalid pull_request_review_thread trigger ([1f880e2](https://github.com/maxi-tools/maxi-reviewer/commit/1f880e2ccbac258ec1ae0403fc2b96877666c3ac))
* fence excluded paths as untrusted; non-greedy diff path; filter generated from validation ([861dbd8](https://github.com/maxi-tools/maxi-reviewer/commit/861dbd89f93f8e484abf13d2ae74dc9895ed9bb3))
* give ci.yml a read-only token instead of the repository default ([4db1bfb](https://github.com/maxi-tools/maxi-reviewer/commit/4db1bfb5b521a7f4d4372b6e685b86ab4e4373ca))
* give ci.yml a read-only token instead of the repository default ([2e4a341](https://github.com/maxi-tools/maxi-reviewer/commit/2e4a34184b9a4644402e523399c6264516961912))
* give the job cap setup headroom and assert token scope structurally ([af36be0](https://github.com/maxi-tools/maxi-reviewer/commit/af36be0d502c28df86457e533ba4c43f50547973))
* honor post-transplant review on CI policy ([89842b0](https://github.com/maxi-tools/maxi-reviewer/commit/89842b02b89e2145e6cb60e2cf896dba26d662b2))
* let review-gate declare the permissions its job needs ([5f1cbea](https://github.com/maxi-tools/maxi-reviewer/commit/5f1cbeacb0a34468e672e0e61b7ca318c2144c01))
* let review-gate declare the permissions its job needs ([7cca835](https://github.com/maxi-tools/maxi-reviewer/commit/7cca835901f877656a0e9f127fd59260425c6db4))
* **lint:** drop the now-dead state initializer ([029e03a](https://github.com/maxi-tools/maxi-reviewer/commit/029e03a6e7a2abff4659de04eb6e27aeba877649))
* never watch a resumed session for stuck setup ([52dc165](https://github.com/maxi-tools/maxi-reviewer/commit/52dc165b9942b843cf960319415896c2f583e1f8))
* order linked-issue refs by position; drop duplicate body cap ([6b3e97a](https://github.com/maxi-tools/maxi-reviewer/commit/6b3e97ac611246c552cd8882c21005826ff07a25))
* post-transplant CI policy review feedback ([a8c1754](https://github.com/maxi-tools/maxi-reviewer/commit/a8c17545ca9b7e3dfdb608543e6322f1c86d8a2d))
* post-transplant review feedback ([#65](https://github.com/maxi-tools/maxi-reviewer/issues/65)) ([a8c1754](https://github.com/maxi-tools/maxi-reviewer/commit/a8c17545ca9b7e3dfdb608543e6322f1c86d8a2d))
* reconcile the two workflow policy suites on a sha-pinned setup-node ([74c4080](https://github.com/maxi-tools/maxi-reviewer/commit/74c40806e197d723392bbc036c07e8939a18a303))
* recreate Jules sessions that never leave repository setup ([c6dcc72](https://github.com/maxi-tools/maxi-reviewer/commit/c6dcc726ae8aeffc316ba1951b670db4c69ec0d5))
* recreate Jules sessions that never leave repository setup ([02b2833](https://github.com/maxi-tools/maxi-reviewer/commit/02b2833fe617fd5ec88f5a3ddbb2b09be5fd1642))
* **release-please:** open the release PR with an app token ([457274e](https://github.com/maxi-tools/maxi-reviewer/commit/457274ed17ebbc7db44866db59f571750d9ac154))
* **release-please:** open the release PR with an app token ([260c707](https://github.com/maxi-tools/maxi-reviewer/commit/260c7071681d78c93afd48690137b3f6d4b9bd25))
* report elapsed only, keep sawAgentOutput sticky, test the cap directly ([b4f67fe](https://github.com/maxi-tools/maxi-reviewer/commit/b4f67fe534bf70d6406e3af663d01215ddd50eb8))
* restore the 55m step bound and stop scoping SONAR_TOKEN job-wide ([573513c](https://github.com/maxi-tools/maxi-reviewer/commit/573513c39b3a0003c48bcc279b0ca1b9edd5f438))
* **retrieval:** reject catastrophic-backtracking grep patterns (ReDoS guard) ([e68b6e2](https://github.com/maxi-tools/maxi-reviewer/commit/e68b6e283469fd652b10421ec7ede4f7fadc16e7))
* **review-gate:** remove stale concurrency reference ([a11d513](https://github.com/maxi-tools/maxi-reviewer/commit/a11d5130416bd72602735d69e837cac882c2cc20))
* **review:** do not resume a hung Jules review session that produced no review ([1e4fd93](https://github.com/maxi-tools/maxi-reviewer/commit/1e4fd936d4d0fa31c616b668add821bea2250dac))
* **review:** do not resume a hung Jules session that produced no review ([b052889](https://github.com/maxi-tools/maxi-reviewer/commit/b052889218bd83e0b8265d5ad0f4453b3d24a734))
* **review:** downgrade only when every High finding declared memory ([1e05f9f](https://github.com/maxi-tools/maxi-reviewer/commit/1e05f9fb0ad21d792ffa59218eb0a0f66b6d671c))
* **review:** normalise unknown evidence labels inside the hold as well ([3814012](https://github.com/maxi-tools/maxi-reviewer/commit/38140125524125618f47e279ecaef3e97b6ce29c))
* stop an artifact storage outage from failing a completed review ([ae2700a](https://github.com/maxi-tools/maxi-reviewer/commit/ae2700a9171b4204bbd5416d17e90910ace4c128))
* stop ci.yml failing at startup and restore the step timeout it lost ([6ee8c27](https://github.com/maxi-tools/maxi-reviewer/commit/6ee8c275e2d244ed772ced1bd6c536367b1bf0b7))
* stop ci.yml failing at startup and restore the step timeout it lost ([a0e569b](https://github.com/maxi-tools/maxi-reviewer/commit/a0e569b8c0ea18dbe9ca031ecac477b9ab6ff8d6))

## [1.2.0](https://github.com/thalesraymond/jules-pr-reviewer/compare/v1.1.0...v1.2.0) (2026-06-15)


### Features

* dummy-commit ([f334a6f](https://github.com/thalesraymond/jules-pr-reviewer/commit/f334a6ff0da28f8272c28d6ca918d69e9e4da3a8))

## [1.1.0](https://github.com/thalesraymond/jules-pr-reviewer/compare/v1.0.0...v1.1.0) (2026-06-14)


### Features

* **comment:** avoid errors if jules dont respect json format ([f4e3c74](https://github.com/thalesraymond/jules-pr-reviewer/commit/f4e3c74e50e59f692fb7dba6109155b04951c869))
* invalid json check ([aeacfc5](https://github.com/thalesraymond/jules-pr-reviewer/commit/aeacfc57cc5de06bafb760fde84b45975319c02f))

## 1.0.0 (2026-06-14)


### Features

* add prompt for agents to feedback ([f9f88a2](https://github.com/thalesraymond/jules-pr-reviewer/commit/f9f88a2e57b1dbadd435d96e2c315eced3187a33))
* **jules:** add instructions for AI Agents on return from review ([cb72b3d](https://github.com/thalesraymond/jules-pr-reviewer/commit/cb72b3d1495254461eb859ca3a8e188b60de3958))
* **tests/ci:** setup unit tests / husky / git cz / release-please ([32c9857](https://github.com/thalesraymond/jules-pr-reviewer/commit/32c9857db2a9f779b0554ecc8f51bbeb431833ce))


### Bug Fixes

* **ci:** add checkout to self test ([b65eb20](https://github.com/thalesraymond/jules-pr-reviewer/commit/b65eb20ab4fe3fb7d95f333d1357b100fad632c7))
