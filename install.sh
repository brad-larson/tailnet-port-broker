#!/bin/sh
# Install `ports` on this machine, and optionally the refuse-to-clobber
# `tailscale` shim.
#
#   ./install.sh                 ports → a bin directory already on PATH
#   ./install.sh --shim          also write the shim to ~/.local/share/tailnet-ports/shim
#   ./install.sh --bin DIR       choose where `ports` goes
#
# Nothing here edits a shell profile. The shim only works once its directory is
# ahead of the real tailscale on PATH; the line to add is printed at the end.
set -eu

repo=$(cd "$(dirname "$0")" && pwd)
bin=""
shim=0
while [ $# -gt 0 ]; do
  case "$1" in
    --shim) shim=1 ;;
    --bin) bin="$2"; shift ;;
    *) echo "usage: $0 [--shim] [--bin DIR]" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$bin" ]; then
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
    if [ -d "$d" ] && [ -w "$d" ]; then bin=$d; break; fi
  done
fi
[ -n "$bin" ] || { echo "no writable bin directory found; pass --bin DIR" >&2; exit 1; }

# node's absolute path, taken now. A version manager (asdf, mise) often puts
# node on PATH only from ~/.zshrc, so a shell that never reads it — `zsh -c`,
# launchd, a script's child — has none. Found on brad-dev 2026-09-26, where the
# shim then fell back to the real CLI unguarded and a test serve replaced a
# live route. The baked path goes stale when node is upgraded, so PATH is the
# fallback, and re-running this script refreshes it.
node_bin=$(node -p process.execPath 2>/dev/null || true)
[ -n "$node_bin" ] || { echo "node not found on PATH; install it (>= 20) first" >&2; exit 1; }
find_node="NODE='$node_bin'; [ -x \"\$NODE\" ] || NODE=\$(command -v node) || NODE=''"

# A shell wrapper, not a symlink to the .mjs, for the same reason: the .mjs's
# `#!/usr/bin/env node` fails outright wherever node is not on PATH.
rm -f "$bin/ports"
cat > "$bin/ports" <<EOF
#!/bin/sh
# Written by $repo/install.sh
$find_node
[ -n "\$NODE" ] || { echo "ports: node not found (re-run $repo/install.sh)" >&2; exit 1; }
exec "\$NODE" '$repo/bin/ports.mjs' "\$@"
EOF
chmod +x "$bin/ports"
echo "ports → $bin/ports (node $node_bin)"

if [ "$shim" = 1 ]; then
  shimdir="$HOME/.local/share/tailnet-ports/shim"
  real=""
  # The real CLI: the first `tailscale` on PATH that is not a previous shim.
  IFS=:
  for d in $PATH; do
    if [ "$d" != "$shimdir" ] && [ -x "$d/tailscale" ]; then real="$d/tailscale"; break; fi
  done
  unset IFS
  [ -n "$real" ] || { [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && real=/Applications/Tailscale.app/Contents/MacOS/Tailscale; }
  [ -n "$real" ] || { echo "no tailscale CLI found on PATH" >&2; exit 1; }

  mkdir -p "$shimdir"
  # When node cannot be found at all it runs the real CLI instead of failing —
  # the shim must never be the reason tailscale broke — but says so, because a
  # silent fallback is a guard that is off while reading as on.
  cat > "$shimdir/tailscale" <<EOF
#!/bin/sh
# Written by $repo/install.sh — refuses tailscale serve commands that would
# take a port from another project. TAILNET_PORTS_FORCE=1 bypasses it.
REAL='$real'
$find_node
if [ -z "\$NODE" ]; then
  echo "tailscale (ports shim): node not found — running the real CLI UNGUARDED (re-run $repo/install.sh)" >&2
  exec "\$REAL" "\$@"
fi
TAILSCALE_BIN="\$REAL" exec "\$NODE" '$repo/bin/tailscale.mjs' "\$@"
EOF
  chmod +x "$shimdir/tailscale"
  echo "shim  → $shimdir/tailscale (wrapping $real)"
  case ":$PATH:" in
    *":$shimdir:"*) echo "shim directory is already on PATH" ;;
    *)
      echo
      echo "Put the shim ahead of the real CLI. Add this line to ~/.zshenv, ~/.zprofile AND the end of ~/.zshrc"
      echo "(path_helper and version managers each reorder PATH after .zshenv — README, Install):"
      echo "  export PATH=\"\$HOME/.local/share/tailnet-ports/shim:\$PATH\""
      ;;
  esac
fi
