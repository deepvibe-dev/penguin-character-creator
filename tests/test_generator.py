"""The colony generator (static/js/generator.js), run in headless Chrome."""

import statistics

import pytest

from browser import JSError


def generate(js, **options):
    return js.run("return gen.generate(ref, args.options);", options=options)


@pytest.fixture(scope="module")
def reference(js):
    return js.run("return ref;")


def test_generated_penguins_follow_reference_distribution(js, reference):
    stats = reference["species"]["Gentoo"]["by_sex"]["MALE"]
    birds = generate(js, count=2000, species="Gentoo", sex="MALE", seed=1)
    for col in ["Culmen Length (mm)", "Flipper Length (mm)", "Body Mass (g)"]:
        values = [float(b[col]) for b in birds]
        assert statistics.mean(values) == pytest.approx(stats[col]["mean"], rel=0.02)
        assert statistics.stdev(values) == pytest.approx(stats[col]["sd"], rel=0.15)


def test_body_measurements_are_correlated(js):
    birds = generate(js, count=2000, species="Adelie", sex="FEMALE", seed=2)
    mass = [float(b["Body Mass (g)"]) for b in birds]
    flipper = [float(b["Flipper Length (mm)"]) for b in birds]
    assert statistics.correlation(mass, flipper) > 0.1


def test_values_stay_within_slider_limits(js, reference):
    for b in generate(js, count=3000, variation=3, seed=3):
        for col, lim in reference["limits"].items():
            assert lim["min"] <= float(b[col]) <= lim["max"]


def test_body_mass_in_25_gram_steps(js):
    assert all(float(b["Body Mass (g)"]) % 25 == 0 for b in generate(js, count=500, seed=10))


def test_natural_islands_only(js):
    birds = generate(js, count=1000, seed=4)
    assert {b["Island"] for b in birds if b["Species"].startswith("Gentoo")} == {"Biscoe"}
    assert {b["Island"] for b in birds if b["Species"].startswith("Chinstrap")} == {"Dream"}


def test_nest_pairs_are_male_and_female(js):
    nests = {}
    for b in generate(js, count=200, seed=5):
        nests.setdefault(b["Individual ID"][:-2], []).append(b)
    assert any(len(m) == 2 for m in nests.values())
    for members in nests.values():
        if len(members) == 2:
            assert {m["Sex"] for m in members} == {"MALE", "FEMALE"}
            assert members[0]["Species"] == members[1]["Species"]
            assert members[0]["Island"] == members[1]["Island"]


def test_numbering_continues_after_existing_records(js):
    first, second = js.run(
        """const a = gen.generate(ref, { count: 10, species: "Adelie", seed: 6 });
           const b = gen.generate(ref, { count: 10, species: "Adelie", seed: 7, existing: a });
           return [a, b];"""
    )
    assert second[0]["Sample Number"] == "11"
    assert len({b["Individual ID"] for b in first + second}) == 20


def test_seed_is_deterministic(js):
    assert generate(js, count=5, seed=8) == generate(js, count=5, seed=8)
    assert generate(js, count=5, seed=8) != generate(js, count=5, seed=9)


def test_study_name_and_dates(js):
    b = generate(js, count=1, year=2012, seed=9, dateStyle="iso")[0]
    assert b["studyName"] == "PAL1213"
    assert b["Date Egg"].startswith("2012-1")
    assert b["year"] == "2012"


@pytest.mark.parametrize(
    "options",
    [{"count": 0}, {"count": 10001}, {"species": "Emperor"}, {"sex": "X"}, {"island": "Atlantis"}, {"variation": 9}],
)
def test_invalid_options(js, options):
    with pytest.raises(JSError) as err:
        generate(js, **{"count": 1, **options})
    assert err.value.name == "RangeError"
