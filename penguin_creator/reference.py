"""Build ``static/data/reference.json`` from the original Palmer penguins data.

The browser uses this file to show the plausible range of every measurement
(per species and sex) and to hatch new penguins from the real distributions.
It is generated once and committed; ``tests/test_reference.py`` fails if it
is out of date. Regenerate it with::

    uv run python -m penguin_creator.reference
"""

from __future__ import annotations

import csv
import json
import math
from collections import Counter
from pathlib import Path

STATIC_DIR = Path(__file__).resolve().parent / "static"
REFERENCE_CSV = STATIC_DIR / "data" / "penguins_lter.csv"
REFERENCE_JSON = STATIC_DIR / "data" / "reference.json"

SPECIES = {
    "Adelie": "Adelie Penguin (Pygoscelis adeliae)",
    "Chinstrap": "Chinstrap penguin (Pygoscelis antarctica)",
    "Gentoo": "Gentoo penguin (Pygoscelis papua)",
}
ISLANDS = ["Biscoe", "Dream", "Torgersen"]
SEXES = ["MALE", "FEMALE"]

# Number of decimals the original dataset uses for each measurement.
PRECISION = {
    "Culmen Length (mm)": 1,
    "Culmen Depth (mm)": 1,
    "Flipper Length (mm)": 0,
    "Body Mass (g)": 0,
    "Delta 15 N (o/oo)": 5,
    "Delta 13 C (o/oo)": 5,
}
MEASURES = list(PRECISION)

# Slider limits: wide enough for every real penguin, plus some room for fantasy.
SLIDER_LIMITS = {
    "Culmen Length (mm)": (25.0, 65.0, 0.1),
    "Culmen Depth (mm)": (10.0, 25.0, 0.1),
    "Flipper Length (mm)": (160.0, 245.0, 1.0),
    "Body Mass (g)": (2000.0, 7000.0, 25.0),
    "Delta 15 N (o/oo)": (7.0, 10.5, 0.00001),
    "Delta 13 C (o/oo)": (-27.5, -23.0, 0.00001),
}

# Measurements sampled jointly by the generator (they are correlated).
MODEL_GROUPS = {"body": MEASURES[:4], "isotopes": MEASURES[4:]}


def load_records(path: Path = REFERENCE_CSV) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def number(record: dict, col: str) -> float | None:
    try:
        value = float(record.get(col, ""))
    except ValueError:
        return None
    return None if math.isnan(value) else value


def _quantile(sorted_values: list[float], q: float) -> float:
    pos = (len(sorted_values) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def summarize(values: list[float]) -> dict | None:
    if len(values) < 2:
        return None
    values = sorted(values)
    n = len(values)
    mean = sum(values) / n
    sd = math.sqrt(sum((v - mean) ** 2 for v in values) / (n - 1))
    return {
        "n": n,
        "mean": mean,
        "sd": sd,
        "min": values[0],
        "max": values[-1],
        "p025": _quantile(values, 0.025),
        "p05": _quantile(values, 0.05),
        "p95": _quantile(values, 0.95),
        "p975": _quantile(values, 0.975),
    }


def covariance(rows: list[list[float]]) -> tuple[list[float], list[list[float]]]:
    n = len(rows)
    k = len(rows[0])
    means = [sum(r[i] for r in rows) / n for i in range(k)]
    cov = [
        [sum((r[i] - means[i]) * (r[j] - means[j]) for r in rows) / (n - 1) for j in range(k)]
        for i in range(k)
    ]
    return means, cov


def compute(records: list[dict]) -> dict:
    """Per-species statistics, per-species/sex statistics and generator models."""
    species_stats = {}
    models = {}
    for short, full in SPECIES.items():
        members = [r for r in records if r["Species"] == full]
        entry = {"full_name": full, "count": len(members), "measures": {}, "by_sex": {}}
        for m in MEASURES:
            entry["measures"][m] = summarize([v for r in members if (v := number(r, m)) is not None])
        for sex in SEXES:
            sub = [r for r in members if r["Sex"] == sex]
            entry["by_sex"][sex] = {
                m: summarize([v for r in sub if (v := number(r, m)) is not None]) for m in MEASURES
            }
            model = {}
            for name, cols in MODEL_GROUPS.items():
                rows = [vals for r in sub if None not in (vals := [number(r, c) for c in cols])]
                means, cov = covariance(rows)
                model[name] = {"columns": cols, "mean": means, "cov": cov}
            models[f"{short}|{sex}"] = model
        islands = Counter(r["Island"] for r in members if r["Island"])
        entry["islands"] = {i: islands.get(i, 0) for i in ISLANDS}
        clutch = Counter(r["Clutch Completion"] for r in members)
        entry["clutch_yes_rate"] = clutch.get("Yes", 0) / max(1, sum(clutch.values()))
        species_stats[short] = entry
    return {
        "source": REFERENCE_CSV.name,
        "species": species_stats,
        "islands": ISLANDS,
        "sexes": SEXES,
        "measures": MEASURES,
        "precision": PRECISION,
        "limits": {m: {"min": a, "max": b, "step": s} for m, (a, b, s) in SLIDER_LIMITS.items()},
        "models": models,
    }


def render(reference: dict) -> str:
    return json.dumps(reference, indent=1, sort_keys=True) + "\n"


def main() -> None:
    REFERENCE_JSON.write_text(render(compute(load_records())), encoding="utf-8")
    print(f"Wrote {REFERENCE_JSON}")


if __name__ == "__main__":
    main()
