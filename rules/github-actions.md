# GitHub Actions

- Prefer findings about token permissions, event safety, and supply-chain risk.
- Reject `pull_request_target` for workflows that read untrusted PR content and use write tokens.
- Check workflow permissions are least-privilege for the job.
- Flag unpinned or overly broad third-party actions in privileged workflows.
- Watch cache keys, artifact paths, and shell steps for secret exposure or unsafe input use.
