#!/usr/bin/env bash
#
# What a host runs to start this module: no arguments, foreground, `exec`.
#
#   - No arguments, because a registration names a directory and this script,
#     never a command line a host would hand to a shell.
#   - No port here. It is PREFERRED_PORT in manifest.ts, and `serves()` in
#     vite.config.ts acts on it: takes it when free, honours $PORT from a host,
#     and moves (rewriting the registration) when something else has it.
#   - `exec` in the foreground, so the pid a host holds is the one that stops it.
#
# A first start registers this folder with Kehikot on this computer when
# nothing else is registered under the id (`serves()`); `bun run stub` never does.
set -euo pipefail
cd "$(dirname "$0")"

# Install when nothing is installed, AND whenever bun.lock or package.json is
# newer than the last install here — the same rule as the host's own run.sh. A
# pull that moves the protocol pin leaves the old package in node_modules, and
# a page that imports a name the old package does not have draws nothing.
# `--frozen-lockfile`, so a start installs exactly what bun.lock says and never
# rewrites it behind somebody's back. The stamp is written only after an
# install that succeeded.
INSTALLED=node_modules/.kehikot-installed
VITE_FORCE=
if [ ! -d node_modules ] || [ ! -f "$INSTALLED" ] || [ bun.lock -nt "$INSTALLED" ] || [ package.json -nt "$INSTALLED" ]; then
  echo "installing…" >&2
  if [ -f bun.lock ]; then
    bun install --frozen-lockfile >&2 || { echo "bun install --frozen-lockfile failed: bun.lock does not match package.json. Run \`bun install\` and commit bun.lock." >&2; exit 1; }
  else
    bun install >&2
  fi
  touch "$INSTALLED"
  # Rebuild Vite's pre-bundle rather than trust one made from the old packages.
  VITE_FORCE=--force
fi

exec bunx vite $VITE_FORCE
