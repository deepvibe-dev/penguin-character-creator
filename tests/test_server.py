"""The static file server and the files it serves."""

import json
import re
import urllib.error
import urllib.request

from penguin_creator import __version__
from penguin_creator.server import STATIC_DIR


def fetch(base, path, method="GET", data=None):
    req = urllib.request.Request(base + path, method=method, data=data)
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, res.headers, res.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read()


def test_index_and_static(server):
    status, headers, body = fetch(server, "/")
    assert status == 200 and b"<title>Penguin Creator</title>" in body
    assert headers["Content-Type"].startswith("text/html")
    status, headers, body = fetch(server, "/static/js/csv.js")
    assert status == 200 and b"export function parseCsv" in body
    assert headers["Content-Type"].startswith("text/javascript")


def test_data_files_are_served(server):
    status, headers, body = fetch(server, "/static/data/penguins_lter.csv")
    assert status == 200 and headers["Content-Type"].startswith("text/csv")
    assert body.startswith(b"studyName,")
    status, headers, body = fetch(server, "/static/data/reference.json")
    assert status == 200 and headers["Content-Type"].startswith("application/json")
    assert set(json.loads(body)["species"]) == {"Adelie", "Chinstrap", "Gentoo"}


def test_health(server):
    status, _, body = fetch(server, "/healthz")
    assert status == 200
    assert json.loads(body) == {"status": "ok", "version": __version__}


def test_head_has_no_body(server):
    status, headers, body = fetch(server, "/", method="HEAD")
    assert status == 200 and body == b"" and int(headers["Content-Length"]) > 0


def test_path_traversal_is_blocked(server):
    for path in ["/static/../server.py", "/static/%2e%2e/server.py", "/../pyproject.toml", "/static/..%2f__init__.py"]:
        status, _, _ = fetch(server, path)
        assert status == 404, path


def test_unknown_path_is_404(server):
    assert fetch(server, "/api/export")[0] == 404


def test_only_reads_are_allowed(server):
    """The app is static: nothing is ever sent to the server."""
    for method in ["POST", "PUT", "DELETE"]:
        status, headers, _ = fetch(server, "/", method=method, data=b"x")
        assert status == 405, method
        assert headers["Allow"] == "GET, HEAD"


def test_every_referenced_static_asset_exists():
    """No build step and no CDN: everything the page loads must be vendored."""
    html = (STATIC_DIR / "index.html").read_text()
    refs = re.findall(r'(?:src|href)="/static/([^"]+)"', html)
    css = (STATIC_DIR / "css" / "style.css").read_text()
    refs += ["css/" + u for u in re.findall(r'url\("([^"]+)"\)', css)]
    for js in (STATIC_DIR / "js").glob("*.js"):
        text = js.read_text()
        refs += ["js/" + m for m in re.findall(r'from "\./([^"]+)"', text)]
        refs += [m.removeprefix("/static/") for m in re.findall(r'"(/static/[^"]+)"', text)]
    assert refs
    for ref in refs:
        assert (STATIC_DIR / ref).resolve().is_file(), ref
    assert not re.findall(r'(?:src|href)="(?:https?:)?//', html), "external resources are not allowed"
    assert "@import" not in css
