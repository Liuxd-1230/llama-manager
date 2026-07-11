"""Configurable Tavily and Brave web-search adapters."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

import httpx
from pydantic import BaseModel

from .env_manager import APP_DATA_DIR, env_source, env_value


SearchProvider = Literal["tavily", "brave"]
SETTINGS_PATH = APP_DATA_DIR / "search.json"
SEARCH_ENV = {"tavily": "TAVILY_API_KEY", "brave": "BRAVE_SEARCH_API_KEY"}


class SearchSettings(BaseModel):
    provider: SearchProvider = "tavily"


class SearchNotConfigured(RuntimeError):
    pass


def _read_settings() -> SearchSettings:
    if not SETTINGS_PATH.exists():
        return SearchSettings()
    try:
        return SearchSettings(**json.loads(SETTINGS_PATH.read_text(encoding="utf-8")))
    except Exception:
        return SearchSettings()


def public_settings() -> dict:
    settings = _read_settings()
    return {
        "provider": settings.provider,
        "providers": [
            {
                "id": provider,
                "name": "Tavily" if provider == "tavily" else "Brave Search",
                "env_var": env_name,
                "configured": bool(env_value(env_name)),
                "source": env_source(env_name),
            }
            for provider, env_name in SEARCH_ENV.items()
        ],
    }


def save_settings(data: dict) -> dict:
    settings = SearchSettings(**data)
    APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = SETTINGS_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps(settings.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(SETTINGS_PATH)
    return public_settings()


async def _search_tavily(client: httpx.AsyncClient, query: str, limit: int, key: str) -> list[dict]:
    response = await client.post(
        "https://api.tavily.com/search",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "query": query,
            "search_depth": "basic",
            "max_results": limit,
            "include_answer": False,
            "include_raw_content": False,
        },
    )
    response.raise_for_status()
    payload = response.json()
    return [
        {
            "title": item.get("title") or item.get("url") or "Untitled",
            "url": item.get("url") or "",
            "snippet": item.get("content") or "",
            "score": item.get("score"),
        }
        for item in payload.get("results", [])
        if item.get("url")
    ][:limit]


async def _search_brave(client: httpx.AsyncClient, query: str, limit: int, key: str) -> list[dict]:
    response = await client.get(
        "https://api.search.brave.com/res/v1/web/search",
        headers={"X-Subscription-Token": key, "Accept": "application/json"},
        params={"q": query, "count": limit, "safesearch": "moderate", "text_decorations": False},
    )
    response.raise_for_status()
    payload = response.json()
    return [
        {
            "title": item.get("title") or item.get("url") or "Untitled",
            "url": item.get("url") or "",
            "snippet": item.get("description") or item.get("extra_snippets", [""])[0] or "",
        }
        for item in (payload.get("web") or {}).get("results", [])
        if item.get("url")
    ][:limit]


async def search_web(query: str, limit: int = 4) -> tuple[str, list[dict]]:
    query = " ".join(str(query or "").split())
    if not query:
        return _read_settings().provider, []
    settings = _read_settings()
    env_name = SEARCH_ENV[settings.provider]
    key = env_value(env_name)
    if not key:
        raise SearchNotConfigured(f"{settings.provider} is not configured; set {env_name}")
    async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
        if settings.provider == "tavily":
            results = await _search_tavily(client, query, max(1, min(limit, 5)), key)
        else:
            results = await _search_brave(client, query, max(1, min(limit, 5)), key)
    return settings.provider, results
