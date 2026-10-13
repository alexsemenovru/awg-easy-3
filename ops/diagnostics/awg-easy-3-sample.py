#!/usr/bin/env python3
"""Small, key-free runtime sampler for an AWG-Easy 3 Docker installation."""

import datetime as dt
import json
import os
import subprocess


CONTAINER = "awg-easy-3"
INTERFACE = "awg0"
LOG_PATH = "/var/log/awg-easy-3-diagnostics/samples.jsonl"


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=12, check=True)
    return result.stdout.strip()


def udp_counters():
    with open("/proc/net/snmp", encoding="ascii") as stream:
        lines = [line.split() for line in stream if line.startswith("Udp:")]
    if len(lines) != 2 or len(lines[0]) != len(lines[1]):
        raise ValueError("UDP counters unavailable")
    counters = dict(zip(lines[0][1:], lines[1][1:]))
    return {name: int(counters[name]) for name in (
        "InDatagrams", "OutDatagrams", "InErrors", "NoPorts",
        "RcvbufErrors", "SndbufErrors",
    )}


def handshake_counters(now):
    output = command("docker", "exec", CONTAINER, "awg", "show", INTERFACE, "latest-handshakes")
    ages = []
    for line in output.splitlines():
        fields = line.split("\t")
        if len(fields) != 2:
            raise ValueError("unexpected handshake format")
        timestamp = int(fields[1])
        if timestamp > 0:
            ages.append(max(0, now - timestamp))
    return {
        "peers": len(output.splitlines()),
        "never": len(output.splitlines()) - len(ages),
        "age_le_180s": sum(age <= 180 for age in ages),
        "age_le_600s": sum(age <= 600 for age in ages),
        "newest_age_s": min(ages) if ages else None,
    }


def transfer_counters():
    output = command("docker", "exec", CONTAINER, "awg", "show", INTERFACE, "transfer")
    received = sent = 0
    for line in output.splitlines():
        fields = line.split("\t")
        if len(fields) != 3:
            raise ValueError("unexpected transfer format")
        received += int(fields[1])
        sent += int(fields[2])
    return {"rx_bytes": received, "tx_bytes": sent}


def link_counters(interface):
    link = json.loads(command("ip", "-j", "-s", "link", "show", "dev", interface))[0]
    stats = link["stats64"]
    return {
        "rx_packets": stats["rx"]["packets"],
        "rx_errors": stats["rx"]["errors"],
        "rx_dropped": stats["rx"]["dropped"],
        "tx_packets": stats["tx"]["packets"],
        "tx_errors": stats["tx"]["errors"],
        "tx_dropped": stats["tx"]["dropped"],
    }


def sample():
    now = dt.datetime.now(dt.timezone.utc)
    data = {"time_utc": now.isoformat(timespec="seconds"), "sampler_version": 2}
    try:
        state = command("docker", "inspect", CONTAINER, "--format",
                        "{{.State.Running}}|{{.State.Restarting}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.State.Health.Status}}")
        running, restarting, restarts, started, health = state.split("|", 4)
        data["container"] = {
            "running": running == "true", "restarting": restarting == "true",
            "restart_count": int(restarts), "started_at": started, "health": health,
        }
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError) as error:
        data["container_error"] = type(error).__name__
    try:
        data["awg"] = handshake_counters(int(now.timestamp())) | transfer_counters()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError) as error:
        data["awg_error"] = type(error).__name__
    try:
        data["udp"] = udp_counters()
    except (OSError, ValueError, KeyError) as error:
        data["udp_error"] = type(error).__name__
    for name, interface in (("awg_link", INTERFACE), ("wan_link", "eth0")):
        try:
            data[name] = link_counters(interface)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
                ValueError, KeyError, IndexError) as error:
            data[name + "_error"] = type(error).__name__
    data["host_load_1m"] = round(os.getloadavg()[0], 2)
    try:
        with open("/proc/uptime", encoding="ascii") as stream:
            data["host_uptime_s"] = int(float(stream.read().split()[0]))
    except (OSError, ValueError, IndexError) as error:
        data["uptime_error"] = type(error).__name__
    return data


def main():
    os.umask(0o077)
    os.makedirs(os.path.dirname(LOG_PATH), mode=0o700, exist_ok=True)
    descriptor = os.open(LOG_PATH, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(descriptor, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(sample(), separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
