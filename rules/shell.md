# Shell

- Prefer findings about quoting, error handling, and destructive commands.
- Flag unquoted variables that can split paths, globs, or user-controlled values.
- Check `set -e` assumptions around pipelines, subshells, and conditionals.
- Watch command substitutions, temp files, and cleanup paths for races or leaks.
- For CI scripts, verify secrets are not echoed and failures stop the workflow.
