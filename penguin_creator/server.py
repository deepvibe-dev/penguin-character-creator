"""A small, dependency-free static file server for the penguin creator.

All of the app runs in the browser; the server only hands out files.

Routes
------
GET  /                 the app (static/index.html)
GET  /static/<file>    static assets: JS, CSS, fonts, the reference data
GET  /healthz          liveness probe
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from . import __version__

STATIC_DIR = Path(__file__).resolve().parent / "static"

mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/csv", ".csv")
mimetypes.add_type("application/json", ".json")


class Handler(BaseHTTPRequestHandler):
    server_version = f"PenguinCreator/{__version__}"

    def log_message(self, fmt, *args):
        if not os.environ.get("PENGUIN_QUIET"):
            super().log_message(fmt, *args)

    def _send(self, status: int, body: bytes, content_type: str, headers: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _text(self, status: int, message: str):
        self._send(status, message.encode("utf-8"), "text/plain; charset=utf-8")

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == "/healthz":
            body = json.dumps({"status": "ok", "version": __version__}).encode("utf-8")
            return self._send(HTTPStatus.OK, body, "application/json")
        if path in ("", "/"):
            path = "/index.html"
        elif path.startswith("/static/"):
            path = path[len("/static"):]
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        if not target.is_file() or STATIC_DIR not in target.parents:
            return self._text(HTTPStatus.NOT_FOUND, "Not found")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/json", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self._send(HTTPStatus.OK, target.read_bytes(), ctype, {"Cache-Control": "no-cache"})

    do_HEAD = do_GET

    def _not_allowed(self):
        self._send(HTTPStatus.METHOD_NOT_ALLOWED, b"Method not allowed", "text/plain; charset=utf-8", {"Allow": "GET, HEAD"})

    do_POST = do_PUT = do_DELETE = do_PATCH = _not_allowed


def make_server(host: str = "127.0.0.1", port: int = 8000) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Penguin character creator (static site server)")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = parser.parse_args(argv)
    server = make_server(args.host, args.port)
    host, port = server.server_address[:2]
    print(f"Penguin character creator on http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
