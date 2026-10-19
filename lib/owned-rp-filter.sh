#!/bin/sh
# Configure only AWG-Easy-owned interface names. On RHEL-like hosts,
# systemd-sysctl applies a vendor *.rp_filter=1 rule to each new TUN device;
# Docker does not allow the unprivileged service container to override it.
awg_cells_install_rp_filter() {
  awg_rp_role=$1
  shift
  case "$awg_rp_role" in main|cell) ;; *) return 1 ;; esac
  [ "$#" -gt 0 ] || return 1
  [ ! -L /etc/sysctl.d ] || return 1
  install -d -m 0755 /etc/sysctl.d || return 1
  awg_rp_target="/etc/sysctl.d/99-awg-easy-3-${awg_rp_role}.conf"
  awg_rp_temporary=$(mktemp "/etc/sysctl.d/.awg-easy-3-${awg_rp_role}.XXXXXX") || return 1
  for awg_rp_interface do
    case "$awg_rp_interface" in ''|*[!A-Za-z0-9_.-]*) rm -f -- "$awg_rp_temporary"; return 1 ;; esac
    printf 'net.ipv4.conf.%s.rp_filter = 2\n' "$awg_rp_interface"
  done > "$awg_rp_temporary"
  chmod 0644 "$awg_rp_temporary" || { rm -f -- "$awg_rp_temporary"; return 1; }
  if [ -e "$awg_rp_target" ] || [ -L "$awg_rp_target" ]; then
    if [ ! -f "$awg_rp_target" ] || [ -L "$awg_rp_target" ] \
      || [ "$(stat -c %u "$awg_rp_target")" != 0 ] \
      || [ "$(stat -c %a "$awg_rp_target")" != 644 ] \
      || [ "$(stat -c %h "$awg_rp_target")" != 1 ] \
      || ! cmp -s "$awg_rp_temporary" "$awg_rp_target"; then
      rm -f -- "$awg_rp_temporary"
      return 1
    fi
  else
    ln "$awg_rp_temporary" "$awg_rp_target" || { rm -f -- "$awg_rp_temporary"; return 1; }
  fi
  rm -f -- "$awg_rp_temporary"
}
