from dataclasses import dataclass


@dataclass
class ParsedDocument:
    clean_text: str
    char_count: int
    page_count: int | None
    parser_used: str
