# Changelog

## [1.1.0](https://github.com/maxi-tools/maxi-reviewer/compare/v1.0.0...v1.1.0) (2026-07-24)


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
* **retrieval:** grep robustness — concurrent fetch, truncation signaling, tree-error propagation, invalid-request feedback ([#22](https://github.com/maxi-tools/maxi-reviewer/issues/22)) ([bf3cd9e](https://github.com/maxi-tools/maxi-reviewer/commit/bf3cd9eafdb38b9b03c0fcf89a10059529793d9d))
* **retrieval:** grep robustness follow-ups ([#22](https://github.com/maxi-tools/maxi-reviewer/issues/22)) ([0fa9927](https://github.com/maxi-tools/maxi-reviewer/commit/0fa9927548aca089b37e91b4122beea135b7d710))
* support multi-location / patch-shaped structured fixes ([#14](https://github.com/maxi-tools/maxi-reviewer/issues/14)) ([#24](https://github.com/maxi-tools/maxi-reviewer/issues/24)) ([059dc2a](https://github.com/maxi-tools/maxi-reviewer/commit/059dc2a42cb6a64a73cc4842f5b8103d85331ec4))


### Bug Fixes

* address Codex review on linked-issue grounding ([90ef6ee](https://github.com/maxi-tools/maxi-reviewer/commit/90ef6eec52dbc245a14d4508aa244aaf0aab0b75))
* bound retrieval loop to a shared deadline; cache only genuine 404s; relax JSON-fence regex ([6b9e4af](https://github.com/maxi-tools/maxi-reviewer/commit/6b9e4afdcfb9a1ac8798627ddef10114de602706))
* **ci-signal:** async bounded file reads, GITHUB_RUN_ID self-exclusion, test cleanup, README docs ([2e50cba](https://github.com/maxi-tools/maxi-reviewer/commit/2e50cbaa936321e580c2362d8c24c9a211c70efd))
* derive changed-file context from the truncated diff ([2fe3774](https://github.com/maxi-tools/maxi-reviewer/commit/2fe377416dd7d36810cd6ea847507efbaa23a230))
* fence excluded paths as untrusted; non-greedy diff path; filter generated from validation ([861dbd8](https://github.com/maxi-tools/maxi-reviewer/commit/861dbd89f93f8e484abf13d2ae74dc9895ed9bb3))
* order linked-issue refs by position; drop duplicate body cap ([6b3e97a](https://github.com/maxi-tools/maxi-reviewer/commit/6b3e97ac611246c552cd8882c21005826ff07a25))
* **retrieval:** reject catastrophic-backtracking grep patterns (ReDoS guard) ([e68b6e2](https://github.com/maxi-tools/maxi-reviewer/commit/e68b6e283469fd652b10421ec7ede4f7fadc16e7))
* **review:** do not resume a hung Jules review session that produced no review ([1e4fd93](https://github.com/maxi-tools/maxi-reviewer/commit/1e4fd936d4d0fa31c616b668add821bea2250dac))
* **review:** do not resume a hung Jules session that produced no review ([b052889](https://github.com/maxi-tools/maxi-reviewer/commit/b052889218bd83e0b8265d5ad0f4453b3d24a734))

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
