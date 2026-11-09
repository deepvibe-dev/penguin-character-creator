"""Reading and writing Palmer penguins CSV files.

Two column layouts exist in the wild and both are supported:

* ``lter``   -- the raw LTER layout (17 columns, ``studyName`` ... ``Comments``).
  Distributed e.g. as ``penguins_lter.csv`` (Kaggle) or ``penguins_raw``
  (R / Python ``palmerpenguins`` package).
* ``simple`` -- the cleaned layout from the ``palmerpenguins`` package
  (``species, island, bill_length_mm, ...``). The seaborn variant without
  ``year`` and with a leading index column are handled as well.

Inside the application every penguin is a *canonical record*: a dict keyed by
the LTER column names plus ``year``. Values are always strings, exactly as they
appear in a file, with ``""`` meaning "missing". Columns that are not part of
either layout are kept verbatim (forward compatibility) and written back.

The :class:`Dialect` records the small stylistic choices of the file that was
read (missing-value token, date style, line endings, ...) so that a file that
is read and written again without edits is byte-for-byte identical.
"""

from __future__ import annotations

import csv
import io
import math
import re
from dataclasses import asdict, dataclass, field
from datetime import date

LTER_COLUMNS = [
    "studyName",
    "Sample Number",
    "Species",
    "Region",
    "Island",
    "Stage",
    "Individual ID",
    "Clutch Completion",
    "Date Egg",
    "Culmen Length (mm)",
    "Culmen Depth (mm)",
    "Flipper Length (mm)",
    "Body Mass (g)",
    "Sex",
    "Delta 15 N (o/oo)",
    "Delta 13 C (o/oo)",
    "Comments",
]

SIMPLE_COLUMNS = [
    "species",
    "island",
    "bill_length_mm",
    "bill_depth_mm",
    "flipper_length_mm",
    "body_mass_g",
    "sex",
    "year",
]

# simple column -> canonical (LTER) key
SIMPLE_TO_CANONICAL = {
    "species": "Species",
    "island": "Island",
    "bill_length_mm": "Culmen Length (mm)",
    "bill_depth_mm": "Culmen Depth (mm)",
    "flipper_length_mm": "Flipper Length (mm)",
    "body_mass_g": "Body Mass (g)",
    "sex": "Sex",
    "year": "year",
}

CANONICAL_KEYS = LTER_COLUMNS + ["year"]

SPECIES = {
    # short name -> full LTER name
    "Adelie": "Adelie Penguin (Pygoscelis adeliae)",
    "Chinstrap": "Chinstrap penguin (Pygoscelis antarctica)",
    "Gentoo": "Gentoo penguin (Pygoscelis papua)",
}
SPECIES_SHORT = {v: k for k, v in SPECIES.items()}
ISLANDS = ["Biscoe", "Dream", "Torgersen"]
SEXES = ["MALE", "FEMALE"]

# Number of decimals used by the original dataset for each measurement.
NUMERIC_PRECISION = {
    "Culmen Length (mm)": 1,
    "Culmen Depth (mm)": 1,
    "Flipper Length (mm)": 0,
    "Body Mass (g)": 0,
    "Delta 15 N (o/oo)": 5,
    "Delta 13 C (o/oo)": 5,
}
INTEGER_COLUMNS = {"Sample Number", "year"}

INDEX_COLUMN_NAMES = {"", "rowid", "Unnamed: 0", "index"}


class FormatError(ValueError):
    """Raised when a CSV is not a Palmer penguins file or contains bad values."""


@dataclass
class Dialect:
    layout: str = "lter"  # "lter" | "simple"
    header: list[str] = field(default_factory=lambda: list(LTER_COLUMNS))
    na: str = ""  # token written for missing values
    newline: str = "\n"
    trailing_newline: bool = False
    date_style: str = "mdy"  # "mdy" (11/11/07) | "iso" (2007-11-11)
    sex_style: str = "upper"  # "upper" | "lower" | "title"
    float_style: str = "plain"  # "plain" (181) | "decimal" (181.0, seaborn)
    index_column: str | None = None  # name of a leading row index column

    def to_json(self) -> dict:
        return asdict(self)

    @classmethod
    def from_json(cls, data: dict | None) -> "Dialect":
        data = dict(data or {})
        known = {k: v for k, v in data.items() if k in cls.__dataclass_fields__}
        return cls(**known)


# ---------------------------------------------------------------------------
# number / date helpers


def format_number(value: float, precision: int) -> str:
    """Format a number the way the original dataset does.

    Rounded to ``precision`` decimals, trailing zeros stripped
    (``18.0 -> "18"``, ``39.10 -> "39.1"``, ``3750.0 -> "3750"``).
    """
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    text = f"{round(float(value), precision):.{precision}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text == "-0":
        text = "0"
    return text


def parse_number(text: str) -> float | None:
    text = (text or "").strip()
    if text == "" or text.upper() == "NA":
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    return value


