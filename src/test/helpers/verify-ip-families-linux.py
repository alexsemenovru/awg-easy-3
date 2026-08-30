#!/usr/bin/env python3
"""Optional real-kernel test. Run ONLY in `unshare --net`; JSON policies on stdin.

Uses synthetic TUN interfaces, not AWG, Docker, a VPS or the host's network.
Requires Linux, root, /dev/net/tun, iproute2, nftables and Python stdlib only.
Example (from repo root on Linux):
  node src/test/helpers/ip-family-policies.js | sudo unshare --net \
    python3 src/test/helpers/verify-ip-families-linux.py
"""
import fcntl
import json
import os
import select
import socket
import struct
import subprocess
import sys

if os.geteuid() != 0 or os.readlink('/proc/self/ns/net') == os.readlink('/proc/1/ns/net'):
    sys.exit('Refusing to change networking outside a separate root network namespace')
policies = json.load(sys.stdin)


def run(*args, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f'{args}: {result.stderr.strip()}')
    return result.stdout


def tun(name, addresses):
    fd = os.open('/dev/net/tun', os.O_RDWR | os.O_NONBLOCK)
    fcntl.ioctl(fd, 0x400454ca, struct.pack('16sH', name.encode(), 0x0001 | 0x1000))
    run('ip', 'link', 'set', name, 'up')
    for address in addresses:
        run('ip', 'addr', 'add', address, 'dev', name, *(['nodad'] if ':' in address else []))
    return fd


