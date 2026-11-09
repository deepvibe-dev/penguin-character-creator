"""Run the app's JavaScript in a real headless Chrome from pytest.

The CSV reader/writer and the generator live in the browser, so the
compatibility tests have to run them there. This drives Chrome directly over
the DevTools protocol (no Node.js, no Playwright): start Chrome with remote
debugging, open the app, and evaluate JavaScript in the page.
"""

from __future__ import annotations

import contextlib
import glob
import itertools
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from websockets.sync.client import connect

CANDIDATES = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
]


class JSError(Exception):
    """An exception thrown by the evaluated JavaScript; ``name`` is the JS error class."""

    def __init__(self, name: str, message: str):
        super().__init__(f"{name}: {message}")
        self.name = name
        self.message = message


def find_chrome() -> str | None:
    if os.environ.get("CHROME_BIN"):
        return os.environ["CHROME_BIN"]
    for name in CANDIDATES:
        if path := shutil.which(name):
            return path
    # Playwright's browser cache, if present on this machine
    for path in sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux64/chrome")) + sorted(
        glob.glob(str(Path.home() / ".cache/ms-playwright/chromium-*/chrome-linux*/chrome"))
    ):
        return path
    return None


class Browser:
    """One headless Chrome with one page open on ``url``."""

    def __init__(self, url: str, chrome: str):
        self.profile = tempfile.mkdtemp(prefix="penguin-chrome-")
        self.proc = subprocess.Popen(
            [
                chrome,
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--remote-debugging-port=0",
                f"--user-data-dir={self.profile}",
                url,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        port = self._devtools_port()
        page = None
        for _ in range(100):
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list") as res:
                pages = [t for t in json.load(res) if t.get("type") == "page" and t.get("url", "").startswith(url)]
            if pages:
                page = pages[0]
                break
            time.sleep(0.1)
        if not page:
            raise RuntimeError("Chrome did not open the app")
        self._stack = contextlib.ExitStack()
        self.ws = self._stack.enter_context(connect(page["webSocketDebuggerUrl"], max_size=None, open_timeout=10))
        self.ids = itertools.count(1)
        for _ in range(100):
            if self._evaluate("document.readyState") == "complete":
                break
            time.sleep(0.1)

    def _devtools_port(self) -> int:
        marker = Path(self.profile) / "DevToolsActivePort"
        for _ in range(200):
            if marker.exists() and marker.read_text().strip():
                return int(marker.read_text().splitlines()[0])
            if self.proc.poll() is not None:
                raise RuntimeError("Chrome exited during start-up")
            time.sleep(0.05)
        raise RuntimeError("Chrome did not start its DevTools server")

    def _evaluate(self, expression: str):
        msg_id = next(self.ids)
        self.ws.send(
            json.dumps(
                {
                    "id": msg_id,
                    "method": "Runtime.evaluate",
                    "params": {"expression": expression, "awaitPromise": True, "returnByValue": True},
                }
            )
        )
        while True:
            reply = json.loads(self.ws.recv(timeout=60))
            if reply.get("id") == msg_id:
                break
        if "error" in reply:
            raise RuntimeError(reply["error"])
        result = reply["result"]
        if "exceptionDetails" in result:
            exc = result["exceptionDetails"].get("exception", {})
            name = exc.get("className") or "Error"
            text = exc.get("description") or result["exceptionDetails"].get("text", "")
            message = text.split("\n")[0].split(": ", 1)[-1]
            raise JSError(name, message)
        return result["result"].get("value")

    def run(self, body: str, **args):
        """Run an async JS function body with the app's modules in scope.

        In scope: ``csv`` (static/js/csv.js), ``gen`` (static/js/generator.js),
        ``ref`` (static/data/reference.json) and ``args`` (the keyword arguments,
        passed as JSON). Whatever the body returns comes back as Python data.
        """
        expression = f"""(async () => {{
            const csv = await import('/static/js/csv.js');
            const gen = await import('/static/js/generator.js');
            window.__ref ??= await (await fetch('/static/data/reference.json')).json();
            const ref = window.__ref;
            const args = {json.dumps(args)};
            {body}
        }})()"""
        return self._evaluate(expression)

    def close(self):
        try:
            self._stack.close()
        finally:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            shutil.rmtree(self.profile, ignore_errors=True)
