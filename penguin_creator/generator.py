"""Generate batches of plausible penguins ("hatching a colony")."""

from __future__ import annotations

import math
import random
import re
from datetime import date, timedelta

from .dataset import (
    ISLANDS,
    NUMERIC_PRECISION,
    SEXES,
    SPECIES,
    format_date,
    format_number,
    new_record,
    study_name_for_year,
)
from .reference import SLIDER_LIMITS, models, reference

MAX_BATCH = 10_000


def cholesky(matrix: list[list[float]]) -> list[list[float]]:
    n = len(matrix)
    lower = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1):
            s = sum(lower[i][k] * lower[j][k] for k in range(j))
            if i == j:
                lower[i][j] = math.sqrt(max(matrix[i][i] - s, 1e-12))
            else:
                lower[i][j] = (matrix[i][j] - s) / lower[j][j]
    return lower


def sample_mvn(rng: random.Random, mean: list[float], chol: list[list[float]], scale: float) -> list[float]:
    z = [rng.gauss(0.0, 1.0) for _ in mean]
    return [
        mean[i] + scale * sum(chol[i][k] * z[k] for k in range(i + 1)) for i in range(len(mean))
    ]


def _clamp(col: str, value: float) -> float:
    lo, hi, _ = SLIDER_LIMITS[col]
    return min(hi, max(lo, value))


def _weighted_choice(rng: random.Random, weights: dict[str, float]) -> str:
    total = sum(weights.values())
    if total <= 0:
        return rng.choice(list(weights))
    pick = rng.uniform(0, total)
    for key, w in weights.items():
        pick -= w
        if pick <= 0:
            return key
    return key


def _next_numbers(existing: list[dict]) -> tuple[dict, int]:
    sample = {short: 0 for short in SPECIES}
    nest = 0
    for r in existing or []:
        for short, full in SPECIES.items():
            if r.get("Species") == full:
                try:
                    sample[short] = max(sample[short], int(r.get("Sample Number") or 0))
                except ValueError:
                    pass
        m = re.match(r"^N(\d+)A\d+$", r.get("Individual ID") or "")
        if m:
            nest = max(nest, int(m.group(1)))
    return sample, nest


def generate(
    count: int,
    species: str = "mixed",
    sex: str = "random",
    island: str = "natural",
    year: int = 2010,
    variation: float = 1.0,
    seed: int | None = None,
    existing: list[dict] | None = None,
    date_style: str = "mdy",
) -> list[dict]:
    """Return ``count`` new canonical records sampled from the real distributions.

    * ``species``: ``Adelie`` / ``Chinstrap`` / ``Gentoo`` or ``mixed``
      (proportional to the reference dataset).
    * ``sex``: ``MALE`` / ``FEMALE`` / ``random``.
    * ``island``: an island name or ``natural`` (where that species was observed).
    * ``variation``: 1.0 is natural spread; lower = more uniform colony.
    * ``existing``: records already in the dataset, so sample numbers and nest
      IDs continue instead of clashing.
    """
    count = int(count)
    if not 1 <= count <= MAX_BATCH:
        raise ValueError(f"count must be between 1 and {MAX_BATCH}")
    if species != "mixed" and species not in SPECIES:
        raise ValueError(f"unknown species {species!r}")
    if sex != "random" and sex not in SEXES:
        raise ValueError(f"unknown sex {sex!r}")
    if island != "natural" and island not in ISLANDS:
        raise ValueError(f"unknown island {island!r}")
    year = int(year)
    if not 1900 <= year <= 2999:
        raise ValueError("year must be between 1900 and 2999")
    variation = float(variation)
    if not 0.0 <= variation <= 3.0:
        raise ValueError("variation must be between 0 and 3")

    rng = random.Random(seed)
    ref = reference()["species"]
    mdl = models()
    chols = {
        key: {name: cholesky(group["cov"]) for name, group in model.items()}
        for key, model in mdl.items()
    }
    sample_no, nest_no = _next_numbers(existing or [])
    species_weights = {s: ref[s]["count"] for s in SPECIES}
    season_start = date(year, 11, 9)

    records = []
    pending_partner = None  # second adult of a nest, to mimic N12A1 / N12A2 pairs
    for _ in range(count):
        if pending_partner and species == "mixed":
            sp = pending_partner[0]  # both adults of a nest share a species
        else:
            sp = species if species != "mixed" else _weighted_choice(rng, species_weights)

        if pending_partner and pending_partner[0] == sp:
            nest_id, adult, partner_sex, isl = pending_partner[1:]
            pending_partner = None
            # breeding pairs are one male and one female
            sx = sex if sex != "random" else ("FEMALE" if partner_sex == "MALE" else "MALE")
            if island != "natural":
                isl = island
        else:
            nest_no += 1
            nest_id, adult = nest_no, 1
            sx = sex if sex != "random" else rng.choice(SEXES)
            isl = island if island != "natural" else _weighted_choice(rng, ref[sp]["islands"])
            pending_partner = (sp, nest_id, 2, sx, isl)

        sample_no[sp] += 1
        record = new_record(
            studyName=study_name_for_year(year),
            **{
                "Sample Number": str(sample_no[sp]),
                "Species": SPECIES[sp],
                "Region": "Anvers",
                "Island": isl,
                "Stage": "Adult, 1 Egg Stage",
                "Individual ID": f"N{nest_id}A{adult}",
                "Clutch Completion": "Yes" if rng.random() < ref[sp]["clutch_yes_rate"] else "No",
                "Date Egg": format_date(season_start + timedelta(days=rng.randint(0, 24)), date_style),
                "Sex": sx,
                "year": str(year),
            },
        )
        for name, group in mdl[(sp, sx)].items():
            values = sample_mvn(rng, group["mean"], chols[(sp, sx)][name], variation)
            for col, value in zip(group["columns"], values):
                if col == "Body Mass (g)":
                    value = round(value / 25.0) * 25.0  # field scales read in 25 g steps
                record[col] = format_number(_clamp(col, value), NUMERIC_PRECISION[col])
        records.append(record)
    return records