_MDY = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})$")
_ISO = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def parse_date(text: str) -> date | None:
    text = (text or "").strip()
    m = _MDY.match(text)
    if m:
        month, day, year = (int(g) for g in m.groups())
        if year < 100:
            year += 2000
        try:
            return date(year, month, day)
        except ValueError:
            return None
    m = _ISO.match(text)
    if m:
        try:
            return date(*(int(g) for g in m.groups()))
        except ValueError:
            return None
    return None


def format_date(value: date, style: str) -> str:
    if style == "iso":
        return value.isoformat()
    return f"{value.month}/{value.day}/{value.year % 100:02d}"


def study_name_for_year(year: int) -> str:
    """2007 -> ``PAL0708`` (field seasons span two calendar years)."""
    return f"PAL{year % 100:02d}{(year + 1) % 100:02d}"


def year_of(record: dict) -> str:
    """Best-effort year of a canonical record (as used by ``palmerpenguins``)."""
    if record.get("year"):
        return record["year"]
    d = parse_date(record.get("Date Egg", ""))
    if d:
        return str(d.year)
    m = re.match(r"^PAL(\d{2})\d{2}$", record.get("studyName", ""))
    if m:
        return str(2000 + int(m.group(1)))
    return ""


def short_species(value: str) -> str:
    if value in SPECIES_SHORT:
        return SPECIES_SHORT[value]
    first = (value or "").split(" ")[0]
    return first if first in SPECIES else value


def full_species(value: str) -> str:
    if value in SPECIES_SHORT:
        return value
    for short, full in SPECIES.items():
        if (value or "").strip().lower() == short.lower():
            return full
    return value


# ---------------------------------------------------------------------------
# reading


def detect_layout(header: list[str]) -> tuple[str, str | None]:
    cols = list(header)
    index_column = None
    if cols and cols[0] in INDEX_COLUMN_NAMES and len(cols) > 1:
        index_column = cols[0]
        cols = cols[1:]
    if all(c in cols for c in LTER_COLUMNS):
        return "lter", index_column
    if all(c in cols for c in SIMPLE_COLUMNS[:7]):
        return "simple", index_column
    missing = [c for c in LTER_COLUMNS if c not in cols]
    raise FormatError(
        "Not a Palmer penguins CSV: expected the LTER columns "
        f"(missing {', '.join(missing[:4])}{'...' if len(missing) > 4 else ''}) "
        "or the simplified palmerpenguins columns (species, island, bill_length_mm, ...)."
    )


def _detect_newline(text: str) -> str:
    return "\r\n" if "\r\n" in text else "\n"


def parse_csv(text: str) -> tuple[Dialect, list[dict]]:
    """Parse CSV text into a :class:`Dialect` and a list of canonical records."""
    if text.startswith("﻿"):
        text = text[1:]
    if not text.strip():
        raise FormatError("The file is empty.")
    newline = _detect_newline(text)
    trailing = text.endswith("\n")
    reader = csv.reader(io.StringIO(text, newline=""))
    try:
        header = next(reader)
    except StopIteration as exc:  # pragma: no cover - guarded above
        raise FormatError("The file is empty.") from exc
    layout, index_column = detect_layout(header)
    raw_rows = [row for row in reader if row]

    dialect = Dialect(
        layout=layout,
        header=list(header),
        newline=newline,
        trailing_newline=trailing,
        index_column=index_column,
    )

    # Sniff the stylistic details from the data itself.
    all_values = [v for row in raw_rows for v in row]
    dialect.na = "NA" if "NA" in all_values else ""

    if layout == "lter":
        date_idx = header.index("Date Egg")
        dates = [r[date_idx] for r in raw_rows if len(r) > date_idx and r[date_idx]]
        if dates and all(_ISO.match(d) for d in dates):
            dialect.date_style = "iso"
        sex_idx = header.index("Sex")
    else:
        sex_idx = header.index("sex")
        if "year" not in header:
            dialect.date_style = "iso"
    sexes = [r[sex_idx] for r in raw_rows if len(r) > sex_idx and r[sex_idx].upper() in SEXES]
    if sexes:
        sample = sexes[0]
        dialect.sex_style = "upper" if sample.isupper() else "lower" if sample.islower() else "title"
    elif layout == "simple":
        dialect.sex_style = "lower"

    if layout == "simple":
        flip_idx = header.index("flipper_length_mm")
        flips = [r[flip_idx] for r in raw_rows if len(r) > flip_idx and r[flip_idx] not in ("", "NA")]
        if flips and all("." in f for f in flips):
            dialect.float_style = "decimal"

    records = []
    for line_no, row in enumerate(raw_rows, start=2):
        if len(row) != len(header):
            raise FormatError(
                f"Line {line_no}: expected {len(header)} fields but found {len(row)}."
            )
        records.append(_row_to_record(dict(zip(header, row)), dialect))
    return dialect, records


