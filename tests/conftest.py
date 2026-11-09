import os
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from browser import Browser, find_chrome  # noqa: E402

from penguin_creator.server import make_server  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"

# The three published flavours of the Palmer penguins CSV:
#  * penguins_lter.csv  - raw LTER columns, M/D/YY dates, empty NAs, CRLF, no final newline (Kaggle)
#  * penguins-raw.csv   - raw LTER columns, ISO dates, "NA" (R / Python palmerpenguins package)
#  * penguins.csv       - simplified 8 columns (R / Python palmerpenguins package)
KAGGLE_LTER = ROOT / "penguin_creator" / "static" / "data" / "penguins_lter.csv"
R_RAW = FIXTURES / "penguins-raw.csv"
R_SIMPLE = FIXTURES / "penguins.csv"
ALL_ORIGINALS = [KAGGLE_LTER, R_RAW, R_SIMPLE]


def read_text(path: Path) -> str:
    with open(path, newline="", encoding="utf-8") as fh:
        return fh.read()


@pytest.fixture(params=ALL_ORIGINALS, ids=lambda p: p.name)
def original_path(request) -> Path:
    return request.param


@pytest.fixture(scope="session")
def server():
    """The real app server on a free port; yields its base URL."""
    srv = make_server("127.0.0.1", 0)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    host, port = srv.server_address[:2]
    yield f"http://{host}:{port}"
    srv.shutdown()
    srv.server_close()


@pytest.fixture(scope="session")
def js(server):
    """A headless Chrome with the app open; ``js.run(body, **args)`` evaluates JavaScript in it."""
    chrome = find_chrome()
    if not chrome:
        if os.environ.get("CI"):
            pytest.fail("Chrome is required for the browser tests (set CHROME_BIN)")
        pytest.skip("Chrome/Chromium not found (set CHROME_BIN to run the browser tests)")
    browser = Browser(f"{server}/", chrome)
    yield browser
    browser.close()
