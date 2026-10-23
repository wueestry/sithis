#!/usr/bin/env python3
"""Install the pinned Pi release and link its managed launcher."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parent
    install_root = root / "agent/install"
    package_name = "@earendil-works/pi-coding-agent"

    node_version = subprocess.check_output(["node", "--version"], text=True).strip()
    if tuple(map(int, node_version.lstrip("v").split("."))) < (22, 19, 0):
        raise ValueError("Node.js 22.19.0 or newer is required.")

    version = (install_root / "current-version").read_text().strip()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
        raise ValueError("agent/install/current-version must contain an exact version.")

    config = json.loads((install_root / "managed-install.json").read_text())
    entry = config.get("entrypoint", {})
    if (config.get("kind") != "pi-managed-install"
            or config.get("schemaVersion") != 1
            or config.get("layout") != "releases-v1"
            or entry.get("type") != "symlink"
            or not isinstance(entry.get("path"), str)
            or not Path(entry["path"]).is_absolute()):
        raise ValueError("Unsupported managed-install.json configuration.")
    entrypoint = Path(entry["path"])
    launcher = root / "agent/bin/pi"
    if not os.access(launcher, os.X_OK):
        raise ValueError(f"Launcher is missing or not executable: {launcher}")
    check_entrypoint(entrypoint)

    release = install_root / "releases" / version
    release.mkdir(parents=True, exist_ok=True)
    manifest = release / "package.json"
    if manifest.exists():
        package = json.loads(manifest.read_text())
        if package.get("dependencies", {}).get(package_name) != version:
            raise ValueError(f"{manifest} does not pin {package_name} to {version}.")
    else:
        with manifest.open("x") as file:
            json.dump({
                "name": "@earendil-works/pi-coding-agent-install",
                "version": version,
                "private": True,
                "dependencies": {package_name: version},
                "engines": {"node": ">=22.19.0"},
            }, file, indent=2)
            file.write("\n")

    command = "ci" if (release / "package-lock.json").exists() else "install"
    print(f"Installing Pi {version} in {release}", flush=True)
    subprocess.run(
        ["npm", command, "--omit=dev", "--no-audit", "--no-fund", "--engine-strict"],
        cwd=release, check=True,
    )
    binary = release / "node_modules/.bin/pi"
    if not os.access(binary, os.X_OK):
        raise ValueError(f"Installed Pi executable is missing or not executable: {binary}")

    entrypoint.parent.mkdir(parents=True, exist_ok=True)
    check_entrypoint(entrypoint)
    if entrypoint.is_symlink():
        target = entrypoint.parent / os.readlink(entrypoint)
        if Path(os.path.abspath(target)) == launcher:
            print(f"Pi {version} is ready: {entrypoint}")
            return
        entrypoint.unlink()
    entrypoint.symlink_to(launcher)
    print(f"Pi {version} is ready: {entrypoint}")


def check_entrypoint(entrypoint):
    if os.path.lexists(entrypoint) and not entrypoint.is_symlink():
        raise ValueError(f"Refusing to replace a non-symlink: {entrypoint}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"Install failed: {error}", file=sys.stderr)
        sys.exit(1)
