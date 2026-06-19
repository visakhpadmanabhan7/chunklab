import uuid
from typing import Literal

from pydantic import BaseModel


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    scope: Literal["project", "run", "compare", "about"]
    project_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None
    run_ids: list[uuid.UUID] | None = None
    message: str
    history: list[ChatMessage] = []
    # Optional bring-your-own LLM for this request (key used transiently, never stored).
    provider: str | None = None
    model: str | None = None
    api_key: str | None = None
