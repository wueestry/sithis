# Sithis

![](.github/assets/logo.png)

Sithis is a pentesting assistant built on the Pi SDK, with a repository-owned
terminal UI fork named [`sithis-tui`](packages/sithis-tui/FORK.md).

## Install and run

Requires Node.js 22.19.0 or newer, and npm on PATH.

```sh
npm run setup
sithis
```

The installer restores the locked SDK and extension dependencies, builds the
local TUI, resolves Pi resources through the SDK package manager, and installs
`sithis` and the existing `pi` compatibility launcher. Both start
[`apps/sithis/main.mjs`](apps/sithis/main.mjs); neither invokes Pi's CLI entrypoint.
Use `npm run setup -- --no-links` to build without changing PATH entrypoints. Paths
are configured in `agent/install/managed-install.json`.

Existing `agent/settings.json`, credentials, models, conversations and assessment
data are reused. Old ignored `agent/install/releases` directories are left in
place for rollback but are no longer loaded. The SDK itself shares an npm
package with the Pi CLI; only its SDK and interactive UI exports are used here.

```sh
sithis --help
sithis --doctor         # Verify SDK and local TUI resolution
sithis --check          # Check settings/resources without a model request
sithis --continue       # Continue the latest conversation in this workspace
sithis --print "..."    # Single-shot model request
```

The SDK host supports interactive, text, JSON and RPC modes. Its startup flags
are listed by `--help`; it does not forward arbitrary legacy Pi CLI options.
Project-local resources require saved project trust or explicit
`--trust-project`. User-level packages in `agent/settings.json` remain enabled.
`--offline` suppresses startup catalog/update requests; it does not disable
model requests or target tools you invoke.

## Engagements

Enter `/engagement` to open the menu, or `/engagement new` to start the wizard.
The wizard retries invalid fields without losing earlier answers and shows a
scope summary before saving. Escape cancels without creating partial state.
The request-budget prompt accepts a number, or blank/`0`/`none` for no limit;
the total and per-host caps default to 100 and 30 when keys are omitted from a
scope file. The selected engagement is shown in the footer. With an engagement selected,
`/engagement` opens a dashboard showing time remaining, request budget, finding
states, and recorded coverage. Its menu opens pending findings, coverage gaps,
automatic fix retesting, and reports. `/engagement status` prints the dashboard;
`/engagement pending` and `/engagement coverage` show details. Coverage counts
represent recorded checks, not a percentage of the application tested.

Choose **Delete engagement** to remove the selected engagement and its artifacts
after confirmation. Choose **Verify pending findings** to review a request plan
and run supported checks sequentially. Escape pauses verification; reopening the
action resumes unfinished work without repeating completed checks. These actions
are also available as `/engagement delete` and `/engagement verify-pending`.

File-based setup and existing text commands remain available:

```text
/engagement new demo @scope.json
/engagement resume demo
/engagement status
/engagement report
/engagement leave
```

The [assessment package guide](packages/sithis/README.md) covers scope files,
scoped HTTP probes, evidence, verification, coverage, replay and fix retesting.
Assessment data lives outside this checkout by default. Engagement selection is
restored with persisted conversation history; a setup-only SDK session is not
saved until it contains a user or assistant message. The engagement itself is
saved immediately and remains available under `/engagement list`.

## Architecture and development

- `apps/sithis`: SDK startup, runtime lifecycle, CLI options and resource installer.
- `packages/sithis-tui`: local UI source, native helper sources, and upstream tests.
- `packages/pi-tui-compat`: export-only bridge for the upstream SDK's old TUI import name.
- `packages/sithis`: engagement storage, tools, operator commands and specialists.
- `agent`: existing settings, extension dependency lockfile, credentials and conversations.

Both the SDK and application resolve the same `sithis-tui` classes. Customize
that package and rebuild; do not edit installed files in `node_modules`.

```sh
npm ci
npm ci --prefix agent/npm --omit=dev
npm run build
npm test
npm run typecheck
npm run test:tui
npm run demo --prefix packages/sithis
```

SDK and TUI versions are pinned in the root lockfile. Extension versions and
their separate lockfile are tracked under `agent/npm`.
