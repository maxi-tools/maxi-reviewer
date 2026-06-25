# JavaScript

- Prefer findings about runtime behavior, data safety, and user-visible breakage over style.
- Flag unhandled promises and callbacks that can fail silently.
- Check input parsing, object shape assumptions, and trust boundaries before values reach I/O.
- For browser code, watch for stale event listeners, unsafe DOM injection, and state mutation.
- For Node code, check path handling, subprocess use, and network error paths.
