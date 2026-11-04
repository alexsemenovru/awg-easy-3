#!/bin/sh
# Our nft hooks enforce client policy before firewalld's later hooks. Permit
# transit only on explicitly reserved AWG interfaces, keeping WAN in its zone.
awg_easy_configure_firewalld() {
  [ "$#" -ge 3 ] || return 1
  awg_fw_wan=$1
  awg_fw_ports=$2
  shift 2
  case "$awg_fw_wan" in ''|lo|*[!A-Za-z0-9_.-]*) return 1 ;; esac
  [ "${#awg_fw_wan}" -le 15 ] && [ -n "$awg_fw_ports" ] || return 1
  for awg_fw_name do
    case "$awg_fw_name" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
    [ "${#awg_fw_name}" -le 15 ] || return 1
    [ "$awg_fw_name" != "$awg_fw_wan" ] && [ "$awg_fw_name" != lo ] || return 1
  done
  for awg_fw_port in $awg_fw_ports; do
    case "$awg_fw_port" in ''|*[!0-9]*) return 1 ;; esac
    [ "$awg_fw_port" -ge 1 ] && [ "$awg_fw_port" -le 65535 ] || return 1
  done
  command -v firewall-cmd >/dev/null 2>&1 || return 0
  firewall-cmd --state >/dev/null 2>&1 || return 0
  awg_fw_zone=$(firewall-cmd --get-zone-of-interface="$awg_fw_wan" 2>/dev/null) || awg_fw_zone=
  case "$awg_fw_zone" in ''|'no zone') awg_fw_zone=$(firewall-cmd --get-default-zone) || return 1 ;; esac
  case "$awg_fw_zone" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  # Refuse to reassign an interface already explicitly managed by another zone.
  for awg_fw_name do
    awg_fw_existing=$(firewall-cmd --get-zone-of-interface="$awg_fw_name" 2>/dev/null) || awg_fw_existing=
    case "$awg_fw_existing" in ''|'no zone'|trusted) ;; *) return 1 ;; esac
  done
  # Build arguments from validated tokens; never eval a command or reload all
  # firewalld configuration (a reload could discard unrelated runtime rules).
  awg_fw_interfaces="$*"
  set -- --zone=trusted
  for awg_fw_name in $awg_fw_interfaces; do set -- "$@" "--add-interface=$awg_fw_name"; done
  firewall-cmd --permanent "$@" >/dev/null || return 1
  firewall-cmd "$@" >/dev/null || return 1
  set -- "--zone=$awg_fw_zone"
  for awg_fw_port in $awg_fw_ports; do set -- "$@" "--add-port=$awg_fw_port/udp"; done
  firewall-cmd --permanent "$@" >/dev/null || return 1
  firewall-cmd "$@" >/dev/null || return 1
}
