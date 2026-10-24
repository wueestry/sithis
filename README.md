# Sithis

![](.github/assets/logo.png)

Sithis is a AI Penetration Testing Tool based on the Pi Agent Harness

Run `./install.py` with Python 3, Node.js 22.19.0 or newer, and npm available on your
PATH. It installs the version pinned in `agent/install/current-version` under
`agent/install/releases/<version>` and links `agent/bin/pi` at the entrypoint
specified in `agent/install/managed-install.json`. Existing release lockfiles
are used with `npm ci`; new releases get an exact-version dependency and lockfile.
Packages listed in `agent/settings.json` are then installed using Pi's package
manager into this checkout's agent directory (including entries with resource filters).

## Web/API assessment workflow

The versioned [Sithis Pi package](packages/sithis/README.md) adds persistent
engagements, six specialists, scoped HTTP probes, evidence, verification,
coverage, replay and fix retesting. Restart Pi to load it, then use
`/engagement resume <id>`. Run `npm test --prefix packages/sithis` for regression
tests or `npm run demo --prefix packages/sithis` for the local end-to-end demo.

Extension versions and their npm lockfile are tracked alongside the pinned Pi
core. Assessment data lives outside this checkout by default.
