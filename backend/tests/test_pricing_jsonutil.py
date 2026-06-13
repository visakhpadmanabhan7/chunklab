from app.core.jsonutil import parse_json
from app.core.pricing import embedding_cost, groq_cost


def test_embedding_cost():
    # 1000 tokens at default 0.00002/1k = 0.00002
    assert embedding_cost(1000) == 0.00002
    assert embedding_cost(0) == 0.0


def test_groq_cost_positive():
    cost = groq_cost(1_000_000, 1_000_000)
    assert cost > 0


def test_parse_json_plain():
    assert parse_json('{"a": 1}') == {"a": 1}


def test_parse_json_fenced():
    assert parse_json('```json\n{"a": 1}\n```') == {"a": 1}


def test_parse_json_embedded():
    assert parse_json('Here is the result: {"x": 2} thanks') == {"x": 2}


def test_parse_json_invalid():
    assert parse_json("not json at all") is None
