# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Atelier update

Atelier is now a Chinese, local-first creative workbench combining model profiles, downloads, conversations, prompt drafting/layout/compilation, assets and external ComfyUI rendering. Read `docs/atelier-architecture.md` before changing project selection, snapshots or task ownership. Read root `DESIGN.md` for UI work; preserve its user-authored principles and record product-specific decisions in `docs/atelier-design.md`. Read `docs/atelier-validation.md` before reporting acceptance; distinguish fixtures from actual service execution. Actual open-claude-ui references are recorded in `docs/open-claude-ui-reference.md`.

Data defaults to `%LOCALAPPDATA%\Atelier`, overridden by `ATELIER_DATA_DIR`. `backend/paths.py` owns verified migration, `backend/secrets.py` owns DPAPI and environment credentials. Preserve legacy sources, model/cache paths and third-party notices. Use an isolated data directory and separate port (normally 9092) for mutation tests.

`backend/main.py` now owns lifecycle, middleware, errors, router registration and static resources. REST routes live under `/api/v1` in `backend/routers/`, `backend/atelier/api.py`, and creative routers. `backend/atelier/` owns shared providers, creation/compiler, downloads, generation, MCP, durable jobs and storage. `backend/hf_download/` is the adapted pure Python download core. `backend/moss_server/` retains creative documents, operations, Agent, Skills and workflows; compilation delegates to the common creation service.

Frontend workspaces are workbench, creation, models, downloads, assets, chat and settings. `features/atelier/` separates overview, downloads, assets, projects and tasks. `features/studio/projects.ts` serializes save → select → load. Server state uses TanStack Query; creative documents use the studio store and chat uses its reducer. Submitted jobs own immutable snapshots independent of later edits. Shared IME/pinned-scroll hooks live in `src/hooks/`; controls and tokens remain in `components/kit/` and `styles/tokens.css`.

Registration does not select or start a model. Explicit confirmation is required before switching a managed running engine. ComfyUI remains externally managed: Atelier never installs, starts, stops or globally interrupts it. Persist jobs before execution; restart marks non-resumable work interrupted rather than replaying generation/tool calls.

## Original engine background

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

Build production UI into committed `frontend/` after source changes. Run relevant tests, generated API types, TypeScript and production build. Browser checks inspect actual rendered screens, both themes, narrow layouts, keyboard focus and reduced motion.

```bash
# Backend (requirements-dev.txt adds pytest for the download core)
.venv\Scripts\python.exe -X utf8 -m unittest discover -s tests -p 'test_*.py'
.venv\Scripts\python.exe -m pytest tests/hf_download -q

# Frontend (from frontend-src/)
npx vitest run
npx tsc -b
npm run generate:api   # re-export OpenAPI and regenerate src/generated/api.ts
npm run build
npx playwright test    # isolated backend on 9092; one worker owns current project
```


## Architecture

### Backend (Python / FastAPI)

- **`backend/main.py`** — Application entry point and lifecycle; routes are registered from domain modules. Serves the `frontend/` directory as static files.
- **`backend/models.py`** — Pydantic models: `AppConfig` (root config with nested `BasicSettings`, `SamplingSettings`, `MTPSettings`, `KvmemSettings`, `NinferSettings`, `ServerSettings`), `CompileSettings`, `ModelInfo`, `DirEntry`, `ServerStatus`, `UpdateStatus`. Three engines: `"llama.cpp"` (llama-server), `"kvmem"` (llama-kvmem-server, GGUF + KV virtualization), `"ninfer"` (ninfer-kvmem-server, .ninfer artifacts). `KvmemSettings` and `NinferSettings` each carry the retrieval block (`sink_tokens`/`recent_tokens`/`lrfu`/`lrfu_lambda`/`lrfu_top_frac`/`score_agg`) as first-class fields.
- **`backend/config_manager.py`** — Model profile CRUD in the Atelier data root. Tracks the current profile, reads GGUF metadata, scans GGUF/.ninfer models, and provides filesystem browsing. Resolves bundled engine packages and caches advertised binary flags per revision. Registration can save without switching the current profile.
- **`backend/process_manager.py`** — Spawns the engine process via `asyncio.create_subprocess_exec` (engine-specific command builders, all resolving the engine directory through `resolve_engine_dir`). Builders validate what the engine would reject anyway — device tokens against `--max-context`, pinned windows against the budget, page/block alignment — and raise a Chinese `ValueError` naming the field instead of letting the process die on `unknown flag` when a build predates LRFU. Remembers which profile it launched (`profile_name` on `start()`, surfaced in `ServerStatus.profile`). Windows-specific process tree termination (`taskkill /F /T`). Exposes `subscribe()`/`unsubscribe()` for WebSocket log streaming via `asyncio.Queue`.

- **`backend/update_manager.py`** — `git pull` + `cmake` compile management for updating the llama.cpp installation.
- **`backend/download_manager.py`** — Clones the llama.cpp repository.

All managers are module-level singletons (e.g., `process_manager = ProcessManager()`). Each manager follows the same pub/sub pattern for log streaming: internal `_subscribers: set[asyncio.Queue]` with `subscribe()`/`unsubscribe()` methods.

### Frontend (React + Vite + TypeScript)

- **`frontend-src/`** — React 18 + Vite + TypeScript source with HashRouter in `src/App.tsx`; model configuration/runtime and maintenance remain accessible within the new workspaces.
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

Config round-trip: UI form → `cfgFromUI()` → POST `/api/v1/config` → `config_manager.py` → JSON on disk. Reverse: GET `/api/v1/config` → `uiFromCfg()`.

## Profile Creation Guide

AI agents creating or tuning inference profiles MUST read `docs/profile-guide.md`
first: it documents the API sequence, per-engine field semantics, measured VRAM
accounting for the 8GB laptop GPU, tuning lore (batch=128 for KVMem, budget
size vs prefill stability, MTP acceptance behavior), verified profiles, and
known traps (backend restarts for version skew, orphan processes).

## Key Conventions

- UI text and README are in Chinese; code identifiers and comments are in English.
- Config names are sanitized to prevent path traversal (strips special characters).
- Process management targets Windows (`taskkill`, drive letter enumeration). Not cross-platform.
- The chat proxy at `/api/v1/chat` uses shared provider adapters and supports streaming/non-streaming. Per-engine payloads differ: llama.cpp/KVMem get top_k and `chat_template_kwargs`; NInfer gets only standard fields plus `reasoning_effort` (it rejects top_k>20 and 404s on unknown model ids).
