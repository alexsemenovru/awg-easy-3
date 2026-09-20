#!/bin/sh
set -eu
# Called as root under unshare --mount --net --pid --fork --kill-child.
# No host network changes, services, Docker daemon or browser profile access.
if test "$(readlink /proc/self/ns/net)" = "$(readlink /proc/1/ns/net)"; then
  echo 'Refusing to run without isolated network namespace' >&2
  exit 1
fi
mount --make-rprivate /
layers_dir=$1
workspace=$2
lab_root=$(mktemp -d /tmp/awg-cell-rootfs.XXXXXX)
echo "Disposable rootfs: $lab_root"
python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["layers"]))' "$layers_dir/layers.json" |
while IFS= read -r layer; do
  case "$layer" in *[!a-f0-9.tar.gz]*|*/*) exit 1;; esac
  tar -xzf "$layers_dir/$layer" -C "$lab_root"
done
mount --bind "$lab_root" "$lab_root"
mkdir -p "$lab_root/workspace" "$lab_root/proc" "$lab_root/dev/net" "$lab_root/tmp"
mount --bind "$workspace" "$lab_root/workspace"
mount -o remount,bind,ro "$lab_root/workspace"
mount -t proc proc "$lab_root/proc"
ln -s /proc/self/fd "$lab_root/dev/fd"
ln -s /proc/self/fd/0 "$lab_root/dev/stdin"
ln -s /proc/self/fd/1 "$lab_root/dev/stdout"
ln -s /proc/self/fd/2 "$lab_root/dev/stderr"
mknod -m 666 "$lab_root/dev/null" c 1 3
mount --bind /dev/net/tun "$lab_root/dev/net/tun" 2>/dev/null || {
  touch "$lab_root/dev/net/tun"
  mount --bind /dev/net/tun "$lab_root/dev/net/tun"
}
export WG_QUICK_USERSPACE_IMPLEMENTATION=amneziawg-go
export AWG_CELL_ISOLATED_TEST=1
export NODE_PATH=/app/node_modules
case "${3:-runtime}" in
  runtime) test_script=test-cell-runtime.cjs ;;
  routing) test_script=test-cell-routing.cjs ;;
  nft) test_script=test-cell-nft.cjs ;;
  policy-json) test_script=test-cell-policy-json.cjs ;;
  awg-snapshot) test_script=test-cell-awg-snapshot.cjs ;;
  awg-lifecycle) test_script=test-cell-awg-lifecycle.cjs ;;
  *) echo 'Unknown isolated test suite' >&2; exit 1 ;;
esac
chroot "$lab_root" /usr/local/bin/node "/workspace/scripts/$test_script"
# PID namespace exit kills remaining test processes; mounts disappear automatically.
# Rootfs retained for diagnosis, exact path printed above. No broad recursive cleanup.
