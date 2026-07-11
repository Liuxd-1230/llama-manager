"""Short-lived in-memory provider context for branched chat candidates."""
from __future__ import annotations

import copy
import time
from dataclasses import dataclass
from typing import Any


@dataclass
class CandidateContext:
    provider_id: str
    model: str
    kind: str
    state: dict[str, Any]
    updated_at: float


class ConversationStore:
    def __init__(self, ttl_seconds: int = 7200, max_conversations: int = 100):
        self.ttl_seconds = ttl_seconds
        self.max_conversations = max_conversations
        self._items: dict[str, dict[str, CandidateContext]] = {}
        self._updated: dict[str, float] = {}

    def _prune(self) -> None:
        now = time.monotonic()
        expired = [key for key, updated in self._updated.items() if now - updated > self.ttl_seconds]
        for key in expired:
            self.delete(key)
        if len(self._items) <= self.max_conversations:
            return
        for key, _updated in sorted(self._updated.items(), key=lambda item: item[1])[: len(self._items) - self.max_conversations]:
            self.delete(key)

    def put(self, conversation_id: str, candidate_id: str, context: CandidateContext) -> None:
        self._prune()
        self._items.setdefault(conversation_id, {})[candidate_id] = copy.deepcopy(context)
        self._updated[conversation_id] = time.monotonic()

    def get(self, conversation_id: str, candidate_id: str) -> CandidateContext | None:
        self._prune()
        context = self._items.get(conversation_id, {}).get(candidate_id)
        if context:
            self._updated[conversation_id] = time.monotonic()
            return copy.deepcopy(context)
        return None

    def delete(self, conversation_id: str) -> bool:
        existed = conversation_id in self._items
        self._items.pop(conversation_id, None)
        self._updated.pop(conversation_id, None)
        return existed


conversation_store = ConversationStore()
