"""A small, dependency-free HTTP server for the penguin character creator.

Routes
------
GET  /                      the app
GET  /static/<file>         static assets (vendored, no CDN)
GET  /healthz               liveness probe
GET  /api/config            server features (is a workspace file configured?)
GET  /api/reference         per-species statistics used for the slider bands
GET  /api/sample            the original Palmer penguins dataset
POST /api/parse             body: CSV text -> {dialect, records}
POST /api/export            body: {records, dialect, layout?} -> CSV file
POST /api/generate          body: generator options -> {records}
GET  /api/workspace         read the CSV file given by --data / PENGUIN_DATA_FILE
PUT  /api/workspace         body: {records, dialect} -> write that CSV file
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import tempfile
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from . import __version__
from .dataset import Dialect, FormatError, convert_dialect, parse_csv, write_csv
from .generator import generate
from .reference import REFERENCE_CSV, reference

STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_BODY = 50 * 1024 * 1024  # 50 MB of CSV is ~1 million penguins

mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("text/javascript", ".js")


class App:
    """Holds server configuration; shared by all request handlers."""

    def __init__(self, data_file: Path | None = None):
        self.data_file = data_file
        self.lock = threading.Lock()

    def read_workspace(self) -> dict:
        if not self.data_file:
            raise LookupError("No workspace file configured.")
        if not self.data_file.exists():
            dialect = Dialect()
            return {"dialect": dialect.to_json(), "records": [], "filename": self.data_file.name}
        with self.lock, open(self.data_file, newline="", encoding="utf-8-sig") as fh:
            dialect, records = parse_csv(fh.read())
        return {"dialect": dialect.to_json(), "records": records, "filename": self.data_file.name}

    def write_workspace(self, records: list[dict], dialect: Dialect) -> int:
        if not self.data_file:
            raise LookupError("No workspace file configured.")
        text = write_csv(records, dialect)
        with self.lock:
            self.data_file.parent.mkdir(parents=True, exist_ok=True)
            if self.data_file.exists():
                shutil.copy2(self.data_file, self.data_file.with_suffix(self.data_file.suffix + ".bak"))
            fd, tmp = tempfile.mkstemp(dir=self.data_file.parent, prefix=".penguins-", suffix=".csv")
            with os.fdopen(fd, "w", newline="", encoding="utf-8") as fh:
                fh.write(text)
            os.replace(tmp, self.data_file)
        return len(records)


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"PenguinCreator/{__version__}"

        # -- helpers -------------------------------------------------------
        def log_message(self, fmt, *args):  # quieter, single-line logs
            if os.environ.get("PENGUIN_QUIET"):
                return
            super().log_message(fmt, *args)

        def _send(self, status: int, body: bytes, content_type: str, headers: dict | None = None):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, payload, status: int = 200):
            self._send(status, json.dumps(payload).encode("utf-8"), "application/json")

        def _error(self, status: int, message: str):
            self._json({"error": message}, status)

        def _body(self) -> bytes:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise OverflowError("Request body too large.")
            return self.rfile.read(length)

        def _json_body(self) -> dict:
            try:
                data = json.loads(self._body() or b"{}")
            except json.JSONDecodeError as exc:
                raise FormatError(f"Invalid JSON: {exc}") from exc
            if not isinstance(data, dict):
                raise FormatError("Expected a JSON object.")
            return data

        def _records_and_dialect(self, data: dict) -> tuple[list[dict], Dialect]:
            records = data.get("records")
            if not isinstance(records, list) or not all(isinstance(r, dict) for r in records):
                raise FormatError("'records' must be a list of objects.")
            clean = []
            for r in records:
                rec = {k: ("" if v is None else str(v)) for k, v in r.items() if k != "extra"}
                extra = r.get("extra") or {}
                rec["extra"] = {str(k): ("" if v is None else str(v)) for k, v in extra.items()}
                clean.append(rec)
            dialect = Dialect.from_json(data.get("dialect"))
            layout = data.get("layout")
            if layout in ("lter", "simple"):
                dialect = convert_dialect(dialect, layout)
            return clean, dialect

        def _dispatch(self, routes: dict):
            path = urlparse(self.path).path
            handler = routes.get(path)
            try:
                if handler:
                    return handler()
                if self.command in ("GET", "HEAD"):
                    return self._static(path)
                self._error(HTTPStatus.NOT_FOUND, "Not found")
            except FormatError as exc:
                self._error(HTTPStatus.BAD_REQUEST, str(exc))
            except (ValueError, TypeError) as exc:
                self._error(HTTPStatus.BAD_REQUEST, str(exc))
            except LookupError as exc:
                self._error(HTTPStatus.NOT_FOUND, str(exc))
            except OverflowError as exc:
                self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, str(exc))

        def _static(self, path: str):
            if path in ("", "/"):
                path = "/index.html"
            elif path.startswith("/static/"):
                path = path[len("/static"):]
            target = (STATIC_DIR / path.lstrip("/")).resolve()
            if not target.is_file() or STATIC_DIR not in target.parents:
                return self._error(HTTPStatus.NOT_FOUND, "Not found")
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            self._send(200, target.read_bytes(), ctype, {"Cache-Control": "no-cache"})

        # -- routes ----------------------------------------------------------
        def do_GET(self):
            self._dispatch(
                {
                    "/healthz": lambda: self._json({"status": "ok", "version": __version__}),
                    "/api/config": lambda: self._json(
                        {
                            "version": __version__,
                            "workspace": app.data_file.name if app.data_file else None,
                        }
                    ),
                    "/api/reference": lambda: self._json(reference()),
                    "/api/sample": self.sample,
                    "/api/workspace": lambda: self._json(app.read_workspace()),
                }
            )

        do_HEAD = do_GET

        def do_POST(self):
            self._dispatch(
                {
                    "/api/parse": self.parse,
                    "/api/export": self.export,
                    "/api/generate": self.generate,
                }
            )

        def do_PUT(self):
            self._dispatch({"/api/workspace": self.save_workspace})

        def sample(self):
            with open(REFERENCE_CSV, newline="", encoding="utf-8") as fh:
                dialect, records = parse_csv(fh.read())
            self._json({"dialect": dialect.to_json(), "records": records, "filename": REFERENCE_CSV.name})

        def parse(self):
            raw = self._body()
            try:
                text = raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                text = raw.decode("latin-1")
            dialect, records = parse_csv(text)
            self._json({"dialect": dialect.to_json(), "records": records})

        def export(self):
            records, dialect = self._records_and_dialect(self._json_body())
            text = write_csv(records, dialect)
            name = "penguins_lter.csv" if dialect.layout == "lter" else "penguins.csv"
            self._send(
                200,
                text.encode("utf-8"),
                "text/csv; charset=utf-8",
                {"Content-Disposition": f'attachment; filename="{name}"'},
            )

        def generate(self):
            data = self._json_body()
            existing = data.get("existing") or []
            if not isinstance(existing, list):
                raise FormatError("'existing' must be a list.")
            seed = data.get("seed")
            records = generate(
                count=data.get("count", 10),
                species=data.get("species", "mixed"),
                sex=data.get("sex", "random"),
                island=data.get("island", "natural"),
                year=data.get("year", 2010),
                variation=data.get("variation", 1.0),
                seed=None if seed in (None, "") else int(seed),
                existing=[e for e in existing if isinstance(e, dict)],
                date_style=Dialect.from_json(data.get("dialect")).date_style,
            )
            self._json({"records": records})

        def save_workspace(self):
            records, dialect = self._records_and_dialect(self._json_body())
            count = app.write_workspace(records, dialect)
            self._json({"saved": count, "filename": app.data_file.name})

    return Handler


def make_server(host: str = "127.0.0.1", port: int = 8000, data_file: Path | None = None) -> ThreadingHTTPServer:
    app = App(Path(data_file) if data_file else None)
    server = ThreadingHTTPServer((host, port), make_handler(app))
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Penguin character creator")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    parser.add_argument(
        "--data",
        default=os.environ.get("PENGUIN_DATA_FILE") or None,
        help="CSV file to open and save from the browser (created if missing)",
    )
    args = parser.parse_args(argv)
    server = make_server(args.host, args.port, args.data)
    host, port = server.server_address[:2]
    print(f"Penguin character creator on http://{host}:{port}" + (f"  (workspace: {args.data})" if args.data else ""), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
