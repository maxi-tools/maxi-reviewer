# Rust

- Prefer findings about panics, data corruption, and incorrect ownership assumptions.
- Flag `unwrap`, `expect`, and indexing when reachable from normal user input or external data.
- Check unsafe blocks for documented invariants and narrow scope.
- Watch error conversion paths so important context is not discarded.
- For concurrent code, check lock ordering, cancellation, and channel shutdown behavior.
