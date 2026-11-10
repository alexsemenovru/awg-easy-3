#!/bin/sh
# Validate only local interface addresses. No remote discovery or shell eval.
awg_validate_egress_ipv4() {
  [ -z "$1" ] && return 0
  printf '%s\n' "$1" | awk -F. '
    NF != 4 { exit 1 }
    { for(i=1;i<=4;i++) if($i !~ /^(0|[1-9][0-9]*)$/ || $i>255) exit 1 }
    $1 == 0 || $1 == 127 || $1 >= 224 { exit 1 }
  ' || return 1
  awg_egress_route=$(ip -4 route get 1.1.1.1 from "$1" 2>/dev/null) || return 1
  awg_egress_wan=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="dev"){print $(i+1);exit}}')
  [ -n "$awg_egress_wan" ] || return 1
  printf '%s\n' "$awg_egress_route" | awk -v dev="$awg_egress_wan" '{for(i=1;i<=NF;i++)if($i=="dev" && $(i+1)==dev)ok=1} END{exit !ok}' || return 1
  ip -o -4 addr show dev "$awg_egress_wan" scope global | awk -v address="$1" '
    { split($4,a,"/"); if(a[1]==address)ok=1 } END{exit !ok}'
}

awg_choose_egress_ipv4() {
  if [ -z "$AWG_EGRESS_IPV4_VALUE" ] && [ -t 0 ]; then
    awg_egress_wan=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="dev"){print $(i+1);exit}}')
    awg_egress_addresses=$(ip -o -4 addr show dev "$awg_egress_wan" scope global | awk '{split($4,a,"/");print a[1]}')
    if [ "$(printf '%s\n' "$awg_egress_addresses" | awk 'NF{n++}END{print n+0}')" -gt 1 ]; then
      message 'Outgoing VPN IPv4 [Enter = automatic]: ' >&2
      printf '\n%s\n' "$awg_egress_addresses" >&2
      read -r AWG_EGRESS_IPV4_VALUE || return 1
    fi
  fi
  awg_validate_egress_ipv4 "$AWG_EGRESS_IPV4_VALUE"
}
