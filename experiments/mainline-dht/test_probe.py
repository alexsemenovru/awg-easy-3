#!/usr/bin/env python3
"""Local regression tests for libtorrent 1.2/2.0 immutable-item responses."""

import hashlib
import json
import unittest

import libtorrent as lt

from probe import decode_probe_item


class DecodeProbeItemTests(unittest.TestCase):
    def setUp(self):
        self.value = {"awg_easy_dht_probe": 1, "nonce": "111111111111111111111111"}
        self.raw = json.dumps(self.value, sort_keys=True, separators=(",", ":")).encode()
        self.target = hashlib.sha1(lt.bencode(self.raw)).hexdigest()

    def test_unwrapped_bytes(self):
        self.assertEqual(decode_probe_item({"value": self.raw}, self.target), self.value)

    def test_legacy_binding_apostrophes(self):
        self.assertEqual(decode_probe_item({"value": b"'" + self.raw + b"'"}, self.target), self.value)

    def test_wrong_hash_is_rejected(self):
        self.assertIsNone(decode_probe_item({"value": self.raw}, "0" * 40))
        self.assertIsNone(decode_probe_item({"value": b"'" + self.raw + b"'"}, "0" * 40))

    def test_missing_or_non_probe_value_is_rejected(self):
        self.assertIsNone(decode_probe_item({"value": b"<uninitialized>"}, self.target))
        other = b'{"other":1}'
        self.assertIsNone(decode_probe_item({"value": other}, hashlib.sha1(lt.bencode(other)).hexdigest()))


if __name__ == "__main__":
    unittest.main()
