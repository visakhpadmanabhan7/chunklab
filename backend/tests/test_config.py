from app.core.config import get_settings


def test_settings_defaults():
    s = get_settings()
    assert s.EMBEDDING_MODEL == "BAAI/bge-small-en-v1.5"
    assert s.EMBEDDING_DIM == 384
    assert s.GROQ_MODEL


def test_cors_origin_list():
    s = get_settings()
    assert isinstance(s.cors_origin_list, list)
    assert all(isinstance(o, str) for o in s.cors_origin_list)
