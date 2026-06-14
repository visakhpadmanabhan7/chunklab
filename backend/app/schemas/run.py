import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CombinationSpec(BaseModel):
    strategy: str
    params: dict = Field(default_factory=dict)


class RunCreate(BaseModel):
    name: str
    top_k: int | None = None
    qa_per_file: int | None = None   # questions generated per document
    max_qa: int | None = None        # cap on total questions for the run
    combinations: list[CombinationSpec]
    file_ids: list[uuid.UUID] | Literal["all"] = "all"


class CombinationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    run_id: uuid.UUID
    strategy: str
    params: dict
    label: str
    status: str
    progress: float


class RunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    status: str
    progress: float
    total_combinations: int
    embedding_model: str
    top_k: int
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error: str | None = None


class RunDetail(RunOut):
    combinations: list[CombinationOut] = []
