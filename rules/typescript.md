# TypeScript

- Prefer findings about runtime behavior over style.
- Flag floating promises unless the call is intentionally detached and marked with `void`.
- Flag `any` and unchecked casts at trust boundaries.
- Flag unsafe `JSON.parse` use when the parsed value is used as a typed object without validation.
- For React changes, check effect dependencies, stable keys, and state mutation.
