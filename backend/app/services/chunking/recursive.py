"""Recursive character chunking (langchain RecursiveCharacterTextSplitter)."""

from app.services.chunking.registry import register


class RecursiveStrategy:
    name = "recursive"

    def split(self, text: str, params: dict) -> list[str]:
        from langchain_text_splitters import RecursiveCharacterTextSplitter

        chunk_size = int(params.get("chunk_size", params.get("size", 512)))
        overlap = int(params.get("overlap", params.get("chunk_overlap", 0)))
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size, chunk_overlap=overlap
        )
        return splitter.split_text(text)

    def label(self, params: dict) -> str:
        size = params.get("chunk_size", params.get("size", 512))
        overlap = params.get("overlap", params.get("chunk_overlap", 0))
        return f"recursive·{size}/{overlap}"


register(RecursiveStrategy())
