#!/usr/bin/env python3
"""Isolated Mainline DHT probe. No torrents, client data, or AWG integration.

Requires python3-libtorrent (tested with Ubuntu 22.04 package 2.0.5).
Public network contact is opt-in via --public-bootstrap.
"""

import argparse
import hashlib
import json
import os
import resource
import sys
import time

import libtorrent as lt


PUBLIC_BOOTSTRAP = (
    "dht.libtorrent.org:25401",
    "router.bittorrent.com:6881",
    "dht.transmissionbt.com:6881",
)
METRIC_NAMES = (
    "dht.dht_nodes",
    "dht.dht_messages_in",
    "dht.dht_messages_out",
    "dht.dht_bytes_in",
    "dht.dht_bytes_out",
    "dht.dht_bytes_in_dropped",
    "dht.dht_bytes_out_dropped",
    "dht.dht_immutable_data",
)


def endpoint(value):
    host, separator, port_text = value.rpartition(":")
    if not separator or not host or not port_text.isdecimal():
        raise argparse.ArgumentTypeError("Expected HOST:PORT")
    port = int(port_text)
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("Port must be 1..65535")
    return host, port


def options():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="0.0.0.0", help="local bind address")
    parser.add_argument("--port", type=int, default=49033, help="separate DHT UDP port")
    parser.add_argument("--seconds", type=int, default=120, help="bounded run time")
    parser.add_argument("--interval", type=int, default=10, help="sample interval")
    parser.add_argument("--bootstrap", action="append", type=endpoint, default=[])
    parser.add_argument("--public-bootstrap", action="store_true")
    parser.add_argument("--put-probe", action="store_true", help="publish random, non-secret test record")
    parser.add_argument("--probe-nonce", metavar="HEX24",
                        help="fixed non-secret nonce for repeatable local tests")
    parser.add_argument("--get-probe", metavar="SHA1", help="retrieve test record by 40-digit hash")
    parser.add_argument("--probe-delay", type=int, default=15,
                        help="wait for DHT bootstrap before put/get")
    parser.add_argument("--retry-interval", type=int, default=25,
                        help="repeat put/get until the record is published/found")
    parser.add_argument("--trace-packets", action="store_true",
                        help="diagnostic DHT packet logging; use only with disposable probe data")
    args = parser.parse_args()
    if (not 1 <= args.port <= 65535 or args.seconds < 1 or args.interval < 1
            or args.probe_delay < 0 or args.retry_interval < 1):
        parser.error("port, seconds, interval and probe delay must be valid")
    if args.get_probe and (len(args.get_probe) != 40 or any(c not in "0123456789abcdefABCDEF" for c in args.get_probe)):
        parser.error("--get-probe requires a 40-digit SHA-1 hash")
    if args.probe_nonce and (len(args.probe_nonce) != 24 or any(c not in "0123456789abcdefABCDEF" for c in args.probe_nonce)):
        parser.error("--probe-nonce requires 24 hexadecimal digits")
    if not (args.bootstrap or args.public_bootstrap):
        parser.error("choose --bootstrap HOST:PORT or --public-bootstrap")
    if (args.put_probe or args.get_probe) and args.probe_delay >= args.seconds:
        parser.error("probe delay must be shorter than run time")
    return args


def emit(kind, **fields):
    print(json.dumps({"event": kind, "time": int(time.time()), **fields}, sort_keys=True), flush=True)


