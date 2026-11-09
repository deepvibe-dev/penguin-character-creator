# Penguin Creator

A pixel-art character creator for building alternative versions of the
[Palmer penguins](https://allisonhorst.github.io/palmerpenguins/) dataset.
Open the original CSV (or your own), design penguins one by one, hatch
whole colonies at once, browse everyone on a map of the islands, and save
a file that any existing Palmer penguins code can read.

Everything runs in your browser: files you open are read on your machine and
downloads are built there too. The Python server only hands out the static
files, so nothing you edit is ever uploaded.

## Features

- **Pixel-art penguins that follow the data.** Body mass sets the bird's
  width, flipper length its height and flippers, culmen length and depth
  its bill. Species sets the plumage, bill and feet. The island sets the
  backdrop, a full clutch puts two eggs in the nest, δ15N picks krill or
  fish, and δ13C tints the water.
- **Nudged towards plausible penguins.** Each slider shows the band of real
  measurements for the chosen species and sex: the central 95%, the full
  observed range, and the average. A field-guide box explains anything
  unusual ("No Gentoo was ever recorded on Dream"). The ledger flags
  unusual (`!`) and implausible (`✗`) penguins.
- **Hatch a colony.** Generate up to 10,000 penguins at once. Values are
  sampled from the real per-species, per-sex measurements and keep their
  natural correlations. Nest-mates come in male/female pairs on islands
  where the species really lives, and sample numbers and nest IDs continue
  from the existing data. A seed makes runs repeatable.
- **Edit existing penguins.** Click a row in the ledger (or a bird on the
  map) to edit it. You can also duplicate, delete, or bulk-delete, and
  filter by species, island, plausibility or text.
- **Colony map.** Every penguin in the file on a schematic map of the
  Palmer Archipelago: Torgersen just off Palmer Station on Anvers Island,
  Dream to the north-west and Biscoe to the south-east. Each island holds
  one sub-colony per species and grows with its population. The camera
  works like a city-builder's: drag (with inertia), WASD or arrow keys,
  edge scrolling, and smooth mouse-wheel zoom toward the pointer.
- **Read, edit and append CSVs.** Open a file, append another one to it,
  and download the result. The open colony is also kept in the browser's
  local storage, so a reload doesn't lose your work.

## Compatibility with the Palmer penguins format

Both published column layouts are supported, along with their small
stylistic variants:

| Layout | Example files |
| --- | --- |
| Raw LTER, 17 columns (`studyName` … `Comments`) | Kaggle `penguins_lter.csv` (M/D/YY dates, empty NAs, CRLF); R/Python `penguins_raw` (ISO dates, `NA`) |
| palmerpenguins, 8 columns (`species` … `year`) | R/Python `penguins.csv` (`NA`, lowercase sex); seaborn's `penguins.csv` (no `year`, `Male`, `181.0`) |

Guarantees, all covered by `tests/test_compatibility.py`. Those tests run
the app's own JavaScript reader and writer (`static/js/csv.js`) in headless
Chrome and check the output with pandas:

- Reading a file and saving it without changes gives **byte-identical**
  output for every original file (quoting, NA token, date style, line
  endings and the final newline are all kept).
- New and edited penguins are written in the file's own style, so
  `pandas.read_csv` gives the **same columns and dtypes**, and categorical
  columns only contain values existing code already knows.
- Converting the raw layout to the 8-column layout reproduces the official
  `penguins.csv` exactly.
- Columns the app doesn't know about are kept as-is (forward
  compatibility), and a leading row-index column is renumbered.

Choose **Raw LTER** or **palmerpenguins** next to *Download CSV* to convert
between layouts.

## Running it

