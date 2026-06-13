"""Primary parser: docling → clean markdown text."""

from app.services.parsing.base import ParsedDocument


def parse_with_docling(path: str) -> ParsedDocument:
    from docling.document_converter import DocumentConverter

    converter = DocumentConverter()
    result = converter.convert(path)
    text = result.document.export_to_markdown()
    pages = getattr(result.document, "pages", None)
    page_count = len(pages) if pages else None
    return ParsedDocument(
        clean_text=text,
        char_count=len(text),
        page_count=page_count,
        parser_used="docling",
    )
