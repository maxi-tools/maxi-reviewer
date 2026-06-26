# Go

- Prefer findings about error handling, concurrency, and external input.
- Flag ignored errors unless the reason is explicit and harmless.
- Check goroutines for cancellation, leaks, and blocked sends or receives.
- Watch pointer aliasing, loop variable capture, and nil map or slice assumptions.
- For HTTP or CLI code, verify timeouts, context use, and path validation.
