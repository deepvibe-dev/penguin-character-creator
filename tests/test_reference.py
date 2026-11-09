"""static/data/reference.json must match the original data it is built from."""

from penguin_creator import reference


def test_reference_json_is_up_to_date():
    expected = reference.render(reference.compute(reference.load_records()))
    actual = reference.REFERENCE_JSON.read_text(encoding="utf-8")
    assert actual == expected, "Run `uv run python -m penguin_creator.reference` and commit the result."


def test_reference_covers_every_species_and_sex():
    ref = reference.compute(reference.load_records())
    assert {s: e["count"] for s, e in ref["species"].items()} == {"Adelie": 152, "Chinstrap": 68, "Gentoo": 124}
    assert set(ref["models"]) == {f"{s}|{x}" for s in reference.SPECIES for x in reference.SEXES}
    gentoo = ref["species"]["Gentoo"]
    assert gentoo["islands"] == {"Biscoe": 124, "Dream": 0, "Torgersen": 0}
    mass = gentoo["measures"]["Body Mass (g)"]
    assert mass["min"] <= mass["p025"] < mass["mean"] < mass["p975"] <= mass["max"]
