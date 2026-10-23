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
