#!/usr/bin/env python3
"""Development server for 9ThirtyOne.

A service worker, the File System Access API, and Google OAuth all require a
secure context, so opening index.html from the filesystem will not exercise the
real app. `localhost` counts as secure; a LAN IP does not, which is why testing
on a phone needs --https.

    python3 serve.py                 # http://localhost:8000
    python3 serve.py --port 8080
    python3 serve.py --https         # self-signed TLS, for testing on a phone

--https generates a self-signed certificate in .certs/ using openssl. Phones will
warn about the certificate; accept it once for the session. For a real
deployment, host the folder on any static HTTPS host (GitHub Pages, Netlify,
Cloudflare Pages, an internal IIS/Apache site) — there is no backend to run.
"""

from __future__ import annotations

import argparse
import http.server
import socket
import socketserver
import ssl
import subprocess
import sys
import webbrowser
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CERT_DIR = ROOT / ".certs"
CERT_FILE = CERT_DIR / "dev-cert.pem"
KEY_FILE = CERT_DIR / "dev-key.pem"


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static handler with the MIME types and cache rules this app needs."""

    # HTTP/1.1, so one connection serves many requests.
    #
    # The default is HTTP/1.0, which closes after every response — a separate TCP
    # connection for each of the app's forty-odd ES modules, and another for each
    # of the fifty-five entries the service worker precaches on install. Chrome
    # opens six at a time, so a cold load arrives as a burst the accept queue
    # could not absorb, and the kernel reset the overflow. In the browser that
    # surfaced as net::ERR_CONNECTION_RESET and a page that never rendered.
    #
    # SimpleHTTPRequestHandler sends an accurate Content-Length for every file it
    # serves, which is what makes keep-alive safe to turn on here.
    protocol_version = "HTTP/1.1"

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
        ".css": "text/css",
    }

    def end_headers(self) -> None:
        # Never cache during development: a stale service worker is the single
        # most confusing thing to debug.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        status = args[1] if len(args) > 1 else ""
        if str(status).startswith(("4", "5")):
            sys.stderr.write(f"  {fmt % args}\n")


def lan_ip() -> str:
    """Best-effort LAN address, for testing on a phone."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def ensure_cert() -> bool:
    """Creates a self-signed certificate if one is not already present."""
    if CERT_FILE.exists() and KEY_FILE.exists():
        return True
    CERT_DIR.mkdir(exist_ok=True)
    print("Generating a self-signed certificate in .certs/ …")
    try:
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-keyout", str(KEY_FILE), "-out", str(CERT_FILE),
                "-days", "365", "-subj", "/CN=nine-thirty-one.local",
                "-addext", f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{lan_ip()}",
            ],
            check=True, capture_output=True,
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError) as err:
        detail = err.stderr.decode() if isinstance(err, subprocess.CalledProcessError) else str(err)
        print(f"Could not create a certificate: {detail}", file=sys.stderr)
        print("Install openssl, or run without --https and test on localhost.", file=sys.stderr)
        return False


class ReusableServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    # The listen backlog. socketserver's default is 5, which a cold load of this
    # app overruns on its own: the browser asks for the shell, the modules and
    # the icons faster than a thread-per-connection server can accept them, and
    # everything past the fifth queued connection is refused by the kernel rather
    # than by anything in this file. That is what made the browser suites fail
    # intermittently on a page that had simply never rendered.
    request_queue_size = 128


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="0.0.0.0", help="bind address (default: all interfaces)")
    parser.add_argument("--https", action="store_true", help="serve over TLS with a self-signed certificate")
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    args = parser.parse_args()

    if args.https and not ensure_cert():
        return 1

    handler = partial(Handler, directory=str(ROOT))
    scheme = "https" if args.https else "http"

    try:
        httpd = ReusableServer((args.host, args.port), handler)
    except OSError as err:
        print(f"Could not bind {args.host}:{args.port} — {err}", file=sys.stderr)
        return 1

    if args.https:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    local_url = f"{scheme}://localhost:{args.port}/"
    print(f"\n  9ThirtyOne dev server\n")
    print(f"    local    {local_url}")
    print(f"    network  {scheme}://{lan_ip()}:{args.port}/")
    if not args.https:
        print("\n    Note: only localhost is a secure context over http.")
        print("    Use --https to test installation or Drive sign-in from a phone.")
    print("\n  Ctrl-C to stop.\n")

    if not args.no_open:
        webbrowser.open(local_url)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
