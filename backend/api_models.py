"""Public API contracts for persisted workspaces and jobs."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]


class ApiErrorBody(BaseModel):
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)
    request_id: str


class JobCreate(BaseModel):
    kind: str
    payload: dict[str, Any] = Field(default_factory=dict)
    resources: list[str] = Field(default_factory=list)


class JobRecord(BaseModel):
    id: str
    kind: str
    status: JobStatus
    payload: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] = Field(default_factory=dict)
    checkpoint: dict[str, Any] = Field(default_factory=dict)
    resources: list[str] = Field(default_factory=list)
    error: str | None = None
    created_at: float
    updated_at: float
    started_at: float | None = None
    finished_at: float | None = None


class ConversationCreate(BaseModel):
    id: str | None = None
    title: str = "新对话"


class CandidateWrite(BaseModel):
    id: str
    backend_id: str | None = None
    parent_candidate_id: str | None = None
    provider: str
    model: str
    content: str = ""
    reasoning: str = ""
    tools: list[dict[str, Any]] = Field(default_factory=list)
    status: str = "done"
    error: str | None = None


class TurnWrite(BaseModel):
    id: str
    position: int
    user_content: str
    user_display: str
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    candidates: list[CandidateWrite] = Field(default_factory=list)
    active_candidate_id: str = ""


class DatasetCreate(BaseModel):
    name: str
    description: str = ""


class DatasetCaseWrite(BaseModel):
    id: str | None = None
    prompt: str
    expected: str = ""
    evaluator: dict[str, Any] = Field(default_factory=lambda: {"type": "exact"})
    metadata: dict[str, Any] = Field(default_factory=dict)


class EvaluationStart(BaseModel):
    name: str = "评测运行"
    dataset_id: str
    provider_id: str = "local"
    model: str = "default"
    judge_provider_id: str | None = None
    judge_model: str | None = None
    config_snapshot: dict[str, Any] = Field(default_factory=dict)
    allow_code_execution: bool = False


class KnowledgeBaseCreate(BaseModel):
    name: str
    description: str = ""


class KnowledgeSourceCreate(BaseModel):
    path: str
    kind: Literal["file", "directory"] = "directory"


class KnowledgeSearchRequest(BaseModel):
    knowledge_base_ids: list[str]
    query: str
    limit: int = Field(default=6, ge=1, le=20)


class EmbeddingSettings(BaseModel):
    base_url: str = ""
    model: str = ""
    api_key_env: str = "LLAMA_MANAGER_EMBEDDING_API_KEY"
