from __future__ import annotations

import csv
import io
import json
import time
import uuid

from fastapi import APIRouter, Request

from ..api_models import DatasetCaseWrite, DatasetCreate, EvaluationStart, JobCreate
from ..evaluation import pareto_front


router = APIRouter(tags=["evaluation"])


@router.get("/api/datasets")
async def list_datasets(request: Request):
    rows = await request.app.state.db.fetchall("SELECT d.*, COUNT(c.id) AS case_count FROM datasets d LEFT JOIN dataset_cases c ON c.dataset_id=d.id GROUP BY d.id ORDER BY d.builtin DESC, d.updated_at DESC")
    return {"datasets": rows}


@router.post("/api/datasets")
async def create_dataset(body: DatasetCreate, request: Request):
    dataset_id, now = uuid.uuid4().hex, time.time()
    await request.app.state.db.execute("INSERT INTO datasets(id, name, description, created_at, updated_at) VALUES(?, ?, ?, ?, ?)", (dataset_id, body.name, body.description, now, now))
    return {"id": dataset_id, **body.model_dump(), "case_count": 0, "created_at": now, "updated_at": now}


@router.get("/api/datasets/{dataset_id}")
async def get_dataset(dataset_id: str, request: Request):
    dataset = await request.app.state.db.fetchone("SELECT * FROM datasets WHERE id=?", (dataset_id,))
    if not dataset:
        raise KeyError("Dataset not found")
    cases = await request.app.state.db.fetchall("SELECT * FROM dataset_cases WHERE dataset_id=? ORDER BY position", (dataset_id,))
    for case in cases:
        case["evaluator"] = json.loads(case.pop("evaluator_json")); case["metadata"] = json.loads(case.pop("metadata_json"))
    dataset["cases"] = cases
    return dataset


@router.post("/api/datasets/{dataset_id}/cases")
async def add_case(dataset_id: str, body: DatasetCaseWrite, request: Request):
    position = (await request.app.state.db.fetchone("SELECT COALESCE(MAX(position), -1)+1 AS value FROM dataset_cases WHERE dataset_id=?", (dataset_id,)))["value"]
    case_id = body.id or uuid.uuid4().hex
    await request.app.state.db.execute("INSERT INTO dataset_cases(id, dataset_id, position, prompt, expected, evaluator_json, metadata_json) VALUES(?, ?, ?, ?, ?, ?, ?)", (case_id, dataset_id, position, body.prompt, body.expected, json.dumps(body.evaluator, ensure_ascii=False), json.dumps(body.metadata, ensure_ascii=False)))
    await request.app.state.db.execute("UPDATE datasets SET updated_at=? WHERE id=?", (time.time(), dataset_id))
    return {"id": case_id, "position": position, **body.model_dump(exclude={"id"})}


@router.post("/api/datasets/{dataset_id}/import")
async def import_cases(dataset_id: str, body: dict, request: Request):
    content, format_name = str(body.get("content") or ""), str(body.get("format") or "jsonl")
    items = []
    if format_name == "csv":
        items = list(csv.DictReader(io.StringIO(content)))
    else:
        items = [json.loads(line) for line in content.splitlines() if line.strip()]
    for item in items:
        await add_case(dataset_id, DatasetCaseWrite(prompt=str(item.get("prompt") or ""), expected=str(item.get("expected") or ""), evaluator=item.get("evaluator") or {"type": "exact"}, metadata=item.get("metadata") or {}), request)
    return {"imported": len(items)}


@router.delete("/api/datasets/{dataset_id}")
async def delete_dataset(dataset_id: str, request: Request):
    row = await request.app.state.db.fetchone("SELECT builtin FROM datasets WHERE id=?", (dataset_id,))
    if row and row["builtin"]:
        raise ValueError("内置数据集不能删除")
    await request.app.state.db.execute("DELETE FROM datasets WHERE id=?", (dataset_id,))
    return {"ok": True}


@router.post("/api/evaluations")
async def start_evaluation(body: EvaluationStart, request: Request):
    experiment_id, now = uuid.uuid4().hex, time.time()
    await request.app.state.db.execute(
        "INSERT INTO experiments(id, name, dataset_id, provider_id, model, config_json, status, created_at) VALUES(?, ?, ?, ?, ?, ?, 'running', ?)",
        (experiment_id, body.name, body.dataset_id, body.provider_id, body.model, json.dumps(body.config_snapshot, ensure_ascii=False), now),
    )
    payload = {**body.model_dump(), "experiment_id": experiment_id}
    # Lock GPU/llama-server only when the target is the local engine; a remote
    # API target must not block (or be blocked by) local server lifecycle.
    resources = ["gpu", "llama_server"] if body.provider_id == "local" else []
    job = await request.app.state.jobs.create(JobCreate(kind="evaluation", payload=payload, resources=resources))
    return {"experiment_id": experiment_id, "job": job}


@router.get("/api/experiments")
async def list_experiments(request: Request):
    rows = await request.app.state.db.fetchall("SELECT * FROM experiments ORDER BY created_at DESC")
    for row in rows:
        row["metrics"] = json.loads(row.pop("metrics_json")); row["config"] = json.loads(row.pop("config_json"))
    return {"experiments": rows, "pareto": pareto_front([row for row in rows if row["status"] == "succeeded"])}


@router.get("/api/experiments/{experiment_id}")
async def get_experiment(experiment_id: str, request: Request):
    row = await request.app.state.db.fetchone("SELECT * FROM experiments WHERE id=?", (experiment_id,))
    if not row:
        raise KeyError("Experiment not found")
    row["metrics"] = json.loads(row.pop("metrics_json")); row["config"] = json.loads(row.pop("config_json"))
    results = await request.app.state.db.fetchall("SELECT * FROM evaluation_results WHERE experiment_id=? ORDER BY id", (experiment_id,))
    for result in results: result["details"] = json.loads(result.pop("details_json"))
    row["results"] = results
    return row
