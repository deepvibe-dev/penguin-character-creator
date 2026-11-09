from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"

# The three published flavours of the Palmer penguins CSV:
#  * penguins_lter.csv  - raw LTER columns, M/D/YY dates, empty NAs, CRLF, no final newline (Kaggle)
#  * penguins-raw.csv   - raw LTER columns, ISO dates, "NA" (R / Python palmerpenguins package)
#  * penguins.csv       - simplified 8 columns (R / Python palmerpenguins package)
KAGGLE_LTER = ROOT / "penguin_creator" / "data" / "penguins_lter.csv"
R_RAW = FIXTURES / "penguins-raw.csv"
R_SIMPLE = FIXTURES / "penguins.csv"
ALL_ORIGINALS = [KAGGLE_LTER, R_RAW, R_SIMPLE]


def read_text(path: Path) -> str:
    with open(path, newline="", encoding="utf-8") as fh:
        return fh.read()


@pytest.fixture(params=ALL_ORIGINALS, ids=lambda p: p.name)
def original_path(request) -> Path:
    return request.param