Requires Python 3.15. Everything is managed with
[uv](https://docs.astral.sh/uv/), which installs the right Python for you.
The server only uses the Python standard library. The front end is plain ES
modules with vendored fonts: no Node.js, no JS package manager, no CDN.

```bash
uv run penguin-creator
```

Then open <http://127.0.0.1:8000>. Options: `--host` and `--port`, or the
environment variables `HOST` and `PORT`.

The server only answers `GET` and `HEAD` (anything else gets a 405), so it
sits happily behind web application firewalls and strict ingress policies.

### Docker

```bash
docker build -t penguin-creator .
```

```bash
docker run --rm -p 8000:8000 penguin-creator
```

The container serves on port 8000, runs as a non-root user, needs no volume
and has a health check on `/healthz`.

Released images are published for `linux/amd64` and `linux/arm64`:

```bash
docker run --rm -p 8000:8000 ghcr.io/deepvibe-dev/penguin-character-creator:latest
```

### Tests

```bash
uv run pytest
```

The CSV and generator tests drive a headless Chrome over the DevTools
protocol (`tests/browser.py`), with no Node.js or Playwright involved. The
tests look for `google-chrome` or `chromium` on the `PATH`; set `CHROME_BIN`
to point at another binary. Without Chrome those tests are skipped locally,
and they fail in CI.

`static/data/reference.json` (the slider bands and generator models) is
built from the original CSV. After changing `penguin_creator/reference.py`,
regenerate it and commit the result; a test fails if it is stale:

```bash
uv run python -m penguin_creator.reference
```

## Versioning and commits

Versions follow [Semantic Versioning](https://semver.org/) and are derived
automatically from [Conventional Commits](https://www.conventionalcommits.org/)
using [commitizen](https://commitizen-tools.github.io/commitizen/):

| Commit | Release |
| --- | --- |
| `fix: ...` | patch (`0.1.0` → `0.1.1`) |
| `feat: ...` | minor (`0.1.1` → `0.2.0`) |
| `feat!: ...` or a `BREAKING CHANGE:` footer | major (minor while the version is `0.x`) |
| `docs:`, `chore:`, `ci:`, `test:`, `build:`, `refactor:`, `style:` | no release |

Every commit in a pull request, and the PR title (used as the squash-merge
message), must follow the convention. To check locally:

```bash
uvx --from commitizen cz check --rev-range origin/main..HEAD
```

Don't bump versions by hand. On every push to `main`, CI works out the next
version, updates `pyproject.toml`, `penguin_creator/__init__.py`, `uv.lock`
and `CHANGELOG.md`, then commits `chore(release): vX.Y.Z`, tags `vX.Y.Z` and
creates a GitHub release.

## CI/CD

`.github/workflows/ci.yml` does the following:

1. **Pull requests:** checks that the PR title and every commit are
   Conventional Commits.
2. **Every run:** runs the tests on Python 3.15 and checks that `uv.lock`
   is current. Builds the image for `linux/amd64` and `linux/arm64` (arm64
   under QEMU) and smoke-tests each one: architecture, health check, and
   that the page, the scripts and the data files are served unchanged.
3. **Pushes to `main`:** releases (see above), then publishes one
   multi-arch image to `ghcr.io/deepvibe-dev/penguin-character-creator`.
   A release is tagged `X.Y.Z`, `X.Y`, `X` (from 1.0 on) and `latest`, and
   every `main` build is also tagged `main` and `sha-<commit>`.

## Project layout

```
penguin_creator/
  server.py         stdlib static file server
  reference.py      builds static/data/reference.json from the original data
  static/
    index.html, css/, fonts/
    js/csv.js       CSV layouts, dialect detection, lossless read/write
    js/generator.js plausible batch generation (multivariate normal per species/sex)
    js/sprite.js, colony.js, camera.js, app.js   drawing, map, camera, UI
    data/           the original Palmer penguins CSV and reference.json
tests/
  browser.py        runs the app's JavaScript in headless Chrome
  test_*.py         compatibility, generator, reference and server tests
  fixtures/         the official palmerpenguins CSVs
```

## Credits

- Data: Gorman KB, Williams TD, Fraser WR (2014), *PLoS ONE* 9(3): e90081,
  via the Palmer Station LTER (CC0). Test fixtures come from the
  `palmerpenguins` package.
- Font: DejaVu Sans Mono (Bitstream Vera licence, see `static/fonts/`).
