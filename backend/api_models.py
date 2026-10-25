"""Public API contracts for the persisted conversation workspace."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field




class ApiErrorBody(BaseModel):
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)
    request_id: str




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




class KnowledgeSearchRequest(BaseModel):
    knowledge_base_ids: list[str]
    query: str
    limit: int = Field(default=6, ge=1, le=20)

