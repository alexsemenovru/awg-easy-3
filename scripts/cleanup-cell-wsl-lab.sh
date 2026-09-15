#!/bin/sh
set -eu
# Accept only the exact disposable rootfs paths printed by the lab wrapper.
for target in "$@"; do
  case "$target" in /tmp/awg-cell-rootfs.??????) ;; *) echo 'Invalid lab path' >&2; exit 1;; esac
  test -d "$target" || continue
  test "$(readlink -f "$target")" = "$target" || exit 1
  if mountpoint -q "$target"; then echo 'Lab path is still mounted' >&2; exit 1; fi
  rm -rf -- "$target"
  echo "Removed disposable lab: $target"
done
