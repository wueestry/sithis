# SDK compatibility bridge

The pinned upstream SDK imports `@earendil-works/pi-tui`. This private workspace
re-exports `sithis-tui`, including its TypeScript declarations, so the SDK uses
our local fork without patching SDK internals or loading a second TUI copy.
All implementation changes belong in `packages/sithis-tui`.
