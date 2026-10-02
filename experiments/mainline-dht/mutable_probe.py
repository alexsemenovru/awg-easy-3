#!/usr/bin/env python3
"""Disposable BEP 44 mutable-item probe. No AWG or client data is used."""

import argparse
import hashlib
import json
import os
import resource
import sys
import time

import libtorrent as lt
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from probe import METRIC_NAMES, PUBLIC_BOOTSTRAP, emit, endpoint


def parser_options():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=49034)
    parser.add_argument("--seconds", type=int, default=180)
    parser.add_argument("--bootstrap", action="append", type=endpoint, default=[])
    parser.add_argument("--public-bootstrap", action="store_true")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--get-key", help="hex-encoded 32-byte test public key")
    parser.add_argument("--salt", default="awg-easy-test")
    parser.add_argument("--update-after", type=int, default=55)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or args.seconds < 20 or args.update_after < 1:
        parser.error("invalid port, run duration or update delay")
    if not (args.bootstrap or args.public_bootstrap):
        parser.error("choose a bootstrap")
    if not (args.publish or args.get_key):
        parser.error("choose --publish and/or --get-key")
    if args.get_key and (len(args.get_key) != 64 or any(c not in "0123456789abcdefABCDEF" for c in args.get_key)):
        parser.error("--get-key requires 64 hex digits")
    if not args.salt.isascii() or len(args.salt) > 64:
        parser.error("salt must be at most 64 ASCII bytes")
    return args


def candidates(item):
    raw = item.get("value", item.get(b"value")) if isinstance(item, dict) else item
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if not isinstance(raw, bytes):
        return []
    result = [raw]
    if len(raw) >= 2 and raw.startswith(b"'") and raw.endswith(b"'"):
        result.append(raw[1:-1])
    return result


def signed_bytes(value, sequence, salt):
    salt_bytes = salt.encode("ascii")
    prefix = (b"4:salt" + str(len(salt_bytes)).encode("ascii") + b":" + salt_bytes
              if salt_bytes else b"")
    return prefix + b"3:seqi" + str(sequence).encode("ascii") + b"e1:v" + lt.bencode(value)


def verify_item(item, expected_key, salt):
    if not isinstance(item, dict):
        return None
    key = item.get("key")
    signature = item.get("signature")
    sequence = item.get("seq")
    if key != expected_key or not isinstance(signature, bytes) or not isinstance(sequence, int):
        return None
    if sequence < 0 or sequence >= 2 ** 63:
        return None
    for candidate in candidates(item):
        if len(lt.bencode(candidate)) > 1000:
            continue
        try:
            Ed25519PublicKey.from_public_bytes(key).verify(
                signature, signed_bytes(candidate, sequence, salt))
            record = json.loads(candidate.decode("utf-8"))
        except (InvalidSignature, UnicodeDecodeError, json.JSONDecodeError, ValueError):
            continue
        if isinstance(record, dict) and record.get("awg_easy_mutable_probe") == 1:
            return {"seq": sequence, "record": record}
    return None


def new_keypair():
    seed = os.urandom(32)
    key = Ed25519PrivateKey.from_private_bytes(seed)
    public = key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw)
    # libtorrent's ed25519_create_keypair() returns SHA-512(seed), with its
    # first 32 bytes clamped. This is not libsodium's seed||public format.
    secret = bytearray(hashlib.sha512(seed).digest())
    secret[0] &= 248
    secret[31] &= 63
    secret[31] |= 64
    return bytes(secret), public


