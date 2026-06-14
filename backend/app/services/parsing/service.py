"""Parse a file according to user-chosen options.

options = {"parser": "docling"|"fast", "ocr": bool, "tables": bool}
  - "fast"    → pypdf/text fallback (no models, fastest)
  - "docling" → structure-aware; ocr/tables toggles control speed vs. fidelity
docling failures fall back to the fast parser automatically.
"""

from pathlib import Path

from app.core.logging import get_logger
from app.services.parsing.base import ParsedDocument
from app.services.parsing.fallback_parser import parse_with_fallback

logger = get_logger(__name__)

# docling handles these; everything else goes straight to the fallback.
_DOCLING_EXTS = {".pdf", ".docx", ".pptx", ".html", ".htm", ".md", ".markdown"}


def parse_file(path: str, options: dict | None = None) -> ParsedDocument:
    options = options or {}
    parser = options.get("parser", "docling")
    ext = Path(path).suffix.lower()

    if parser == "fast":
        return parse_with_fallback(path)

    if ext in _DOCLING_EXTS:
        try:
            from app.services.parsing.docling_parser import parse_with_docling

            parsed = parse_with_docling(
                path,
                ocr=bool(options.get("ocr", True)),
                tables=bool(options.get("tables", True)),
            )
            if parsed.clean_text.strip():
                return parsed
            logger.warning("docling returned empty text for %s; using fallback", path)
        except Exception as exc:
            logger.warning("docling failed for %s (%s); using fallback", path, exc)

    return parse_with_fallback(path)