def _row_to_record(row: dict, dialect: Dialect) -> dict:
    na = dialect.na
    record = {key: "" for key in CANONICAL_KEYS}
    extras = {}
    for col, value in row.items():
        if na and value == na:
            value = ""
        if col == dialect.index_column:
            continue
        if dialect.layout == "lter" and col in LTER_COLUMNS:
            record[col] = value
        elif dialect.layout == "simple" and col in SIMPLE_TO_CANONICAL:
            key = SIMPLE_TO_CANONICAL[col]
            if key == "Species":
                value = full_species(value)
            elif key == "Sex":
                value = value.upper()
            record[key] = value
        else:
            extras[col] = value
    if dialect.layout == "lter":
        record["year"] = year_of(record)
    else:
        # Fill the LTER-only fields that can be derived, so a conversion
        # to the raw layout is as complete as possible.
        if record["year"]:
            record["studyName"] = study_name_for_year(int(record["year"]))
        record["Region"] = "Anvers"
    record["extra"] = extras
    return record


# ---------------------------------------------------------------------------
# writing


def _validate(record: dict, row_no: int) -> list[str]:
    errors = []
    for col in NUMERIC_PRECISION:
        value = record.get(col, "")
        if value not in ("", ".") and parse_number(value) is None:
            errors.append(f"Row {row_no}: '{col}' must be a number, got {value!r}.")
    for col in INTEGER_COLUMNS:
        value = record.get(col, "")
        if value and not re.fullmatch(r"-?\d+", value):
            errors.append(f"Row {row_no}: '{col}' must be a whole number, got {value!r}.")
    for col, value in record.items():
        if isinstance(value, str) and ("\n" in value or "\r" in value):
            errors.append(f"Row {row_no}: '{col}' must not contain line breaks.")
    return errors


def _style_sex(value: str, dialect: Dialect) -> str:
    if value.upper() not in SEXES:
        return value
    if dialect.sex_style == "lower":
        return value.lower()
    if dialect.sex_style == "title":
        return value.title()
    return value.upper()


def _style_number(value: str, dialect: Dialect) -> str:
    # seaborn-style files write every measurement as a float ("181.0")
    if dialect.float_style == "decimal" and value and "." not in value:
        return value + ".0"
    return value


def record_to_row(record: dict, dialect: Dialect, index: int) -> list[str]:
    extras = record.get("extra") or {}
    out = []
    for col in dialect.header:
        if col == dialect.index_column:
            out.append(str(index))
            continue
        if dialect.layout == "lter" and col in LTER_COLUMNS:
            value = record.get(col, "")
            if col == "studyName" and not value and record.get("year"):
                value = study_name_for_year(int(record["year"]))
            if col == "Date Egg" and value:
                d = parse_date(value)
                value = value if d is None or _date_matches(value, dialect) else format_date(d, dialect.date_style)
        elif dialect.layout == "simple" and col in SIMPLE_TO_CANONICAL:
            key = SIMPLE_TO_CANONICAL[col]
            value = record.get(key, "")
            if key == "Species":
                value = short_species(value)
            elif key == "Sex":
                value = _style_sex(value, dialect) if value.upper() in SEXES else ""
            elif key == "year":
                value = year_of(record)
            elif key in NUMERIC_PRECISION:
                value = _style_number(value, dialect)
        else:
            value = extras.get(col, "")
        if value == "" and dialect.na:
            value = dialect.na
        out.append(value)
    return out


def _date_matches(value: str, dialect: Dialect) -> bool:
    return bool(_ISO.match(value)) if dialect.date_style == "iso" else bool(_MDY.match(value))


def write_csv(records: list[dict], dialect: Dialect | None = None) -> str:
    """Serialize canonical records using ``dialect`` (default: Kaggle-style LTER)."""
    dialect = dialect or Dialect()
    errors = []
    for i, record in enumerate(records, start=1):
        errors.extend(_validate(record, i))
    if errors:
        raise FormatError(" ".join(errors[:10]) + (" ..." if len(errors) > 10 else ""))
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, lineterminator=dialect.newline, quoting=csv.QUOTE_MINIMAL)
    writer.writerow(dialect.header)
    for i, record in enumerate(records, start=1):
        writer.writerow(record_to_row(record, dialect, i))
    text = buf.getvalue()
    if not dialect.trailing_newline and text.endswith(dialect.newline):
        text = text[: -len(dialect.newline)]
    return text


def convert_dialect(dialect: Dialect, layout: str) -> Dialect:
    """Return a dialect for ``layout`` that keeps extra columns of ``dialect``."""
    if layout == dialect.layout:
        return dialect
    extras = [c for c in dialect.header if c not in LTER_COLUMNS and c not in SIMPLE_COLUMNS and c != dialect.index_column]
    if layout == "lter":
        return Dialect(layout="lter", header=LTER_COLUMNS + extras, newline=dialect.newline)
    return Dialect(
        layout="simple",
        header=SIMPLE_COLUMNS + extras,
        na="NA",
        newline="\n",
        trailing_newline=True,
        sex_style="lower",
    )


def new_record(**values) -> dict:
    record = {key: "" for key in CANONICAL_KEYS}
    record["extra"] = {}
    record.update(values)
    return record


def numeric_value(record: dict, col: str) -> float | None:
    return parse_number(record.get(col, ""))
