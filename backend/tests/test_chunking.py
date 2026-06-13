from app.services.chunking import STRATEGY_REGISTRY, assemble, get_strategy
from app.services.chunking.character import CharacterStrategy
from app.services.chunking.expander import expand


def test_all_strategies_registered():
    for name in ("character", "recursive", "sentence", "token", "semantic"):
        assert name in STRATEGY_REGISTRY


def test_character_split_size_and_overlap():
    text = "abcdefghij" * 10  # 100 chars
    pieces = CharacterStrategy().split(text, {"size": 20, "overlap": 5})
    assert all(len(p) <= 20 for p in pieces)
    # step = 15 → ceil(100/15) = 7 windows
    assert len(pieces) == 7


def test_assemble_offsets():
    text = "Hello world. This is a test document about chunking."
    pieces = ["Hello world.", "This is a test", "about chunking."]
    chunks = assemble(text, pieces)
    assert [c.index for c in chunks] == [0, 1, 2]
    assert chunks[0].start == text.find("Hello world.")
    assert chunks[2].end == text.find("about chunking.") + len("about chunking.")


def test_expander_labels_and_dedup():
    specs = [
        {"strategy": "character", "params": {"size": 1000, "overlap": 0}},
        {"strategy": "character", "params": {"size": 1000, "overlap": 0}},  # dup
        {"strategy": "recursive", "params": {"chunk_size": 512, "overlap": 64}},
    ]
    out = expand(specs)
    assert len(out) == 2  # dup removed
    labels = {c.label for c in out}
    assert "character·1000/0" in labels
    assert "recursive·512/64" in labels


def test_expander_sizes_matrix():
    specs = [{"strategy": "sentence", "params": {"sizes": [256, 512], "overlap": 20}}]
    out = expand(specs)
    assert len(out) == 2
    assert {c.params["size"] for c in out} == {256, 512}


def test_get_strategy_unknown_raises():
    try:
        get_strategy("does-not-exist")
        assert False, "expected KeyError"
    except KeyError:
        pass
