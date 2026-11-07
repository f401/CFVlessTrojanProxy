#!/usr/bin/env python3
"""
VLESS over WebSocket 真客户端探测脚本。

为什么需要它：curl 测不了 WebSocket。只要请求带 Upgrade: websocket 而
Worker 返回的不是 101，Cloudflare 就一律回 502/522 —— 看起来像服务挂了，
其实那只是 CF 对非 101 响应的处理方式。

用法:
    python3 wsprobe.py <入口域名> <UUID> [目标域名] [目标端口]

例子:
    python3 wsprobe.py example.com 00000000-0000-0000-0000-000000000000 example.com 443
    python3 wsprobe.py example.com 00000000-... x.com 443     # 走 proxyip 的路径

输出:
    OK 2.5s  HTTP/1.1 200 OK
    FAIL 1.8s SSLError [SSL: WRONG_VERSION_NUMBER] ...     ← 说明返回的不是 TLS 字节
"""
import base64
import os
import socket
import ssl
import struct
import sys
import time

ENTRY = sys.argv[1] if len(sys.argv) > 1 else ""
UUID = sys.argv[2] if len(sys.argv) > 2 else ""
TARGET = sys.argv[3] if len(sys.argv) > 3 else "example.com"
TPORT = int(sys.argv[4]) if len(sys.argv) > 4 else 443

if not ENTRY or not UUID:
    print(__doc__)
    sys.exit(2)


def uuid_bytes(u):
    return bytes.fromhex(u.replace("-", ""))


def vless_header(host, port, uuid):
    """version(1) uuid(16) addon_len(1) command(1=TCP) port(2) atyp(1=域名) len(1) host"""
    b = bytearray([0])
    b += uuid_bytes(uuid)
    b += bytes([0, 1])
    b += struct.pack(">H", port)
    h = host.encode()
    b += bytes([2, len(h)]) + h
    return bytes(b)


def ws_frame(payload):
    mask = os.urandom(4)
    n = len(payload)
    b = bytearray([0x82])
    if n < 126:
        b.append(0x80 | n)
    elif n < 65536:
        b.append(0x80 | 126)
        b += struct.pack(">H", n)
    else:
        b.append(0x80 | 127)
        b += struct.pack(">Q", n)
    b += mask
    b += bytes(payload[i] ^ mask[i % 4] for i in range(n))
    return bytes(b)


class Tunnel:
    def __init__(self, timeout=30):
        raw = socket.create_connection((ENTRY, 443), timeout=12)
        self.c = ssl.create_default_context().wrap_socket(raw, server_hostname=ENTRY)
        self.c.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /?ed=2560&ip=probe HTTP/1.1\r\nHost: {ENTRY}\r\n"
            f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.c.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            d = self.c.recv(4096)
            if not d:
                raise EOFError("handshake closed")
            head += d
        status = head.split(b"\r\n")[0].decode("latin1")
        if "101" not in status:
            raise RuntimeError(f"handshake failed: {status}")
        self.buf = head.split(b"\r\n\r\n", 1)[1]
        self.first = True
        self.c.sendall(ws_frame(vless_header(TARGET, TPORT, UUID)))

    def _fill(self):
        d = self.c.recv(16384)
        if not d:
            raise EOFError("closed")
        self.buf += d

    def recv(self):
        """返回一帧二进制数据；首帧去掉 2 字节 VLESS 响应头"""
        while True:
            if len(self.buf) >= 2:
                b1, b2 = self.buf[0], self.buf[1]
                i, n = 2, b2 & 0x7F
                if n == 126:
                    if len(self.buf) < 4:
                        self._fill()
                        continue
                    n = struct.unpack(">H", self.buf[2:4])[0]
                    i = 4
                elif n == 127:
                    if len(self.buf) < 10:
                        self._fill()
                        continue
                    n = struct.unpack(">Q", self.buf[2:10])[0]
                    i = 10
                if len(self.buf) < i + n:
                    self._fill()
                    continue
                op = b1 & 0x0F
                payload = self.buf[i:i + n]
                self.buf = self.buf[i + n:]
                if op == 0x8:
                    raise EOFError("server closed")
                if op != 0x2:
                    continue
                if self.first:
                    payload = payload[2:]
                    self.first = False
                if payload:
                    return payload
                continue
            self._fill()

    def send(self, data):
        if data:
            self.c.sendall(ws_frame(data))


def main():
    t0 = time.time()
    try:
        t = Tunnel()
        inc, out = ssl.MemoryBIO(), ssl.MemoryBIO()
        inner = ssl.create_default_context().wrap_bio(inc, out, server_hostname=TARGET)

        while True:
            try:
                inner.do_handshake()
                break
            except ssl.SSLWantReadError:
                t.send(out.read())
                inc.write(t.recv())

        inner.write(
            f"GET /__down?bytes=60000000 HTTP/1.1\r\nHost: {TARGET}\r\nUser-Agent: Mozilla/5.0\r\n"
            f"Connection: close\r\n\r\n".encode()
        )
        head = b""
        total = 0
        t_start = None
        deadline = time.time() + 20
        while time.time() < deadline:
            t.send(out.read())
            try:
                chunk = inner.read(65536)
            except ssl.SSLWantReadError:
                chunk = b""
            except Exception:
                break
            if chunk:
                if t_start is None:
                    if b"\r\n\r\n" not in head:
                        head += chunk
                        if b"\r\n\r\n" in head:
                            body = head.split(b"\r\n\r\n", 1)[1]
                            total += len(body)
                            t_start = time.time()
                            continue
                    else:
                        t_start = time.time()
                total += len(chunk)
            try:
                inc.write(t.recv())
            except EOFError:
                break
        dt = max(0.001, (time.time() - t_start) if t_start else 0.001)
        print(f"{total/1048576:.2f} MB in {dt:.1f}s = {total/1048576/dt:.2f} MB/s")
    except Exception as e:
        print(f"FAIL {round(time.time() - t0, 1)}s {type(e).__name__} {e}")


if __name__ == "__main__":
    main()
