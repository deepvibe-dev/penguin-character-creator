"""Compatibility of the creator's CSV output with the original Palmer penguins files.

"Compatible" is checked in three ways:

1. Byte-for-byte round trips: reading an original file and writing it back
   without edits reproduces the file exactly.
2. Cross-layout conversion reproduces the official derived dataset.
3. Files with *new* penguins load in pandas with the same columns, dtypes and
   category values as the originals, so existing analysis code keeps working.
"""

import io

import pandas as pd
import pytest

from conftest import ALL_ORIGINALS, KAGGLE_LTER, R_RAW, R_SIMPLE, read_text
from penguin_creator.dataset import (
    LTER_COLUMNS,
    NUMERIC_PRECISION,
    SIMPLE_COLUMNS,
    Dialect,
    FormatError,
    convert_dialect,
    format_number,
    new_record,
    parse_csv,
    write_csv,
)
from penguin_creator.generator import generate


# --- 1. round trips --------------------------------------------------------


def test_round_trip_is_byte_identical(original_path):
    text = read_text(original_path)
    dialect, records = parse_csv(text)
    assert len(records) == 344
    assert write_csv(records, dialect) == text


def test_round_trip_survives_json(original_path):
    """The browser receives dialect + records as JSON and sends them back."""
    import json

    text = read_text(original_path)
    dialect, records = parse_csv(text)
    payload = json.loads(json.dumps({"dialect": dialect.to_json(), "records": records}))
    assert write_csv(payload["records"], Dialect.from_json(payload["dialect"])) == text


@pytest.mark.parametrize("path", [KAGGLE_LTER, R_RAW], ids=lambda p: p.name)
def test_number_format_reproduces_every_original_value(path):
    """New values are written with the dataset's own precision rules.

    The R package's raw file contains float artefacts such as
    ``-26.695430000000002``; those are kept verbatim on round trips (see above),
    so for that file only the numeric value has to match.
    """
    _, records = parse_csv(read_text(path))
    for record in records:
        for col, precision in NUMERIC_PRECISION.items():
            if record[col]:
                formatted = format_number(float(record[col]), precision)
                if path == KAGGLE_LTER:
                    assert formatted == record[col]
                else:
                    assert float(formatted) == pytest.approx(float(record[col]), abs=1e-9)


def test_seaborn_variant_round_trips():
    """seaborn's penguins.csv: no year, Title-case sex, floats with .0, empty NAs."""
    text = (
        "species,island,bill_length_mm,bill_depth_mm,flipper_length_mm,body_mass_g,sex\n"
        "Adelie,Torgersen,39.1,18.7,181.0,3750.0,Male\n"
        "Adelie,Torgersen,,,,,\n"
        "Gentoo,Biscoe,46.1,13.2,211.0,4500.0,Female\n"
    )
    dialect, records = parse_csv(text)
    assert dialect.layout == "simple"
    assert dialect.sex_style == "title"
    assert dialect.float_style == "decimal"
    assert write_csv(records, dialect) == text
    # adding a penguin keeps the seaborn style
    records.append(new_record(Species="Chinstrap penguin (Pygoscelis antarctica)", Island="Dream",
                              **{"Culmen Length (mm)": "49", "Culmen Depth (mm)": "18.5",
                                 "Flipper Length (mm)": "195", "Body Mass (g)": "3700", "Sex": "FEMALE"}))
    assert write_csv(records, dialect).endswith("Chinstrap,Dream,49.0,18.5,195.0,3700.0,Female\n")


def test_index_column_is_kept_and_renumbered():
    text = (
        '"rowid","species","island","bill_length_mm","bill_depth_mm","flipper_length_mm","body_mass_g","sex","year"\n'
    ).replace('"', "") + "1,Adelie,Torgersen,39.1,18.7,181,3750,male,2007\n"
    dialect, records = parse_csv(text)
    assert dialect.index_column == "rowid"
    records.append(dict(records[0]))
    out = write_csv(records, dialect)
    assert out.splitlines()[-1].startswith("2,Adelie")


# --- 2. conversion between layouts -----------------------------------------


def test_r_raw_to_simple_matches_official_penguins_csv():
    dialect, records = parse_csv(read_text(R_RAW))
    simple = write_csv(records, convert_dialect(dialect, "simple"))
    assert simple == read_text(R_SIMPLE)


def test_kaggle_lter_to_simple_matches_official_rows():
    # the Kaggle file lists species in a different order, so compare row sets
    dialect, records = parse_csv(read_text(KAGGLE_LTER))
    simple = write_csv(records, convert_dialect(dialect, "simple"))
    assert sorted(simple.splitlines()) == sorted(read_text(R_SIMPLE).splitlines())


def test_simple_to_lter_has_all_raw_columns():
    dialect, records = parse_csv(read_text(R_SIMPLE))
    lter = write_csv(records, convert_dialect(dialect, "lter"))
    df = pd.read_csv(io.StringIO(lter))
    assert list(df.columns) == LTER_COLUMNS
    assert df["Species"].iloc[0] == "Adelie Penguin (Pygoscelis adeliae)"
    assert df["studyName"].iloc[0] == "PAL0708"
    assert len(df) == 344


# --- 3. new penguins load like the originals --------------------------------