def json_value(value):
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return {"hex": value.hex()}
    if isinstance(value, dict):
        return {str(json_value(key)): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    return value


def decode_probe_item(item, target):
    raw = item.get("value", item.get(b"value")) if isinstance(item, dict) else item
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if not isinstance(raw, bytes):
        return None
    candidates = [raw]
    # Debian's libtorrent 1.2.9 Python binding returns an extra pair of
    # apostrophes around an otherwise valid bencoded string value.
    if len(raw) >= 2 and raw.startswith(b"'") and raw.endswith(b"'"):
        candidates.append(raw[1:-1])
    for candidate in candidates:
        if hashlib.sha1(lt.bencode(candidate)).hexdigest() != target.lower():
            continue
        try:
            value = json.loads(candidate.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(value, dict) and value.get("awg_easy_dht_probe") == 1:
            return value
    return None


def main():
    args = options()
    bootstrap = list(args.bootstrap)
    if args.public_bootstrap:
        bootstrap.extend(endpoint(item) for item in PUBLIC_BOOTSTRAP)
    major = int(lt.version.split(".", 1)[0])
    alert_categories = lt.alert.category_t
    alert_mask = (
        alert_categories.dht_notification
        | getattr(alert_categories, "dht_operation_notification", 0)
        | alert_categories.error_notification
        | alert_categories.status_notification
    )
    if args.trace_packets:
        alert_mask |= alert_categories.dht_log_notification
    settings = {
        "listen_interfaces": f"{args.bind}:{args.port}",
        "dht_bootstrap_nodes": "",  # no implicit, unreviewed bootstraps
        "enable_dht": True,
        "enable_upnp": False,
        "enable_natpmp": False,
        "enable_lsd": False,
        "enable_incoming_tcp": False,
        "enable_outgoing_tcp": False,
        "enable_incoming_utp": False,
        "enable_outgoing_utp": False,
        "dht_upload_rate_limit": 2048,
        "listen_system_port_fallback": False,
        "alert_mask": alert_mask,
    }
    if major >= 2:
        settings.update({
            "dht_max_dht_items": 128,
            "dht_max_torrents": 128,
            "dht_max_peers": 32,
            "dht_search_branching": 3,
        })
    session = lt.session(settings)
    if major < 2:
        # In libtorrent 1.x these limits live in dht_settings, not settings_pack.
        limits = lt.dht_settings()
        for name, value in (("max_dht_items", 128), ("max_torrents", 128),
                            ("max_peers_reply", 32), ("search_branching", 3)):
            if not hasattr(limits, name):
                raise RuntimeError(f"libtorrent 1.x lacks DHT safety limit: {name}")
            setattr(limits, name, value)
        session.set_dht_settings(limits)
    for host, port in bootstrap:
        session.add_dht_node((host, port))
    emit("start", libtorrent=lt.version, pid=os.getpid(), bind=args.bind,
         port=args.port, bootstrap_count=len(bootstrap), torrents=len(session.get_torrents()))
    deadline = time.monotonic() + args.seconds
    next_sample = time.monotonic()
    probe_at = time.monotonic() + args.probe_delay
    # libtorrent 1.x/2.0 Python dht_immutable_item_alert.item converts the
    # result with entry.string(), so a DHT dictionary cannot be read here.
    # Store compact JSON as a bencoded string instead.
    put_value = (json.dumps({"awg_easy_dht_probe": 1,
                             "nonce": args.probe_nonce or os.urandom(12).hex()},
                            sort_keys=True, separators=(",", ":"))
                 if args.put_probe else None)
    next_put = probe_at
    next_lookup = probe_at
    failed_listen = False
    put_success = False
    get_success = False
    try:
        while time.monotonic() < deadline:
            for alert in session.pop_alerts():
                if isinstance(alert, lt.listen_failed_alert):
                    failed_listen = True
                    emit("listen_failed", message=alert.message())
                elif isinstance(alert, lt.dht_put_alert):
                    put_success = put_success or alert.num_success > 0
                    emit("put_result", hash=str(alert.target), success=alert.num_success)
                    if not put_success:
                        next_put = time.monotonic() + args.retry_interval
                elif isinstance(alert, lt.dht_immutable_item_alert):
                    try:
                        item = alert.item
                    except RuntimeError as error:
                        item = None  # libtorrent binding uses invalid entry on miss
                        if args.trace_packets:
                            emit("get_binding_error", detail=str(error), alert=alert.message())
                    value = decode_probe_item(item, str(alert.target)) if item is not None else None
                    if args.trace_packets and item is not None:
                        emit("get_alert_shape", item_type=type(item).__name__,
                             item_repr=repr(item)[:500])
                    get_success = get_success or (
                        isinstance(value, dict)
                        and value.get("awg_easy_dht_probe") == 1
                        and str(alert.target).lower() == args.get_probe.lower())
                    emit("get_result", hash=str(alert.target), value=json_value(value))
                elif args.trace_packets and isinstance(alert, lt.dht_pkt_alert):
                    emit("packet", detail=alert.message())
                    try:
                        packet = lt.bdecode(alert.pkt_buf)
                        response = packet.get(b"r", packet.get("r"))
                        if isinstance(response, dict):
                            record = response.get(b"v", response.get("v"))
                            if record is not None:
                                emit("packet_record", bencoded_sha1=hashlib.sha1(lt.bencode(record)).hexdigest(),
                                     record_type=type(record).__name__)
                    except (RuntimeError, TypeError, ValueError):
                        pass
                elif isinstance(alert, lt.dht_bootstrap_alert):
                    emit("bootstrapped")
                elif type(alert).__name__ == "dht_error_alert":
                    emit("dht_error", message=alert.message())
                elif isinstance(alert, lt.session_stats_alert):
                    counters = alert.values
                    sample = {name: counters.get(name, 0) for name in METRIC_NAMES}
                    sample["rss_kib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                    sample["torrents"] = len(session.get_torrents())
                    emit("sample", **sample)
            if failed_listen:
                return 2
            now = time.monotonic()
            if put_value is not None and not put_success and now >= next_put:
                target = session.dht_put_immutable_item(put_value)
                emit("put_requested", hash=str(target), value=put_value)
                next_put = now + args.retry_interval
            if args.get_probe and not get_success and now >= next_lookup:
                session.dht_get_immutable_item(lt.sha1_hash(bytes.fromhex(args.get_probe)))
                emit("get_requested", hash=args.get_probe.lower())
                next_lookup = now + args.retry_interval
            if now >= next_sample:
                session.post_session_stats()
                next_sample = now + args.interval
            time.sleep(0.1)
    except KeyboardInterrupt:
        emit("interrupted")
    finally:
        session.pause()
    emit("stop")
    return 0 if (not args.put_probe or put_success) and (not args.get_probe or get_success) else 3


if __name__ == "__main__":
    sys.exit(main())
