"""Compatibility of the creator's CSV output with the original Palmer penguins files.

The reader and writer (static/js/csv.js) run in the browser, so these tests run
them in a real headless Chrome (see browser.py) and check the results with
pandas, the way downstream projects consume the data.

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

from browser import JSError
from conftest import ALL_ORIGINALS, KAGGLE_LTER, R_RAW, R_SIMPLE, read_text

LTER_COLUMNS = [
    "studyName", "Sample Number", "Species", "Region", "Island", "Stage", "Individual ID",
    "Clutch Completion", "Date Egg", "Culmen Length (mm)", "Culmen Depth (mm)",
    "Flipper Length (mm)", "Body Mass (g)", "Sex", "Delta 15 N (o/oo)", "Delta 13 C (o/oo)", "Comments",
]  # fmt: skip
SIMPLE_COLUMNS = ["species", "island", "bill_length_mm", "bill_depth_mm", "flipper_length_mm", "body_mass_g", "sex", "year"]


def parse(js, text):
    return js.run("return csv.parseCsv(args.text);", text=text)


def write(js, records, dialect, layout=None):
    return js.run("return csv.writeCsv(args.records, csv.convertDialect(args.dialect, args.layout));",
                  records=records, dialect=dialect, layout=layout)


# --- 1. round trips --------------------------------------------------------


def test_round_trip_is_byte_identical(js, original_path):
    text = read_text(original_path)
    parsed = parse(js, text)
    assert len(parsed["records"]) == 344
    assert write(js, parsed["records"], parsed["dialect"]) == text


def test_round_trip_survives_local_storage(js, original_path):
    """The app keeps the open colony in localStorage as JSON between visits."""
    text = read_text(original_path)
    out = js.run(
        """const p = csv.parseCsv(args.text);
           const restored = JSON.parse(JSON.stringify(p));
           return csv.writeCsv(restored.records, restored.dialect);""",
        text=text,
    )
    assert out == text


@pytest.mark.parametrize("path", [KAGGLE_LTER, R_RAW], ids=lambda p: p.name)
def test_number_format_reproduces_every_original_value(js, path):
    """Edited and new values are written with the dataset's own precision rules.

    The R package's raw file contains float artefacts such as
    ``-26.695430000000002``; those are kept verbatim on round trips (see above),
    so for that file only the numeric value has to match.
    """
    pairs = js.run(
        """const { records } = csv.parseCsv(args.text);
           const out = [];
           for (const r of records) for (const [col, p] of Object.entries(csv.NUMERIC_PRECISION))
             if (r[col]) out.push([r[col], csv.formatNumber(Number(r[col]), p)]);
           return out;""",
        text=read_text(path),
    )
    assert len(pairs) > 1500
    for original, formatted in pairs:
        if path == KAGGLE_LTER:
            assert formatted == original
        else:
            assert float(formatted) == pytest.approx(float(original), abs=1e-9)


def test_seaborn_variant_round_trips(js):
    """seaborn's penguins.csv: no year, Title-case sex, floats with .0, empty NAs."""
    text = (
        "species,island,bill_length_mm,bill_depth_mm,flipper_length_mm,body_mass_g,sex\n"
        "Adelie,Torgersen,39.1,18.7,181.0,3750.0,Male\n"
        "Adelie,Torgersen,,,,,\n"
        "Gentoo,Biscoe,46.1,13.2,211.0,4500.0,Female\n"
    )
    parsed = parse(js, text)
    d = parsed["dialect"]
    assert (d["layout"], d["sex_style"], d["float_style"]) == ("simple", "title", "decimal")
    assert write(js, parsed["records"], d) == text
    # a new penguin is written in the same style
    out = js.run(
        """const p = csv.parseCsv(args.text);
           p.records.push(csv.newRecord({ Species: csv.SPECIES.Chinstrap, Island: "Dream",
             "Culmen Length (mm)": "49", "Culmen Depth (mm)": "18.5", "Flipper Length (mm)": "195",
             "Body Mass (g)": "3700", Sex: "FEMALE" }));
           return csv.writeCsv(p.records, p.dialect);""",
        text=text,
    )
    assert out.endswith("Chinstrap,Dream,49.0,18.5,195.0,3700.0,Female\n")