def _extended(path, layout=None):
    dialect, records = parse_csv(read_text(path))
    records += generate(1000, seed=7, existing=records, date_style=dialect.date_style)
    if layout:
        dialect = convert_dialect(dialect, layout)
    return dialect, write_csv(records, dialect)


@pytest.mark.parametrize("path", ALL_ORIGINALS, ids=lambda p: p.name)
def test_extended_dataset_loads_in_pandas_like_the_original(path):
    original = pd.read_csv(path)
    _, text = _extended(path)
    extended = pd.read_csv(io.StringIO(text))

    assert list(extended.columns) == list(original.columns)
    assert dict(extended.dtypes) == dict(original.dtypes)
    assert len(extended) == len(original) + 1000
    # the original rows are untouched
    pd.testing.assert_frame_equal(extended.iloc[: len(original)].reset_index(drop=True), original)
    # categorical columns only use values downstream code already knows
    for col in ["Species", "Island", "Region", "Stage", "Clutch Completion", "Sex", "species", "island", "sex"]:
        if col in original:
            known = set(original[col].dropna())
            assert set(extended[col].dropna()) <= known, col


@pytest.mark.parametrize("path", ALL_ORIGINALS, ids=lambda p: p.name)
def test_extended_dataset_converts_to_simple_like_palmerpenguins(path):
    _, text = _extended(path, layout="simple")
    df = pd.read_csv(io.StringIO(text))
    official = pd.read_csv(R_SIMPLE)
    assert list(df.columns) == SIMPLE_COLUMNS
    assert dict(df.dtypes) == dict(official.dtypes)
    assert set(df["species"]) == {"Adelie", "Chinstrap", "Gentoo"}
    assert set(df["sex"].dropna()) == {"male", "female"}


def test_extended_dataset_supports_typical_analysis():
    """A typical palmerpenguins workflow: group means per species."""
    _, text = _extended(R_SIMPLE)
    df = pd.read_csv(io.StringIO(text))
    means = df.groupby("species")["body_mass_g"].mean()
    assert means["Gentoo"] > means["Adelie"]
    assert means["Gentoo"] > means["Chinstrap"]
    assert df.dropna().shape[0] > 1300


# --- edits, appends and forward compatibility --------------------------------


def test_edit_existing_penguin():
    text = read_text(KAGGLE_LTER)
    dialect, records = parse_csv(text)
    records[0]["Body Mass (g)"] = "3900"
    records[0]["Comments"] = "Re-weighed, see notebook 3"
    out = write_csv(records, dialect)
    _, again = parse_csv(out)
    assert again[0]["Body Mass (g)"] == "3900"
    assert again[0]["Comments"] == "Re-weighed, see notebook 3"
    # every other line is unchanged
    assert out.splitlines()[2:] == text.splitlines()[2:]


def test_append_one_file_to_another():
    d1, kaggle = parse_csv(read_text(KAGGLE_LTER))
    _, r_raw = parse_csv(read_text(R_RAW))
    out = write_csv(kaggle + r_raw, d1)
    df = pd.read_csv(io.StringIO(out))
    assert len(df) == 688
    assert dict(df.dtypes) == dict(pd.read_csv(KAGGLE_LTER).dtypes)
    # appended dates are rewritten in the target file's style
    assert "2007-11-11" not in out


def test_unknown_columns_are_preserved():
    text = read_text(R_SIMPLE)
    header, rest = text.split("\n", 1)
    rows = rest.rstrip("\n").split("\n")
    text = "\n".join([header + ",tag_colour"] + [r + ",blue" for r in rows]) + "\n"
    dialect, records = parse_csv(text)
    assert records[0]["extra"] == {"tag_colour": "blue"}
    assert write_csv(records, dialect) == text
    lter = write_csv(records, convert_dialect(dialect, "lter"))
    assert lter.splitlines()[0].endswith(",Comments,tag_colour")


def test_quotes_and_commas_in_comments():
    dialect, records = parse_csv(read_text(KAGGLE_LTER))
    records[0]["Comments"] = 'Said "hello", then left'
    _, again = parse_csv(write_csv(records, dialect))
    assert again[0]["Comments"] == 'Said "hello", then left'


# --- rejection of bad input ------------------------------------------------


def test_rejects_non_penguin_csv():
    with pytest.raises(FormatError):
        parse_csv("a,b,c\n1,2,3\n")


def test_rejects_empty_file():
    with pytest.raises(FormatError):
        parse_csv("")


def test_rejects_ragged_rows():
    header = ",".join(SIMPLE_COLUMNS)
    with pytest.raises(FormatError):
        parse_csv(header + "\nAdelie,Dream\n")


def test_rejects_non_numeric_measurements():
    dialect, records = parse_csv(read_text(R_SIMPLE))
    records[0]["Body Mass (g)"] = "heavy"
    with pytest.raises(FormatError):
        write_csv(records, dialect)


def test_rejects_line_breaks_in_values():
    dialect, records = parse_csv(read_text(KAGGLE_LTER))
    records[0]["Comments"] = "two\nlines"
    with pytest.raises(FormatError):
        write_csv(records, dialect)


def test_bom_is_accepted():
    text = read_text(R_SIMPLE)
    dialect, records = parse_csv("﻿" + text)
    assert write_csv(records, dialect) == text
