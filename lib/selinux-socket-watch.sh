#!/bin/sh
# amneziawg-go watches its private UAPI socket for deletion. Some container
# policies omit sock_file:watch, causing the daemon to exit after creating TUN.
# Keep SELinux and MCS confinement; grant only watch, never extra socket access.
awg_easy_install_selinux_socket_watch() {
  command -v getenforce >/dev/null 2>&1 || return 0
  awg_selinux_mode=$(getenforce) || return 1
  [ "$awg_selinux_mode" != Disabled ] || return 0
  if ! command -v semodule >/dev/null 2>&1; then
    if command -v dnf >/dev/null 2>&1; then dnf install -y policycoreutils || return 1
    elif command -v yum >/dev/null 2>&1; then yum install -y policycoreutils || return 1
    elif command -v apt-get >/dev/null 2>&1; then apt-get install -y policycoreutils || return 1
    elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install policycoreutils || return 1
    else return 1
    fi
  fi
  awg_selinux_dir=$(mktemp -d /tmp/awg-easy-selinux.XXXXXX) || return 1
  printf '%s\n' '(allow container_t container_file_t (sock_file (watch)))' \
    > "$awg_selinux_dir/awg_easy_3_socket_watch.cil" \
    || { rmdir "$awg_selinux_dir"; return 1; }
  awg_selinux_status=0
  semodule -i "$awg_selinux_dir/awg_easy_3_socket_watch.cil" || awg_selinux_status=$?
  rm -f -- "$awg_selinux_dir/awg_easy_3_socket_watch.cil"
  rmdir "$awg_selinux_dir"
  return "$awg_selinux_status"
}
