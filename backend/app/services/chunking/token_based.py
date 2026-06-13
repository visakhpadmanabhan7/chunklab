"""Token-based chunking using the embedding model's own tokenizer.

Encodes the text to token ids, slices fixed windows (with overlap), and decodes
each window back to text — so chunk size is measured in the exact tokens the
embedding model sees.
"""

from app.core.embedding import get_tokenizer
from app.services.chunking.registry import register


class TokenStrategy:
    name = "token"

    def split(self, text: str, params: dict) -> list[str]:
        size = int(params.get("size", params.get("chunk_size", 256)))
        overlap = int(params.get("overlap", 0))
        size = max(size, 1)
        step = max(size - overlap, 1)

        kind, tok = get_tokenizer()
        if kind == "hf":
            ids = tok.encode(text, add_special_tokens=False)
            pieces = [
                tok.decode(ids[i : i + size], skip_special_tokens=True)
                for i in range(0, len(ids), step)
            ]
        else:  # tiktoken
            ids = tok.encode(text)
            pieces = [tok.decode(ids[i : i + size]) for i in range(0, len(ids), step)]
        return [p.strip() for p in pieces if p.strip()]

    def label(self, params: dict) -> str:
        size = params.get("size", params.get("chunk_size", 256))
        overlap = params.get("overlap", 0)
        return f"token·{size}/{overlap}"


register(TokenStrategy())
