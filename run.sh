#!/usr/bin/env bash
#
# What a host runs to start this module: no arguments, foreground, `exec`. No port here: it is
# PREFERRED_PORT in manifest.ts, and `serves()` / `run()` act on it and honour $PORT from a host.
# The built page (`bun run build`, which a host runs at install and update) when its stamp is this
# checkout's commit; Vite otherwise. A stale build is never served.
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

# The built page, when its stamp is this checkout's HEAD (`bun run build`, which a
# host runs at install and update, never at start). Read here, in the shell, so
# choosing costs a `git rev-parse` and not a process. A checkout somebody edits
# has no stamp, or one of an older commit, and gets Vite; a stale build is never
# served (`serve.ts` refuses one too, with a 503 that says why).
BUILT=
if [ -f dist/.kehikot-built ] && [ -f dist/index.html ]; then
  read -r BUILT < dist/.kehikot-built || true
fi
if [ -n "$BUILT" ] && [ "$BUILT" = "$(git rev-parse HEAD 2>/dev/null)" ]; then
  exec bun run serve.ts
fi
if [ -n "$BUILT" ]; then
  echo "queue: dist/ is a build of ${BUILT:0:7}, not of this checkout, so Vite serves the page. \`bun run build\` would make it current." >&2
fi

exec bunx vite $VITE_FORCE