def test_index_column_is_kept_and_renumbered(js):
    text = "rowid," + ",".join(SIMPLE_COLUMNS) + "\n1,Adelie,Torgersen,39.1,18.7,181,3750,male,2007\n"
    parsed = parse(js, text)
    assert parsed["dialect"]["index_column"] == "rowid"
    out = write(js, parsed["records"] * 2, parsed["dialect"])
    assert out.splitlines()[-1].startswith("2,Adelie")


# --- 2. conversion between layouts -----------------------------------------


def test_r_raw_to_simple_matches_official_penguins_csv(js):
    parsed = parse(js, read_text(R_RAW))
    assert write(js, parsed["records"], parsed["dialect"], "simple") == read_text(R_SIMPLE)


def test_kaggle_lter_to_simple_matches_official_rows(js):
    # the Kaggle file lists species in a different order, so compare row sets
    parsed = parse(js, read_text(KAGGLE_LTER))
    simple = write(js, parsed["records"], parsed["dialect"], "simple")
    assert sorted(simple.splitlines()) == sorted(read_text(R_SIMPLE).splitlines())


def test_simple_to_lter_has_all_raw_columns(js):
    parsed = parse(js, read_text(R_SIMPLE))
    df = pd.read_csv(io.StringIO(write(js, parsed["records"], parsed["dialect"], "lter")))
    assert list(df.columns) == LTER_COLUMNS
    assert df["Species"].iloc[0] == "Adelie Penguin (Pygoscelis adeliae)"
    assert df["studyName"].iloc[0] == "PAL0708"
    assert len(df) == 344


# --- 3. new penguins load like the originals --------------------------------


def extended(js, path, layout=None):
    """The original file plus 1000 hatched penguins, written as the app's download would."""
    return js.run(
        """const p = csv.parseCsv(args.text);
           const born = gen.generate(ref, { count: 1000, seed: 7, existing: p.records, dateStyle: p.dialect.date_style });
           return csv.writeCsv([...p.records, ...born], csv.convertDialect(p.dialect, args.layout));""",
        text=read_text(path),
        layout=layout,
    )


@pytest.mark.parametrize("path", ALL_ORIGINALS, ids=lambda p: p.name)
def test_extended_dataset_loads_in_pandas_like_the_original(js, path):
    original = pd.read_csv(path)
    ext = pd.read_csv(io.StringIO(extended(js, path)))

    assert list(ext.columns) == list(original.columns)
    assert dict(ext.dtypes) == dict(original.dtypes)
    assert len(ext) == len(original) + 1000
    # the original rows are untouched
    pd.testing.assert_frame_equal(ext.iloc[: len(original)].reset_index(drop=True), original)
    # categorical columns only use values downstream code already knows
    for col in ["Species", "Island", "Region", "Stage", "Clutch Completion", "Sex", "species", "island", "sex"]:
        if col in original:
            assert set(ext[col].dropna()) <= set(original[col].dropna()), col


@pytest.mark.parametrize("path", ALL_ORIGINALS, ids=lambda p: p.name)
def test_extended_dataset_converts_to_simple_like_palmerpenguins(js, path):
    df = pd.read_csv(io.StringIO(extended(js, path, layout="simple")))
    official = pd.read_csv(R_SIMPLE)
    assert list(df.columns) == SIMPLE_COLUMNS
    assert dict(df.dtypes) == dict(official.dtypes)
    assert set(df["species"]) == {"Adelie", "Chinstrap", "Gentoo"}
    assert set(df["sex"].dropna()) == {"male", "female"}


def test_extended_dataset_supports_typical_analysis(js):
    """A typical palmerpenguins workflow: group means per species."""
    df = pd.read_csv(io.StringIO(extended(js, R_SIMPLE)))
    means = df.groupby("species")["body_mass_g"].mean()
    assert means["Gentoo"] > means["Adelie"]
    assert means["Gentoo"] > means["Chinstrap"]
    assert df.dropna().shape[0] > 1300


# --- edits, appends and forward compatibility --------------------------------


def test_edit_existing_penguin(js):
    text = read_text(KAGGLE_LTER)
    out = js.run(
        """const p = csv.parseCsv(args.text);
           p.records[0]["Body Mass (g)"] = "3900";
           p.records[0].Comments = "Re-weighed, see notebook 3";
           return csv.writeCsv(p.records, p.dialect);""",
        text=text,
    )
    again = parse(js, out)["records"][0]
    assert again["Body Mass (g)"] == "3900"
    assert again["Comments"] == "Re-weighed, see notebook 3"
    # every other line is unchanged
    assert out.splitlines()[2:] == text.splitlines()[2:]


