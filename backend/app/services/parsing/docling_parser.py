"""Primary parser: docling → clean markdown text.

A DocumentConverter is built once per (ocr, tables) option combo and reused
(models load a single time). OCR and table-structure are user-configurable:
turning them off makes large PDFs much faster; turning OCR on handles scanned
documents. Conversions are serialized with a lock (CPU-bound, not thread-safe).
"""

import threading
from functools import lru_cache

from app.services.parsing.base import ParsedDocument

_lock = threading.Lock()


@lru_cache(maxsize=8)
def _converter(ocr: bool, tables: bool):
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    opts = PdfPipelineOptions()
    opts.do_ocr = ocr
    opts.do_table_structure = tables
    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
    )


def parse_with_docling(path: str, ocr: bool = True, tables: bool = True) -> ParsedDocument:
    converter = _converter(ocr, tables)
    with _lock:
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
