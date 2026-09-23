## What and why

<!-- What does this change, and what problem does it solve? Link the issue: Fixes #123 -->

## Tested on

- [ ] macOS
- [ ] Windows
- [ ] Linux

<!-- CI builds installers for every PR; download them from the run's summary to try the change. -->

## Checklist

- [ ] `npm run typecheck && npm run lint && npm test` pass in `desktop/`
- [ ] `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` pass in `desktop/src-tauri/`
- [ ] If detection changed: `cargo run --release --example evaluate` numbers are in the description
- [ ] If the UI changed: a screenshot is in the description
