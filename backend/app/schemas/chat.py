import uuid
from typing import Literal

from pydantic import BaseModel


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    scope: Literal["project", "run", "compare"]
    project_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None
    run_ids: list[uuid.UUID] | None = None
    message: str
    history: list[ChatMessage] = []
