# Sithis TUI fork

Package name: `sithis-tui` (private workspace). Its source, tests, and native
integration sources are maintained in this repository. Build output is generated
with `npm run build` at the repository root.

Forked from https://github.com/earendil-works/pi/tree/v1.4.0/packages/tui at
commit `4a080252f06caf63a525d7873c5d94d3c23887e0` (MIT; see LICENSE).
Upstream README and CHANGELOG are retained as upstream reference material.

Local changes:

- Renamed the package and internal package identifiers to `sithis-tui`.
- Added `SithisHeader` for the Sithis application's header.
- Standalone workspace build with a repository-owned compiler and lockfile.
- Added a TypeScript test loader and pipe-flush handling for portable test execution.
- Removed upstream publish and monorepo cleanup hooks; this fork is private.

The private `packages/pi-tui-compat` workspace retains the old package name only
as an SDK import bridge. It contains no UI implementation: all exports come from
`sithis-tui`. Sithis checks that the SDK and host resolve the same local classes.
Its 1.4.0 compatibility version satisfies the pinned SDK's dependency contract.

Native clipboard sources are included. Native prebuilds are not vendored; the
library's normal platform fallbacks remain available. Build native clipboard
support explicitly with the platform-specific build scripts if required.