def test_append_one_file_to_another(js):
    out = js.run(
        """const a = csv.parseCsv(args.kaggle);
           const b = csv.parseCsv(args.raw);
           return csv.writeCsv([...a.records, ...b.records], a.dialect);""",
        kaggle=read_text(KAGGLE_LTER),
        raw=read_text(R_RAW),
    )
    df = pd.read_csv(io.StringIO(out))
    assert len(df) == 688
    assert dict(df.dtypes) == dict(pd.read_csv(KAGGLE_LTER).dtypes)
    # appended dates are rewritten in the target file's style
    assert "2007-11-11" not in out


def test_unknown_columns_are_preserved(js):
    header, rest = read_text(R_SIMPLE).split("\n", 1)
    rows = rest.rstrip("\n").split("\n")
    text = "\n".join([header + ",tag_colour"] + [r + ",blue" for r in rows]) + "\n"
    parsed = parse(js, text)
    assert parsed["records"][0]["extra"] == {"tag_colour": "blue"}
    assert write(js, parsed["records"], parsed["dialect"]) == text
    lter = write(js, parsed["records"], parsed["dialect"], "lter")
    assert lter.splitlines()[0].endswith(",Comments,tag_colour")


def test_quotes_and_commas_in_comments(js):
    comment = js.run(
        """const p = csv.parseCsv(args.text);
           p.records[0].Comments = 'Said "hello", then left';
           return csv.parseCsv(csv.writeCsv(p.records, p.dialect)).records[0].Comments;""",
        text=read_text(KAGGLE_LTER),
    )
    assert comment == 'Said "hello", then left'


@pytest.mark.parametrize("comment", ['"Pebbles" the brave', 'Nest "B"', 'A, B and "C"', "trailing space ", ""])
def test_awkward_text_survives_pandas(js, comment):
    """Values with quotes or commas are quoted exactly as Python's csv module would."""
    out = js.run(
        """const p = csv.parseCsv(args.text);
           p.records[0].Comments = args.comment;
           return csv.writeCsv(p.records, p.dialect);""",
        text=read_text(KAGGLE_LTER),
        comment=comment,
    )
    df = pd.read_csv(io.StringIO(out), keep_default_na=False)
    assert len(df) == 344
    assert df["Comments"].iloc[0] == comment


# --- rejection of bad input ------------------------------------------------


def expect_format_error(js, body, **args):
    with pytest.raises(JSError) as err:
        js.run(body, **args)
    assert err.value.name == "FormatError", err.value
    return err.value.message


def test_rejects_non_penguin_csv(js):
    message = expect_format_error(js, "return csv.parseCsv(args.text);", text="a,b,c\n1,2,3\n")
    assert "Palmer penguins" in message


def test_rejects_empty_file(js):
    expect_format_error(js, "return csv.parseCsv(args.text);", text="")


def test_rejects_ragged_rows(js):
    message = expect_format_error(js, "return csv.parseCsv(args.text);", text=",".join(SIMPLE_COLUMNS) + "\nAdelie,Dream\n")
    assert "Line 2" in message


def test_rejects_unterminated_quotes(js):
    expect_format_error(js, "return csv.parseCsv(args.text);", text=",".join(SIMPLE_COLUMNS) + '\n"Adelie,Dream\n')


def test_rejects_non_numeric_measurements(js):
    message = expect_format_error(
        js,
        """const p = csv.parseCsv(args.text);
           p.records[0]["Body Mass (g)"] = "heavy";
           return csv.writeCsv(p.records, p.dialect);""",
        text=read_text(R_SIMPLE),
    )
    assert "Body Mass" in message


def test_rejects_line_breaks_in_values(js):
    expect_format_error(
        js,
        """const p = csv.parseCsv(args.text);
           p.records[0].Comments = "two\\nlines";
           return csv.writeCsv(p.records, p.dialect);""",
        text=read_text(KAGGLE_LTER),
    )


def test_bom_is_accepted(js):
    text = read_text(R_SIMPLE)
    parsed = parse(js, "﻿" + text)
    assert write(js, parsed["records"], parsed["dialect"]) == text