def checksum(data):
    if len(data) % 2:
        data += b'\0'
    total = sum(struct.unpack('!%dH' % (len(data) // 2), data))
    while total >> 16:
        total = (total & 0xffff) + (total >> 16)
    return (~total) & 0xffff


def packet(source, destination, payload, sport=40000, dport=55555):
    family = socket.AF_INET6 if ':' in source else socket.AF_INET
    src, dst = (socket.inet_pton(family, value) for value in [source, destination])
    length = 8 + len(payload)
    udp = struct.pack('!HHHH', sport, dport, length, 0) + payload
    pseudo = src + dst + (struct.pack('!I3xB', length, 17) if family == socket.AF_INET6 else struct.pack('!BBH', 0, 17, length))
    udp = udp[:6] + struct.pack('!H', checksum(pseudo + udp) or 0xffff) + payload
    if family == socket.AF_INET6:
        return struct.pack('!IHBB', 6 << 28, length, 17, 64) + src + dst + udp
    header = struct.pack('!BBHHHBBH', 0x45, 0, length + 20, 0, 0, 64, 17, 0) + src + dst
    return header[:10] + struct.pack('!H', checksum(header)) + header[12:] + udp


def drain(fd):
    while select.select([fd], [], [], 0)[0]:
        os.read(fd, 65535)


def received(fd, payload, expected, label):
    # Bounded select, ignoring incidental ICMP/IPv6 traffic on the fake TUN.
    import time
    deadline = time.monotonic() + (0.7 if expected else 0.12)
    found = None
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], max(0, deadline - time.monotonic()))[0]:
            break
        data = os.read(fd, 65535)
        if payload in data:
            # Do not mistake an ICMP error quoting the original packet for UDP delivery.
            if (data[0] >> 4 == 4 and data[9] == 17) or (data[0] >> 4 == 6 and data[6] == 17):
                found = data
                break
    assert bool(found) == expected, label
    return found


run('ip', 'link', 'set', 'lo', 'up')
run('sysctl', '-qw', 'net.ipv4.ip_forward=1', 'net.ipv6.conf.all.forwarding=1')
awg = tun('awg0', ['10.8.0.1/24', 'fd42:8::1/64'])
wan = tun('eth0', ['198.51.100.1/24', 'fd42:9::1/64'])
foreign = tun('other0', ['192.0.2.1/24', 'fd42:a::1/64'])
run('nft', '-f', '-', data='table inet unrelated {\n chain marker {\n }\n}\n')
unrelated = run('nft', 'list', 'table', 'inet', 'unrelated')
loaded = False


def policy(name):
    global loaded
    prefix = 'delete table inet awg_easy_3\n' if loaded else ''
    run('nft', '-c', '-f', '-', data=prefix + policies[name])
    run('nft', '-f', '-', data=prefix + policies[name])
    loaded = True
    assert run('nft', 'list', 'table', 'inet', 'unrelated') == unrelated
    for fd in [awg, wan, foreign]:
        drain(fd)


checks = 0
for name, flags in [('both', (True, True)), ('v4', (True, False)), ('v6', (False, True)), ('off', (False, False)), ('both', (True, True))]:
    policy(name)
    for version, permitted in zip([4, 6], flags):
        client, home, guest, server, remote, outside = (
            ('10.8.0.2', '10.8.0.3', '10.8.0.4', '10.8.0.1', '198.51.100.2', '192.0.2.2') if version == 4 else
            ('fd42:8::2', 'fd42:8::3', 'fd42:8::4', 'fd42:8::1', 'fd42:9::2', 'fd42:a::2')
        )
        family = socket.AF_INET if version == 4 else socket.AF_INET6
        # Seed an established NAT/conntrack flow before each switch.
        policy('both')
        marker = f'family-{version}-{name}-flow'.encode()
        os.write(awg, packet(client, remote, marker))
        outbound = received(wan, marker, True, 'initial client to WAN')
        offset, address_slice = (20, slice(12, 16)) if version == 4 else (40, slice(8, 24))
        translated_source = socket.inet_ntop(family, outbound[address_slice])
        translated_port = struct.unpack('!H', outbound[offset:offset + 2])[0]
        response = packet(remote, translated_source, marker + b'-return', sport=55555, dport=translated_port)
        os.write(wan, response)
        received(awg, marker + b'-return', True, 'initial WAN return')
        policy(name)
        os.write(awg, packet(client, remote, marker))
        received(wan, marker, permitted, f'{name} IPv{version}: client to WAN')
        os.write(wan, response)
        received(awg, marker + b'-return', permitted, f'{name} IPv{version}: established WAN return')
        # Two Home clients are represented by different IPs behind the same TUN.
        for source, destination, allowed in [(client, home, permitted), (home, client, permitted), (guest, home, False)]:
            marker = f'{source}-{destination}-{name}'.encode()
            os.write(awg, packet(source, destination, marker))
            received(awg, marker, allowed, f'{name}: Home/Guest {source} to {destination}')
            checks += 1
        # Local server INPUT and OUTPUT are separate hooks from forwarding.
        with socket.socket(family, socket.SOCK_DGRAM) as local:
            local.bind((server, 55555))
            local.settimeout(0.12)
            marker = f'{name}-{version}-local'.encode()
            os.write(awg, packet(client, server, marker))
            try:
                got = local.recv(4096) == marker
            except socket.timeout:
                got = False
            assert got == permitted, f'{name}: server input IPv{version}'
            try:
                local.sendto(marker + b'-output', (client, 40000))
            except PermissionError:
                assert not permitted, f'{name}: permitted server output was denied'
            received(awg, marker + b'-output', permitted, f'{name}: server output IPv{version}')
        # Unrelated infrastructure must remain reachable even with both flags off.
        marker = f'{name}-{version}-unrelated'.encode()
        os.write(foreign, packet(outside, remote, marker))
        received(wan, marker, True, 'unrelated forwarding')
        checks += 5
    print(f'PASS {name}: IPv4/IPv6, established flows, Home/Guest, server traffic, unrelated forwarding', flush=True)

# Empty active sets and IPv4-only servers must also compile in the kernel.
policy('empty4')
os.write(awg, packet('10.8.0.2', '198.51.100.2', b'empty4'))
received(wan, b'empty4', False, 'empty IPv4 allow set blocks all IPv4')
policy('no6')
os.write(awg, packet('fd42:8::2', 'fd42:9::2', b'no6'))
received(wan, b'no6', False, 'IPv4-only server blocks IPv6')
print(f'PASS {checks + 2} packet assertions; foreign table unchanged; namespace exits without host changes')
