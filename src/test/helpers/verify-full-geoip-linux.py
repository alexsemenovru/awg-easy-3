#!/usr/bin/env python3
"""Validate/apply public database policies only in a disposable root netns."""
import json
import os
import subprocess
import sys
import time

if os.geteuid() != 0 or os.readlink('/proc/self/ns/net') == os.readlink('/proc/1/ns/net'):
    sys.exit('Refusing to touch host networking; use unshare --net')

policies = json.load(sys.stdin)
for country, rules in policies.items():
    # This namespace was created solely for this checker; no host rules exist here.
    subprocess.run(['nft', 'flush', 'ruleset'], check=True)
    start = time.monotonic()
    subprocess.run(['nft', '-c', '-f', '-'], input=rules, text=True, check=True)
    checked = time.monotonic()
    subprocess.run(['nft', '-f', '-'], input=rules, text=True, check=True)
    print(json.dumps({'country': country, 'checkSeconds': round(checked-start, 3),
                      'applySeconds': round(time.monotonic()-checked, 3)}), flush=True)
