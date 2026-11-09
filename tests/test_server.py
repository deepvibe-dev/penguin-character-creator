import json
import threading
import urllib.error
import urllib.request

import pytest

from conftest import KAGGLE_LTER, R_SIMPLE, read_text
from penguin_creator import __version__
from penguin_creator.server import make_server


@pytest.fixture
def server(tmp_path):
    srv = make_server("127.0.0.1", 0, tmp_path / "colony.csv")
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    host, port = srv.server_address[:2]
    yield f"http://{host}:{port}", tmp_path / "colony.csv"
    srv.shutdown()
    srv.server_close()


def call(base, path, body=None, method=None, content_type="application/json"):
    data = None
    if body is not None:
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req) as res:
            raw = res.read()
            ctype = res.headers.get("Content-Type", "")
            return res.status, (json.loads(raw) if "json" in ctype else raw.decode())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def test_index_and_static(server):
    base, _ = server
    status, html = call(base, "/")
    assert status == 200 and "<title>Penguin Creator</title>" in html
    status, js = call(base, "/static/js/sprite.js")
    assert status == 200 and "penguinPixels" in js


def test_path_traversal_is_blocked(server):
    base, _ = server
    status, _ = call(base, "/static/../server.py")
    assert status == 404
    status, _ = call(base, "/static/%2e%2e/server.py")
    assert status == 404


def test_health_and_reference(server):
    base, _ = server
    assert call(base, "/healthz") == (200, {"status": "ok", "version": __version__})
    status, ref = call(base, "/api/reference")
    assert status == 200
    assert set(ref["species"]) == {"Adelie", "Chinstrap", "Gentoo"}
    gentoo = ref["species"]["Gentoo"]["measures"]["Body Mass (g)"]
    assert gentoo["p05"] < gentoo["mean"] < gentoo["p95"]


def test_parse_and_export_round_trip(server):
    base, _ = server
    text = read_text(KAGGLE_LTER)
    status, parsed = call(base, "/api/parse", text, content_type="text/csv")
    assert status == 200 and len(parsed["records"]) == 344
    status, csv_text = call(base, "/api/export", {"records": parsed["records"], "dialect": parsed["dialect"]})
    assert status == 200
    assert csv_text == text


def test_export_converts_layout(server):
    base, _ = server
    _, parsed = call(base, "/api/sample")
    status, csv_text = call(base, "/api/export", {**parsed, "layout": "simple"})
    assert status == 200
    assert sorted(csv_text.splitlines()) == sorted(read_text(R_SIMPLE).splitlines())


def test_bad_csv_is_a_400(server):
    base, _ = server
    status, body = call(base, "/api/parse", "foo,bar\n1,2\n", content_type="text/csv")
    assert status == 400 and "Palmer" in body["error"]


def test_generate(server):
    base, _ = server
    status, body = call(base, "/api/generate", {"count": 25, "species": "Chinstrap", "seed": 1})
    assert status == 200 and len(body["records"]) == 25
    status, body = call(base, "/api/generate", {"count": -1})
    assert status == 400


def test_workspace_save_and_load(server):
    base, path = server
    status, empty = call(base, "/api/workspace")
    assert status == 200 and empty["records"] == []
    _, sample = call(base, "/api/sample")
    status, saved = call(base, "/api/workspace", {**sample}, method="PUT")
    assert status == 200 and saved["saved"] == 344
    assert read_text(path) == read_text(KAGGLE_LTER)
    # second save keeps a backup of the previous version
    sample["records"][0]["Comments"] = "edited"
    call(base, "/api/workspace", sample, method="PUT")
    assert path.with_suffix(".csv.bak").exists()
    _, loaded = call(base, "/api/workspace")
    assert loaded["records"][0]["Comments"] == "edited"


def test_every_referenced_static_asset_exists():
    """No build step and no CDN: everything the page loads must be vendored."""
    import re

    from penguin_creator.server import STATIC_DIR

    html = (STATIC_DIR / "index.html").read_text()
    refs = re.findall(r'(?:src|href)="/static/([^"]+)"', html)
    css = (STATIC_DIR / "css" / "style.css").read_text()
    refs += ["css/" + u for u in re.findall(r'url\("([^"]+)"\)', css)]
    for js in (STATIC_DIR / "js").glob("*.js"):
        refs += ["js/" + m for m in re.findall(r'from "\./([^"]+)"', js.read_text())]
    assert refs
    for ref in refs:
        assert (STATIC_DIR / ref).resolve().is_file(), ref
    assert not re.findall(r'(?:src|href)="(?:https?:)?//', html), "external resources are not allowed"
    assert "@import" not in css
