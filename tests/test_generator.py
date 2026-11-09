import statistics

import pytest

from penguin_creator.dataset import SPECIES
from penguin_creator.generator import generate
from penguin_creator.reference import SLIDER_LIMITS, reference


def test_generated_penguins_follow_reference_distribution():
    ref = reference()["species"]["Gentoo"]["by_sex"]["MALE"]
    birds = generate(2000, species="Gentoo", sex="MALE", seed=1)
    for col in ["Culmen Length (mm)", "Flipper Length (mm)", "Body Mass (g)"]:
        values = [float(b[col]) for b in birds]
        assert statistics.mean(values) == pytest.approx(ref[col]["mean"], rel=0.02)
        assert statistics.stdev(values) == pytest.approx(ref[col]["sd"], rel=0.15)


def test_body_measurements_are_correlated():
    birds = generate(2000, species="Adelie", sex="FEMALE", seed=2)
    mass = [float(b["Body Mass (g)"]) for b in birds]
    flipper = [float(b["Flipper Length (mm)"]) for b in birds]
    assert statistics.correlation(mass, flipper) > 0.1


def test_values_stay_within_slider_limits():
    for b in generate(3000, variation=3.0, seed=3):
        for col, (lo, hi, _) in SLIDER_LIMITS.items():
            assert lo <= float(b[col]) <= hi


def test_natural_islands_only():
    birds = generate(1000, seed=4)
    assert {b["Island"] for b in birds if b["Species"] == SPECIES["Gentoo"]} == {"Biscoe"}
    assert {b["Island"] for b in birds if b["Species"] == SPECIES["Chinstrap"]} == {"Dream"}


def test_nest_pairs_are_male_and_female():
    birds = generate(200, seed=5)
    nests = {}
    for b in birds:
        nests.setdefault(b["Individual ID"][:-2], []).append(b)
    for members in nests.values():
        if len(members) == 2:
            assert {m["Sex"] for m in members} == {"MALE", "FEMALE"}
            assert members[0]["Species"] == members[1]["Species"]
            assert members[0]["Island"] == members[1]["Island"]


def test_numbering_continues_after_existing_records():
    existing = generate(10, species="Adelie", seed=6)
    more = generate(10, species="Adelie", seed=7, existing=existing)
    assert more[0]["Sample Number"] == "11"
    ids = {b["Individual ID"] for b in existing + more}
    assert len(ids) == 20


def test_seed_is_deterministic():
    assert generate(5, seed=8) == generate(5, seed=8)


def test_study_name_and_dates():
    b = generate(1, year=2012, seed=9, date_style="iso")[0]
    assert b["studyName"] == "PAL1213"
    assert b["Date Egg"].startswith("2012-1")
    assert b["year"] == "2012"


@pytest.mark.parametrize(
    "kwargs",
    [{"count": 0}, {"count": 10_001}, {"species": "Emperor"}, {"sex": "X"}, {"island": "Atlantis"}, {"variation": 9}],
)
def test_invalid_options(kwargs):
    with pytest.raises(ValueError):
        generate(**{"count": 1, **kwargs})
