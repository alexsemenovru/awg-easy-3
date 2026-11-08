#!/bin/sh
# Install after authenticated Cell registration. Paths and trust anchors stay
# outside the Cell bind mount; there is no embedded SSH or Docker credential.
awg_cell_install_maintenance() {
  install -d -m 0700 "$script_dir/.cell-maintenance" || return 1
  /bin/sh "$script_dir/cell-maintenance.sh" --init || return 1
  install -d -m 0755 /usr/local/libexec || return 1
  umask 077
  printf '%s\n' "$script_dir" > /etc/network-maintenance-dir || return 1
  cat > /usr/local/libexec/network-maintenance <<'EOF'
#!/bin/sh
set -eu
IFS= read -r directory < /etc/network-maintenance-dir
case "$directory" in /*) ;; *) exit 1 ;; esac
exec /bin/sh "$directory/cell-maintenance.sh"
EOF
  chmod 0755 /usr/local/libexec/network-maintenance || return 1
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    cat > /etc/systemd/system/network-maintenance.service <<'EOF'
[Unit]
Description=Maintain registered network service
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/libexec/network-maintenance
Nice=10
TimeoutStartSec=600
UMask=0077
EOF
    cat > /etc/systemd/system/network-maintenance.timer <<'EOF'
[Unit]
Description=Check registered network service maintenance requests
[Timer]
OnBootSec=15s
OnUnitInactiveSec=15s
Unit=network-maintenance.service
[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload && systemctl enable --now network-maintenance.timer
  elif command -v rc-service >/dev/null 2>&1; then
    cat > /usr/local/libexec/network-maintenance-loop <<'EOF'
#!/bin/sh
set -u
trap 'exit 0' TERM INT
while :; do
  /usr/local/libexec/network-maintenance || true
  sleep 15 & wait $! || true
done
EOF
    chmod 0755 /usr/local/libexec/network-maintenance-loop || return 1
    cat > /etc/init.d/network-maintenance <<'EOF'
#!/sbin/openrc-run
description="Maintain registered network service"
command="/usr/local/libexec/network-maintenance-loop"
command_background=true
pidfile="/run/network-maintenance.pid"
depend() { need docker; after net; }
EOF
    chmod 0755 /etc/init.d/network-maintenance || return 1
    rc-update add network-maintenance default && rc-service network-maintenance start
  else return 1
  fi
}
