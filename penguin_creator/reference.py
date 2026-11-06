"""Reference statistics of real penguins, used to nudge users towards plausible values."""

from __future__ import annotations

import math
from collections import Counter
from functools import lru_cache
from pathlib import Path

from .dataset import (
    ISLANDS,
    NUMERIC_PRECISION,
    SEXES,
    SPECIES,
    numeric_value,
    parse_csv,
    short_species,
)

DATA_DIR = Path(__file__).resolve().parent / "data"
REFERENCE_CSV = DATA_DIR / "penguins_lter.csv"

MEASURES = list(NUMERIC_PRECISION)

# Slider limits: wide enough for every real penguin, plus some room for fantasy.
SLIDER_LIMITS = {
    "Culmen Length (mm)": (25.0, 65.0, 0.1),
    "Culmen Depth (mm)": (10.0, 25.0, 0.1),
    "Flipper Length (mm)": (160.0, 245.0, 1.0),
    "Body Mass (g)": (2000.0, 7000.0, 25.0),
    "Delta 15 N (o/oo)": (7.0, 10.5, 0.00001),
    "Delta 13 C (o/oo)": (-27.5, -23.0, 0.00001),
}


def load_reference_records(path: Path = REFERENCE_CSV) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as fh:
        _, records = parse_csv(fh.read())
    return records


def _quantile(sorted_values: list[float], q: float) -> float:
    if not sorted_values:
        return math.nan
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
        "p05": _quantile(values, 0.05),
        "p95": _quantile(values, 0.95),
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


def compute_reference(records: list[dict]) -> dict:
    """Per species (and per species+sex) distribution of every measurement."""
    species_stats = {}
    for short, full in SPECIES.items():
        members = [r for r in records if r["Species"] == full]
        entry = {"full_name": full, "count": len(members), "measures": {}, "by_sex": {}}
        for m in MEASURES:
            entry["measures"][m] = summarize(
                [v for r in members if (v := numeric_value(r, m)) is not None]
            )
        for sex in SEXES:
            sub = [r for r in members if r["Sex"] == sex]
            entry["by_sex"][sex] = {
                m: summarize([v for r in sub if (v := numeric_value(r, m)) is not None])
                for m in MEASURES
            }
        islands = Counter(r["Island"] for r in members if r["Island"])
        entry["islands"] = {i: islands.get(i, 0) for i in ISLANDS}
        clutch = Counter(r["Clutch Completion"] for r in members)
        entry["clutch_yes_rate"] = clutch.get("Yes", 0) / max(1, sum(clutch.values()))
        species_stats[short] = entry
    return {
        "species": species_stats,
        "islands": ISLANDS,
        "sexes": SEXES,
        "measures": MEASURES,
        "precision": NUMERIC_PRECISION,
        "limits": {m: {"min": a, "max": b, "step": s} for m, (a, b, s) in SLIDER_LIMITS.items()},
    }


def compute_models(records: list[dict]) -> dict:
    """Multivariate normal models per (species, sex), used by the generator.

    Body measurements are strongly correlated (a heavy penguin has long
    flippers), so they are sampled jointly. Isotopes are modelled jointly too.
    """
    groups = {
        "body": MEASURES[:4],
        "isotopes": MEASURES[4:],
    }
    models = {}
    for short, full in SPECIES.items():
        for sex in SEXES:
            members = [r for r in records if r["Species"] == full and r["Sex"] == sex]
            model = {}
            for name, cols in groups.items():
                rows = []
                for r in members:
                    vals = [numeric_value(r, c) for c in cols]
                    if all(v is not None for v in vals):
                        rows.append(vals)
                means, cov = covariance(rows)
                model[name] = {"columns": cols, "mean": means, "cov": cov}
            models[(short, sex)] = model
    return models


@lru_cache(maxsize=1)
def reference() -> dict:
    return compute_reference(load_reference_records())


@lru_cache(maxsize=1)
def models() -> dict:
    return compute_models(load_reference_records())


def species_key(value: str) -> str | None:
    short = short_species(value)
    return short if short in SPECIES else None
