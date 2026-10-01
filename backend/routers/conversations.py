from __future__ import annotations

import json
import time
import uuid

from fastapi import APIRouter, Request

from ..api_models import ConversationCreate, TurnWrite


router = APIRouter(prefix="/api/conversations", tags=["conversations"])


@router.get("")
async def list_conversations(request: Request):
    rows = await request.app.state.db.fetchall(
        "SELECT c.*, COUNT(t.id) AS turn_count FROM conversations c LEFT JOIN turns t ON t.conversation_id=c.id GROUP BY c.id ORDER BY c.updated_at DESC"
    )
    return {"conversations": rows}


@router.post("")
async def create_conversation(body: ConversationCreate, request: Request):
    conversation_id = body.id or uuid.uuid4().hex
    now = time.time()
    await request.app.state.db.execute(
        "INSERT INTO conversations(id, title, created_at, updated_at) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at",
        (conversation_id, body.title.strip() or "新对话", now, now),
    )
    return await _load_conversation(request, conversation_id)


@router.get("/{conversation_id}")
async def get_conversation(conversation_id: str, request: Request):
    return await _load_conversation(request, conversation_id)


@router.put("/{conversation_id}/turns/{turn_id}")
async def save_turn(conversation_id: str, turn_id: str, body: TurnWrite, request: Request):
    if turn_id != body.id:
        raise ValueError("turn id mismatch")
    now = time.time()
    title = body.user_display.strip()[:60] or "新对话"
    statements: list[tuple[str, tuple]] = [
        ("INSERT INTO conversations(id, title, created_at, updated_at) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, title=CASE WHEN conversations.title='新对话' THEN excluded.title ELSE conversations.title END", (conversation_id, title, now, now)),
        ("INSERT INTO turns(id, conversation_id, position, user_content, user_display, attachments_json, active_candidate_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET position=excluded.position, user_content=excluded.user_content, user_display=excluded.user_display, attachments_json=excluded.attachments_json, active_candidate_id=excluded.active_candidate_id", (turn_id, conversation_id, body.position, body.user_content, body.user_display, json.dumps(body.attachments, ensure_ascii=False), body.active_candidate_id, now)),
    ]
    for candidate in body.candidates:
        statements.append((
            "INSERT INTO candidates(id, turn_id, parent_candidate_id, backend_id, provider_id, model, content, reasoning, status, error, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET backend_id=excluded.backend_id, content=excluded.content, reasoning=excluded.reasoning, status=excluded.status, error=excluded.error, updated_at=excluded.updated_at",
            (candidate.id, turn_id, candidate.parent_candidate_id, candidate.backend_id, candidate.provider, candidate.model, candidate.content, candidate.reasoning, candidate.status, candidate.error, now, now),
        ))
        statements.append(("DELETE FROM tool_events WHERE candidate_id=?", (candidate.id,)))
        for sequence, event in enumerate(candidate.tools):
            statements.append(("INSERT INTO tool_events(candidate_id, sequence, event_json) VALUES(?, ?, ?)", (candidate.id, sequence, json.dumps(event, ensure_ascii=False))))
    await request.app.state.db.transaction(statements)
    return {"ok": True}


@router.patch("/{conversation_id}")
async def rename_conversation(conversation_id: str, body: ConversationCreate, request: Request):
    changed = await request.app.state.db.execute("UPDATE conversations SET title=?, updated_at=? WHERE id=?", (body.title.strip() or "新对话", time.time(), conversation_id))
    if not changed:
        raise KeyError("Conversation not found")
    return await _load_conversation(request, conversation_id)


@router.delete("/{conversation_id}")
async def delete_conversation(conversation_id: str, request: Request):
    await request.app.state.db.execute("DELETE FROM conversations WHERE id=?", (conversation_id,))
    return {"ok": True}


async def _load_conversation(request: Request, conversation_id: str):
    conversation = await request.app.state.db.fetchone("SELECT * FROM conversations WHERE id=?", (conversation_id,))
    if not conversation:
        raise KeyError("Conversation not found")
    turns = await request.app.state.db.fetchall("SELECT * FROM turns WHERE conversation_id=? ORDER BY position", (conversation_id,))
    for turn in turns:
        turn["attachments"] = json.loads(turn.pop("attachments_json"))
        candidates = await request.app.state.db.fetchall("SELECT * FROM candidates WHERE turn_id=? ORDER BY created_at", (turn["id"],))
        for candidate in candidates:
            events = await request.app.state.db.fetchall("SELECT event_json FROM tool_events WHERE candidate_id=? ORDER BY sequence", (candidate["id"],))
            candidate["tools"] = [json.loads(event["event_json"]) for event in events]
            candidate["provider"] = candidate.pop("provider_id")
        turn["candidates"] = candidates
        if not any(candidate["id"] == turn["active_candidate_id"] for candidate in candidates):
            turn["active_candidate_id"] = candidates[-1]["id"] if candidates else ""
        turn["user"] = {"content": turn.pop("user_content"), "display": turn.pop("user_display")}
    conversation["turns"] = turns
    return conversation
