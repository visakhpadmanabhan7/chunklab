"""Fixed-size character chunking with overlap (deterministic, no library)."""

from app.services.chunking.registry import register


class CharacterStrategy:
    name = "character"

    def split(self, text: str, params: dict) -> list[str]:
        size = int(params.get("size", params.get("chunk_size", 1000)))
        overlap = int(params.get("overlap", 0))
        size = max(size, 1)
        step = max(size - overlap, 1)
        return [text[i : i + size] for i in range(0, len(text), step)]

    def label(self, params: dict) -> str:
        size = params.get("size", params.get("chunk_size", 1000))
        overlap = params.get("overlap", 0)
        return f"character·{size}/{overlap}"


register(CharacterStrategy())
