# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Llama Manager — a visual management tool for running, configuring, and evaluating a `llama.cpp` server instance. Provides a web UI (Chinese language) for model profiles, server launch, log monitoring, chat proxying, and evaluation of inference setups. Windows-focused (taskkill, drive letter listing).

## Running the Server

```bash
# Install dependencies (from repo root, using the existing .venv)
.venv\Scripts\pip install -r requirements.txt

# Start the dev server on port 9090
.venv\Scripts\python -m uvicorn backend.main:app --host 0.0.0.0 --port 9090

# Or use the one-click script
start.bat
```

There is no build step, no test suite, and no linter configured.

## Architecture

### Backend (Python / FastAPI)

- **`backend/main.py`** — Single entry point. All REST routes and WebSocket endpoints live here. Serves the `frontend/` directory as static files. Mounts at `/`.
- **`backend/models.py`** — Pydantic models: `AppConfig` (root config with nested `BasicSettings`, `SamplingSettings`, `MTPSettings`, `ServerSettings`), `CompileSettings`, `ModelInfo`, `DirEntry`, `ServerStatus`, `UpdateStatus`.
- **`backend/config_manager.py`** — Model profile CRUD (JSON files stored at `~/llama-manager/config/`). Tracks the current profile name (`_current_name`) and reads GGUF header metadata (`read_gguf_metadata`) for profile cards. Scans for GGUF models, provides drive listing and directory browsing for the file picker.
- **`backend/process_manager.py`** — Spawns `llama-server` via `asyncio.create_subprocess_exec`. Remembers which profile it launched (`profile_name` on `start()`, surfaced in `ServerStatus.profile`). Windows-specific process tree termination (`taskkill /F /T`). Exposes `subscribe()`/`unsubscribe()` for WebSocket log streaming via `asyncio.Queue`.
- **`backend/update_manager.py`** — `git pull` + `cmake` compile management for updating the llama.cpp installation.
- **`backend/download_manager.py`** — Clones the llama.cpp repository.

All managers are module-level singletons (e.g., `process_manager = ProcessManager()`). Each manager follows the same pub/sub pattern for log streaming: internal `_subscribers: set[asyncio.Queue]` with `subscribe()`/`unsubscribe()` methods.

### Frontend (React + Vite + TypeScript)

- **`frontend-src/`** — React 18 + Vite + TypeScript source. Six routed workspaces
  (models, config, run, evaluation, maintenance, chat) via HashRouter in `src/App.tsx`.
- **State**: TanStack Query is the source of truth for server state (config,
  profiles, server status, jobs); profile-context changes invalidate queries and
  the Shell applies one atomic update. Chat state is a local reducer
  (`features/chat/chatReducer.ts`).
- **API contract**: `scripts/export_openapi.py` exports the OpenAPI schema from the
  FastAPI app; `openapi-typescript` generates `src/generated/api.ts`.
- **Styling**: CSS Modules with custom-property tokens (`src/styles/tokens.css`),
  light/dark via `data-theme` on `<html>`, persisted in localStorage.
- **Production build**: committed to `frontend/` (Vite base `/static/`); normal
  users do not need Node. Build with `pnpm build` inside `frontend-src/`.

### Data Flow

Frontend ↔ FastAPI REST/WebSocket ↔ Manager singletons ↔ llama-server subprocess / file system

Config round-trip: UI form → `cfgFromUI()` → POST `/api/config` → `config_manager.py` → JSON on disk. Reverse: GET `/api/config` → `uiFromCfg()`.

## Key Conventions

- UI text and README are in Chinese; code identifiers and comments are in English.
- Config names are sanitized to prevent path traversal (strips special characters).
- Process management targets Windows (`taskkill`, drive letter enumeration). Not cross-platform.
- The chat proxy at `/api/chat` forwards to llama-server's OpenAI-compatible `/v1/chat/completions` endpoint, supporting both streaming and non-streaming.
