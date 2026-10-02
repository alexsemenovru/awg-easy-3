#!/usr/bin/env python3
"""Offline checks for BEP 44 record signature and binding normalization."""

import json
import unittest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from mutable_probe import new_keypair, signed_bytes, verify_item


class MutableProbeTest(unittest.TestCase):
    def setUp(self):
        self.key = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
        self.public = self.key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw)
        self.value = json.dumps({"awg_easy_mutable_probe": 1, "revision": 1}).encode()
        self.salt = "awg-easy-test"
        self.item = {
            "key": self.public,
            "signature": self.key.sign(signed_bytes(self.value, 1, self.salt)),
            "seq": 1,
            "value": self.value,
        }

    def test_valid(self):
        self.assertEqual(verify_item(self.item, self.public, self.salt)["seq"], 1)

    def test_binding_apostrophes(self):
        item = dict(self.item, value=b"'" + self.value + b"'")
        self.assertEqual(verify_item(item, self.public, self.salt)["seq"], 1)

    def test_wrong_key(self):
        self.assertIsNone(verify_item(self.item, bytes(32), self.salt))

    def test_wrong_salt(self):
        self.assertIsNone(verify_item(self.item, self.public, "other"))

    def test_modified_value(self):
        item = dict(self.item, value=self.value + b" ")
        self.assertIsNone(verify_item(item, self.public, self.salt))

    def test_libtorrent_key_format(self):
        secret, public = new_keypair()
        self.assertEqual(len(secret), 64)
        self.assertEqual(len(public), 32)
        self.assertEqual(secret[0] & 7, 0)
        self.assertEqual(secret[31] & 0xC0, 0x40)


if __name__ == "__main__":
    unittest.main()
