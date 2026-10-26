"""ComfyUI bridge: workflow parsing, placeholder binding, submission errors."""

from __future__ import annotations

import json
import unittest
from unittest import mock

from backend.moss_server import comfy

API_WORKFLOW = {
    "3": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 20, "cfg": 7, "sampler_name": "euler", "scheduler": "normal", "positive": ["6", 0], "negative": ["7", 0]}},
    "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512}},
    "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat"}},
    "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry"}},
}


class WorkflowParsingTests(unittest.TestCase):
    def test_api_format_is_accepted_and_flattened(self):
        nodes = comfy.parse_workflow(json.dumps(API_WORKFLOW))
        self.assertEqual(set(nodes), {"3", "5", "6", "7"})
        choices = comfy.node_choices(nodes)
        sampler = next(c for c in choices if c["node"] == "3")
        self.assertEqual(sampler["class_type"], "KSampler")
        self.assertIn({"name": "steps", "type": "int"}, sampler["inputs"])

    def test_ui_export_is_rejected_with_hint(self):
        with self.assertRaises(comfy.ComfyError) as caught:
            comfy.parse_workflow(json.dumps({"nodes": [], "links": []}))
        self.assertIn("API Format", str(caught.exception))

    def test_unknown_shape_is_rejected(self):
        with self.assertRaises(comfy.ComfyError):
            comfy.parse_workflow(json.dumps({"foo": "bar"}))


class BindingTests(unittest.TestCase):
    def test_bound_fields_replace_inputs_without_mutating_source(self):
        nodes = comfy.parse_workflow(API_WORKFLOW)
        bindings = {
            "positive": {"node": "6", "input": "text"},
            "negative": {"node": "7", "input": "text"},
            "seed": {"node": "3", "input": "seed"},
            "width": {"node": "5", "input": "width"},
            "height": {"node": "5", "input": "height"},
            "steps": {"node": "3", "input": "steps"},
            "cfg": {"node": "3", "input": "cfg"},
            "sampler": {"node": "3", "input": "sampler_name"},
            "scheduler": {"node": "3", "input": "scheduler"},
        }
        values = {"positive": "a dog", "negative": "ugly", "seed": 42, "width": 1024,
                  "height": 1536, "steps": 28, "cfg": 5.5, "sampler": "dpmpp_2m", "scheduler": "karras"}
        out = comfy.apply_bindings(nodes, bindings, values)
        self.assertEqual(out["6"]["inputs"]["text"], "a dog")
        self.assertEqual(out["7"]["inputs"]["text"], "ugly")
        self.assertEqual(out["3"]["inputs"]["seed"], 42)
        self.assertEqual(out["3"]["inputs"]["steps"], 28)
        self.assertEqual(out["3"]["inputs"]["cfg"], 5.5)
        self.assertEqual(out["3"]["inputs"]["sampler_name"], "dpmpp_2m")
        self.assertEqual(out["3"]["inputs"]["scheduler"], "karras")
        self.assertEqual(out["5"]["inputs"]["width"], 1024)
        self.assertEqual(out["5"]["inputs"]["height"], 1536)
        # source untouched
        self.assertEqual(nodes["6"]["inputs"]["text"], "a cat")
        self.assertEqual(nodes["3"]["inputs"]["seed"], 1)

    def test_missing_value_or_bad_node_leaves_workflow_intact(self):
        nodes = comfy.parse_workflow(API_WORKFLOW)
        out = comfy.apply_bindings(nodes, {"seed": {"node": "3", "input": "seed"}, "steps": {"node": "99", "input": "steps"}}, {})
        self.assertEqual(out["3"]["inputs"]["seed"], 1)

    def test_partial_binding_still_runs(self):
        nodes = comfy.parse_workflow(API_WORKFLOW)
        out = comfy.apply_bindings(nodes, {"positive": {"node": "6", "input": "text"}}, {"positive": "x"})
        self.assertEqual(out["6"]["inputs"]["text"], "x")
        self.assertEqual(out["3"]["inputs"]["steps"], 20)


class SubmitTests(unittest.IsolatedAsyncioTestCase):
    async def test_upstream_error_surfaces_as_comfy_error(self):
        response = mock.Mock(status_code=400, text="bad workflow")
        client = mock.AsyncMock()
        client.post.return_value = response
        client.__aenter__.return_value = client
        client.__aexit__.return_value = False
        with mock.patch.object(comfy.httpx, "AsyncClient", return_value=client):
            with self.assertRaises(comfy.ComfyError) as caught:
                await comfy.submit("http://127.0.0.1:8188", {"1": {"class_type": "X", "inputs": {}}})
        self.assertIn("bad workflow", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
