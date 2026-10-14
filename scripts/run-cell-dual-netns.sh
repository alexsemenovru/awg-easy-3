#!/bin/sh
# Disposable Linux lab. All network devices, routes, nft tables, sockets and
# synthetic credentials stay inside namespaces/tmpfs, never the host network.
set -eu

[ "$(id -u)" -eq 0 ] || { echo 'Root required for isolated network namespaces' >&2; exit 1; }
for tool in unshare mount ip nft node awg amneziawg-go; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing lab tool: $tool" >&2; exit 1; }
done
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

exec unshare --mount --net --pid --fork --kill-child /bin/sh -eu -c '
  mount --make-rprivate /
  mount -t tmpfs tmpfs /tmp
  mkdir -p /run/netns /run/wireguard
  mount -t tmpfs tmpfs /run/netns
  mount -t tmpfs tmpfs /run/wireguard
  AWG_CELL_ISOLATED_TEST=1 node "$1/scripts/test-cell-dual-netns.cjs"
' lab "$repo"
