"""Sentence-aware chunking (llama-index SentenceSplitter).

chunk_size/overlap are measured in tokens; the splitter keeps sentence
boundaries intact while packing toward the target size.
"""

from app.services.chunking.registry import register


class SentenceStrategy:
    name = "sentence"

    def split(self, text: str, params: dict) -> list[str]:
        from llama_index.core.node_parser import SentenceSplitter

        chunk_size = int(params.get("size", params.get("chunk_size", 512)))
        overlap = int(params.get("overlap", 0))
        splitter = SentenceSplitter(chunk_size=chunk_size, chunk_overlap=overlap)
        return splitter.split_text(text)

    def label(self, params: dict) -> str:
        size = params.get("size", params.get("chunk_size", 512))
        overlap = params.get("overlap", 0)
        return f"sentence·{size}/{overlap}"


register(SentenceStrategy())
