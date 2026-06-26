# Sentinel Log

## 2026-06-18
- **Vulnerability/Learning/Prevention**: Fixed a Comment Spoofing vulnerability via String Includes in `fetchOpenThreads` where an attacker could spoof Jules's inline comments by creating a normal comment with the HTML string `<!-- jules-inline-comment -->`. Mitigated by asserting `viewerDidAuthor` in the GraphQL pull request review thread comments node to reliably authenticate that the bot specifically authored the comment.
