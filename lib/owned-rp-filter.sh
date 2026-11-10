#!/bin/sh
# Configure only AWG-Easy-owned interface names. On RHEL-like hosts,
# systemd-sysctl applies a vendor *.rp_filter=1 rule to each new TUN device;
# Docker does not allow the unprivileged service container to override it.
awg_cells_apply_owned_sysctl() {
  for awg_rp_name do
    if [ -e "/proc/sys/net/ipv4/conf/$awg_rp_name/rp_filter" ]; then
      sysctl -w "net.ipv4.conf.$awg_rp_name.rp_filter=2" "net.ipv4.conf.$awg_rp_name.src_valid_mark=1" >/dev/null || return 1
    fi
  done
}

# Callers prove ownership of any already-existing names before this helper.
awg_cells_install_rp_filter() {
  awg_rp_role=$1
  shift
  case "$awg_rp_role" in main|cell|user) ;; *) return 1 ;; esac
  [ "$#" -gt 0 ] || return 1
  [ ! -L /etc/sysctl.d ] || return 1
  install -d -m 0755 /etc/sysctl.d || return 1
  awg_rp_target="/etc/sysctl.d/99-awg-easy-3-${awg_rp_role}.conf"
  awg_rp_temporary=$(mktemp "/etc/sysctl.d/.awg-easy-3-${awg_rp_role}.XXXXXX") || return 1
  for awg_rp_interface do
    case "$awg_rp_interface" in ''|*[!A-Za-z0-9_.-]*) rm -f -- "$awg_rp_temporary"; return 1 ;; esac
    printf 'net.ipv4.conf.%s.rp_filter = 2\nnet.ipv4.conf.%s.src_valid_mark = 1\n' "$awg_rp_interface" "$awg_rp_interface"
  done > "$awg_rp_temporary"
  chmod 0644 "$awg_rp_temporary" || { rm -f -- "$awg_rp_temporary"; return 1; }
  if [ -e "$awg_rp_target" ] || [ -L "$awg_rp_target" ]; then
    if [ ! -f "$awg_rp_target" ] || [ -L "$awg_rp_target" ] \
      || [ "$(stat -c %u "$awg_rp_target")" != 0 ] \
      || [ "$(stat -c %a "$awg_rp_target")" != 644 ] \
      || [ "$(stat -c %h "$awg_rp_target")" != 1 ]; then
      rm -f -- "$awg_rp_temporary"
      return 1
    fi
    if ! cmp -s "$awg_rp_temporary" "$awg_rp_target"; then
      # Migrate only the exact file written by the earlier installer. Any
      # locally edited or foreign sysctl file still requires inspection.
      awg_rp_legacy=$(mktemp "/etc/sysctl.d/.awg-easy-3-${awg_rp_role}-legacy.XXXXXX") \
        || { rm -f -- "$awg_rp_temporary"; return 1; }
      for awg_rp_interface do printf 'net.ipv4.conf.%s.rp_filter = 2\n' "$awg_rp_interface"; done > "$awg_rp_legacy"
      if cmp -s "$awg_rp_legacy" "$awg_rp_target"; then
        rm -f -- "$awg_rp_legacy"
        mv -f -- "$awg_rp_temporary" "$awg_rp_target" || return 1
        awg_cells_apply_owned_sysctl "$@"
        return $?
      fi
      case "$awg_rp_role" in
        main) printf 'net.ipv4.conf.%s.rp_filter = 2\n' awgmainb0 awgmainc0 > "$awg_rp_legacy" ;;
        cell) printf 'net.ipv4.conf.%s.rp_filter = 2\n' awgcellb0 awgcellc0 awgcellu0 > "$awg_rp_legacy" ;;
      esac
      if ! cmp -s "$awg_rp_legacy" "$awg_rp_target"; then
        rm -f -- "$awg_rp_legacy" "$awg_rp_temporary"
        return 1
      fi
      rm -f -- "$awg_rp_legacy"
      mv -f -- "$awg_rp_temporary" "$awg_rp_target" || return 1
      awg_cells_apply_owned_sysctl "$@"
      return $?
    fi
  else
    ln "$awg_rp_temporary" "$awg_rp_target" || { rm -f -- "$awg_rp_temporary"; return 1; }
  fi
  rm -f -- "$awg_rp_temporary"
  awg_cells_apply_owned_sysctl "$@"
}
