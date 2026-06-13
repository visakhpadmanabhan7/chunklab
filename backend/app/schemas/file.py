import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class FileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    filename: str
    mime_type: str | None = None
    size_bytes: int | None = None
    status: str
    parser_used: str | None = None
    error: str | None = None
    created_at: datetime


class ParsedDocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    file_id: uuid.UUID
    clean_text: str
    char_count: int
    page_count: int | None = None
