#!/bin/sh
# Called only after the caller has validated the private installation record.
awg_discovery_reserve_port() {
  awg_dht_file=$1
  awg_dht_key=$2
  shift 2
  case "$awg_dht_key" in AWG_MAIN_DHT_PORT|AWG_CELL_DHT_PORT) ;; *) return 1 ;; esac
  if grep -q "^${awg_dht_key}=" "$awg_dht_file"; then return 0; fi
  awg_dht_candidate=49033
  awg_dht_sockets=$(ss -H -uan) || return 1
  awg_dht_tcp=$(ss -H -ltn) || return 1
  awg_dht_ids=$(docker ps -q) || return 1
  awg_dht_published=''
  if [ -n "$awg_dht_ids" ]; then
    # IDs are Docker-generated hex tokens; this is intentional word splitting.
    awg_dht_published=$(docker inspect --format '{{range $port, $bindings := .NetworkSettings.Ports}}{{range $bindings}}{{printf "%s %s\n" $port .HostPort}}{{end}}{{end}}' $awg_dht_ids) || return 1
  fi
  while [ "$awg_dht_candidate" -le 60000 ]; do
    awg_dht_conflict=false
    for awg_dht_reserved do
      if [ "$awg_dht_reserved" = "$awg_dht_candidate" ]; then awg_dht_conflict=true; fi
    done
    if [ "$awg_dht_conflict" = false ] \
      && ! printf '%s\n' "$awg_dht_sockets" | grep -Eq ":${awg_dht_candidate}[[:space:]]" \
      && ! printf '%s\n' "$awg_dht_tcp" | grep -Eq ":${awg_dht_candidate}[[:space:]]" \
      && ! printf '%s\n' "$awg_dht_published" | awk -v port="$awg_dht_candidate" \
        '$1 ~ /\/(udp|tcp)$/ && $2 == port { found=1 } END { exit !found }'; then break; fi
    awg_dht_candidate=$((awg_dht_candidate + 1))
  done
  [ "$awg_dht_candidate" -le 60000 ] || return 1
  awg_dht_temporary=$(mktemp "${awg_dht_file}.XXXXXX") || return 1
  if cat "$awg_dht_file" > "$awg_dht_temporary" \
    && printf '%s=%s\n' "$awg_dht_key" "$awg_dht_candidate" >> "$awg_dht_temporary" \
    && chmod 0600 "$awg_dht_temporary" \
    && mv -f -- "$awg_dht_temporary" "$awg_dht_file"; then return 0; fi
  rm -f -- "$awg_dht_temporary"
  return 1
}
