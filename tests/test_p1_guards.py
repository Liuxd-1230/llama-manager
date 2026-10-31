"""P1 regression guards: MOSS 3D exact-body protections, job/event retention
and project deletion cascade. All fixtures run on isolated databases."""
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.atelier import store
from backend.main import app
from backend.moss_server import db as studio
from backend.moss_server.layout_core import compile_checks, compile_safe, sanitize_body
from backend.moss_server.ops import Workbench, compact_item


def _layout_doc(width=1024, height=1024, camera_on=False):
    doc = studio.normalize_doc({"kind": "layout", "layout": {
        "width": width, "height": height, "bbox_coord_space": "abs", "bbox_format": "xyxy",
        "summary": {"caption": "A composed image.", "canvas": "single"}, "items": [],
        "camera": {"enabled": camera_on},
    }})
    return doc


class Layout3DGuardTests(unittest.TestCase):
    def test_exact_body_keeps_precision_and_flag(self):
        kept = sanitize_body({"z": 1.23456789, "thickness": 0.123456, "anchor": "world", "exact": True})
        self.assertTrue(kept["exact"])
        self.assertEqual(kept["z"], round(1.23456789, 5), "exact bodies need 5 decimals to avoid save drift")
        self.assertEqual(kept["thickness"], round(0.123456, 5))
        loose = sanitize_body({"z": 1.23456789, "thickness": 0.123456})
        self.assertNotIn("exact", loose)
        self.assertEqual(loose["z"], round(1.23456789, 4))

    def test_partially_out_of_canvas_exact_body_compiles_instead_of_erroring(self):
        # bbox is the initial-camera front face; sticking out of the canvas is
        # normal and must be clipped at compile, not rejected.
        doc = _layout_doc()
        doc["layout"]["items"] = [{
            "id": "b1", "label": "object", "caption": "A sculpture",
            "bbox": [-100, 100, 1100, 500], "body": {"anchor": "world", "exact": True},
        }]
        prompt, err = compile_safe(doc["layout"])
        self.assertIsNone(err)
        compiled = json.loads(prompt)
        w, h = doc["layout"]["width"], doc["layout"]["height"]
        self.assertEqual(compiled["items"][0]["bbox"], [100 - h // 2, 0 - w // 2, 500 - h // 2, 1024 - w // 2],
                         "compile must clip the initial-camera front face into the canvas")

    def test_fully_out_of_canvas_item_is_reported_not_crashed(self):
        doc = _layout_doc()
        doc["layout"]["items"] = [{
            "id": "b1", "label": "object", "caption": "Off canvas",
            "bbox": [1200, 1200, 1400, 1400], "body": {"anchor": "world", "exact": True},
        }]
        prompt, err = compile_safe(doc["layout"])
        self.assertIsNone(prompt)
        self.assertIn("出画", err)

    def test_compile_checks_accepts_view_argument(self):
        doc = _layout_doc()
        doc["layout"]["items"] = [{"id": "b1", "label": "object", "caption": "A sculpture",
                                   "bbox": [100, 100, 400, 400]}]
        problems = compile_checks(doc["layout"], {"items": {"b1": {"bbox": [100, 100, 400, 400]}}})
        self.assertEqual([p for p in problems if p.startswith("编译报错")], [])


class Workbench3DGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "atelier.db"
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(studio, "DB_PATH", self.path))
        self.stack.enter_context(patch.object(store, "DATABASE_PATH", self.path))
        studio.init()
        store.initialize()
        self.addCleanup(self.stack.close)
        self.addCleanup(self.temp.cleanup)

    def _workbench_with_item(self, body, bbox, camera_on):
        series = studio.create_series("3D")
        doc = _layout_doc(camera_on=camera_on)
        doc["layout"]["items"] = [{"id": "b1", "label": "object", "name": "雕塑", "caption": "A sculpture",
                                   "bbox": bbox, "body": body}]
        page = studio.create_page(series["id"], "第 1 页", doc)
        wb = Workbench(series["id"], page["id"])
        wb.set_current_doc(page["id"], doc)
        return wb, page["id"]

    def test_copying_view_bbox_back_is_ignored(self):
        # Camera on: the stored bbox is the initial-camera front face; the view
        # bbox is its projection. An agent copying the projection back must be
        # refused, not clamped into the canvas (which would squeeze the block).
        wb, pid = self._workbench_with_item({"anchor": "world"}, [200, 200, 600, 600], camera_on=True)
        wb.views[pid] = {"b1": {"bbox": [0, 0, 300, 300]}}
        message = wb.run("update_items", {"updates": [{"ref": "b1", "bbox": [0, 0, 300, 300]}]})
        self.assertIn("位置未改", message)
        self.assertEqual(wb.doc(pid)["layout"]["items"][0]["bbox"], [200, 200, 600, 600])

    def test_genuine_move_still_applies_for_camera_items(self):
        wb, pid = self._workbench_with_item({"anchor": "world"}, [200, 200, 600, 600], camera_on=True)
        wb.views[pid] = {"b1": {"bbox": [0, 0, 300, 300]}}
        message = wb.run("update_items", {"updates": [{"ref": "b1", "bbox": [250, 250, 650, 650]}]})
        self.assertIn("位置", message)
        self.assertEqual(wb.doc(pid)["layout"]["items"][0]["bbox"], [250, 250, 650, 650])

    def test_exact_body_may_stay_out_of_canvas_when_editing(self):
        # Camera off but exact: edits keep the initial-camera coordinates
        # (slack 2.0) instead of clamping to the canvas edge.
        wb, pid = self._workbench_with_item({"anchor": "world", "exact": True}, [-200, -200, 500, 500], camera_on=False)
        wb.run("update_items", {"updates": [{"ref": "b1", "bbox": [-300, -300, 500, 500]}]})
        self.assertEqual(wb.doc(pid)["layout"]["items"][0]["bbox"], [-300, -300, 500, 500])

    def test_canvas_resize_keeps_world3d_out_of_canvas(self):
        wb, pid = self._workbench_with_item({"anchor": "world", "exact": True}, [-200, 100, 500, 500], camera_on=False)
        wb.run("set_canvas_size", {"width": 2048, "height": 2048})
        bbox = wb.doc(pid)["layout"]["items"][0]["bbox"]
        self.assertEqual(bbox[0], -400, "2x canvas scale keeps the out-of-canvas front face with slack")

    def test_compact_item_reports_partly_out_of_frame(self):
        item = {"id": "b1", "name": "n", "label": "object", "bbox": [0, 0, 10, 10], "caption": "c"}
        view = {"b1": {"bbox": [0, 0, 10, 10], "partial": True}}
        self.assertTrue(compact_item(item, 1, view)["partly_out_of_frame"])


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "atelier.db"
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(store, "DATABASE_PATH", self.path))
        store.initialize()
        self.addCleanup(self.stack.close)
        self.addCleanup(self.temp.cleanup)

    def _counts(self):
        with store.connection() as db:
            jobs = db.execute("SELECT COUNT(*) FROM atelier_jobs").fetchone()[0]
            orphans = db.execute(
                "SELECT COUNT(*) FROM atelier_events e LEFT JOIN atelier_jobs j ON e.job_id=j.id WHERE j.id IS NULL"
            ).fetchone()[0]
            events = db.execute("SELECT COUNT(*) FROM atelier_events").fetchone()[0]
        return jobs, orphans, events

    def test_initialize_prunes_jobs_and_orphan_events(self):
        for index in range(520):
            job = store.create_job("test", f"job-{index}", {})
            with store.connection() as db:
                if index < 460:  # age out all but the newest 60
                    db.execute("UPDATE atelier_jobs SET updated_at=? WHERE id=?", (1_000_000 + index, job["id"]))
        jobs, orphans, _ = self._counts()
        self.assertEqual(jobs, 520)
        store.initialize()
        jobs, orphans, events = self._counts()
        self.assertEqual(jobs, store.JOB_RETENTION, "startup must cap the job table")
        self.assertEqual(orphans, 0, "pruned jobs must not leave orphan events")
        self.assertLessEqual(events, store.EVENT_JOB_RETENTION + 60,
                             "old terminal jobs' replay events must be dropped")

    def test_create_job_prunes_periodically_between_restarts(self):
        for index in range(55):
            store.create_job("test", f"job-{index}", {})
        jobs, orphans, _ = self._counts()
        self.assertLessEqual(jobs, store.JOB_RETENTION + 5)
        self.assertEqual(orphans, 0)


class ProjectDeleteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "atelier.db"
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(studio, "DB_PATH", self.path))
        self.stack.enter_context(patch.object(store, "DATABASE_PATH", self.path))
        studio.init()
        store.initialize()
        self.addCleanup(self.stack.close)
        self.addCleanup(self.temp.cleanup)
        self.client = TestClient(app)

    def _series_count(self, project_id):
        with studio.conn() as c:
            return c.execute("SELECT COUNT(*) FROM series WHERE project_id=?", (project_id,)).fetchone()[0]

    def test_deleting_other_project_cascades_series(self):
        other = store.put_object("project", "其他项目", {})
        studio.kv_set("current_project", other["id"])
        studio.create_series("B 的系列")
        studio.kv_set("current_project", "project_default")
        self.assertEqual(self._series_count(other["id"]), 1)

        response = self.client.delete(f"/api/v1/objects/project/{other['id']}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._series_count(other["id"]), 0)
        with self.assertRaises(KeyError):
            store.get_object(other["id"])
        self.assertEqual(self._series_count("project_default"), 1, "other projects must be untouched")

    def test_deleting_current_project_is_refused(self):
        self.assertEqual(self._series_count("project_default"), 1)  # seeded by init()
        response = self.client.delete("/api/v1/objects/project/project_default")
        self.assertEqual(response.status_code, 409)
        self.assertIsNotNone(store.get_object("project_default"))
        self.assertEqual(self._series_count("project_default"), 1)

    def test_kind_mismatch_is_rejected(self):
        asset = store.put_object("character", "Alice", {})
        response = self.client.delete(f"/api/v1/objects/project/{asset['id']}")
        self.assertEqual(response.status_code, 400)
        self.assertIsNotNone(store.get_object(asset["id"]))


if __name__ == "__main__":
    unittest.main()
