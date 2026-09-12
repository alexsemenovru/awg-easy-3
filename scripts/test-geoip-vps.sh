#!/usr/bin/env bash
# Preflight on a disposable Linux VPS. Does not install/restart the panel.
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
image=${1:-ghcr.io/alexsemenovru/awg-easy-3:0.1.5@sha256:de9ce4771159c0ae94f6aa418f9814a23495b4899f8f0fb6d5447609e57bc86e}
archive=${2:-}
[[ $(id -u) = 0 ]] || { echo 'Run as root on the disposable test VPS' >&2; exit 1; }
[[ -f "$archive" ]] || { echo 'Usage: bash scripts/test-geoip-vps.sh IMAGE PUBLIC_DBIP_ARCHIVE' >&2; exit 1; }
archive=$(realpath -- "$archive")
for tool in docker unshare python3 nft ip; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }
done
[[ -c /dev/net/tun ]] || { echo 'Missing /dev/net/tun' >&2; exit 1; }
docker image inspect "$image" >/dev/null

echo '1/3: synthetic packet matrix in a separate network namespace'
docker run --rm --network none --memory 512m \
  -v "$project_dir/src:/candidate:ro" --entrypoint node "$image" \
  /candidate/test/helpers/ip-family-policies.js |
  unshare --net python3 "$project_dir/src/test/helpers/verify-ip-families-linux.py"

echo '2/3: complete archive and country sets in a separate network namespace'
docker run --rm --network none --memory 512m \
  -v "$project_dir/src:/candidate:ro" -v "$archive:/db.csv.gz:ro" \
  --entrypoint node "$image" /candidate/test/helpers/verify-full-geoip.js /db.csv.gz |
  unshare --net python3 "$project_dir/src/test/helpers/verify-full-geoip-linux.py"

echo '3/3: real updater download and disposable cache lifecycle'
docker run --rm --memory 512m -v "$project_dir/src:/candidate:ro" \
  --entrypoint node "$image" /candidate/test/helpers/verify-geoip-updater-live.js /tmp/geo-cache
echo 'PASS preflight. Real VPN, restart and container rollback checks remain separate.'