def main():
    args = parser_options()
    categories = lt.alert.category_t
    settings = {
        "listen_interfaces": f"0.0.0.0:{args.port}",
        "dht_bootstrap_nodes": "",
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
        "alert_mask": categories.dht_notification
                      | getattr(categories, "dht_operation_notification", 0)
                      | categories.error_notification
                      | categories.status_notification,
    }
    major = int(lt.version.split(".", 1)[0])
    if major >= 2:
        settings.update({"dht_max_dht_items": 128, "dht_max_torrents": 128,
                         "dht_max_peers": 32, "dht_search_branching": 3})
    session = lt.session(settings)
    if major < 2:
        limits = lt.dht_settings()
        for name, value in (("max_dht_items", 128), ("max_torrents", 128),
                            ("max_peers_reply", 32), ("search_branching", 3)):
            if not hasattr(limits, name):
                raise RuntimeError(f"missing libtorrent 1.x DHT limit: {name}")
            setattr(limits, name, value)
        session.set_dht_settings(limits)
    bootstrap = list(args.bootstrap)
    if args.public_bootstrap:
        bootstrap.extend(endpoint(value) for value in PUBLIC_BOOTSTRAP)
    for host, port in bootstrap:
        session.add_dht_node((host, port))

    private_key, public_key = new_keypair() if args.publish else (None, None)
    lookup_key = bytes.fromhex(args.get_key) if args.get_key else None
    salt = args.salt.encode("ascii")
    if public_key:
        emit("identity", public_key=public_key.hex(),
             target=hashlib.sha1(public_key + salt).hexdigest(), salt=args.salt)
    if lookup_key:
        emit("lookup", public_key=lookup_key.hex(),
             target=hashlib.sha1(lookup_key + salt).hexdigest(), salt=args.salt)
    emit("start", libtorrent=lt.version, pid=os.getpid(), port=args.port,
         bootstrap_count=len(bootstrap), torrents=len(session.get_torrents()))
    started = time.monotonic()
    next_put = started + 15
    next_get = started + 20
    next_sample = started
    last_get_seq = -1
    issued_update = False
    successful_put = False
    try:
        while time.monotonic() - started < args.seconds:
            for alert in session.pop_alerts():
                if isinstance(alert, lt.listen_failed_alert):
                    emit("listen_failed", message=alert.message())
                    return 2
                if isinstance(alert, lt.dht_put_alert):
                    successful_put = successful_put or alert.num_success > 0
                    emit("put_result", target=str(alert.target), seq=alert.seq,
                         success=alert.num_success)
                if isinstance(alert, lt.dht_mutable_item_alert):
                    try:
                        item = alert.item
                    except RuntimeError as error:
                        emit("get_binding_error", detail=str(error))
                        item = None
                    if item is not None and lookup_key:
                        verified = verify_item(item, lookup_key, args.salt)
                        if verified and verified["seq"] > last_get_seq:
                            last_get_seq = verified["seq"]
                            emit("get_result", **verified)
                    elif item is not None:
                        emit("get_item", seq=alert.seq, authoritative=alert.authoritative)
                if type(alert).__name__ == "dht_error_alert":
                    emit("dht_error", message=alert.message())
                if isinstance(alert, lt.dht_bootstrap_alert):
                    emit("bootstrapped")
                if isinstance(alert, lt.session_stats_alert):
                    counters = alert.values
                    emit("sample", **{name: counters.get(name, 0) for name in METRIC_NAMES})
            now = time.monotonic()
            if public_key and now >= next_put:
                revision = 2 if issued_update else 1
                value = json.dumps({"awg_easy_mutable_probe": 1, "revision": revision,
                                    "nonce": os.urandom(8).hex()},
                                   sort_keys=True, separators=(",", ":"))
                session.dht_put_mutable_item(private_key, public_key, value, salt)
                emit("put_requested", revision=revision)
                next_put = now + 25
                if now - started >= args.update_after:
                    issued_update = True
            if lookup_key and now >= next_get:
                session.dht_get_mutable_item(lookup_key, salt)
                emit("get_requested")
                next_get = now + 25
            if now >= next_sample:
                session.post_session_stats()
                next_sample = now + 20
            time.sleep(0.1)
    except KeyboardInterrupt:
        emit("interrupted")
    finally:
        session.pause()
    emit("stop", rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
         successful_put=successful_put, last_get_seq=last_get_seq)
    return 0 if (not args.publish or successful_put) and (not args.get_key or last_get_seq >= 0) else 3


if __name__ == "__main__":
    sys.exit(main())
