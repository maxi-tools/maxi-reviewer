# Python

- Prefer findings that can produce incorrect behavior, data loss, or unsafe I/O.
- Flag broad exception handling that hides failures or changes control flow unexpectedly.
- Check subprocess, file path, deserialization, and network calls for untrusted input.
- Watch for mutable default arguments and shared state across requests or tests.
- For async code, check missed awaits and blocking work inside event loops.
