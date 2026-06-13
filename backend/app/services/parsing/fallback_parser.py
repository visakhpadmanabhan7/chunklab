"""Fallback parser: pypdf for PDFs, direct read for text/markdown."""

from pathlib import Path

from app.services.parsing.base import ParsedDocument

_TEXT_EXTS = {".txt", ".md", ".markdown", ".rst", ".csv", ".json", ".html", ".htm"}


def parse_with_fallback(path: str) -> ParsedDocument:
    ext = Path(path).suffix.lower()

    if ext == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(path)
        pages = [page.extract_text() or "" for page in reader.pages]
        text = "\n\n".join(pages)
        return ParsedDocument(
            clean_text=text,
            char_count=len(text),
            page_count=len(pages),
            parser_used="fallback",
        )

    # treat everything else as UTF-8 text
    text = Path(path).read_text(encoding="utf-8", errors="ignore")
    return ParsedDocument(
        clean_text=text,
        char_count=len(text),
        page_count=None,
        parser_used="fallback",
    )
