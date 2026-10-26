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
        steps = next(i for i in sampler["inputs"] if i["name"] == "steps")
        self.assertEqual(steps["value"], 20)
        self.assertFalse(steps["is_link"])
        positive = next(i for i in sampler["inputs"] if i["name"] == "positive")
        self.assertTrue(positive["is_link"])

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

    def test_empty_prompt_keeps_the_template_text(self):
        nodes = comfy.parse_workflow(API_WORKFLOW)
        out = comfy.apply_bindings(nodes, {"positive": {"node": "6", "input": "text"}}, {"positive": "   "})
        self.assertEqual(out["6"]["inputs"]["text"], "a cat")

    def test_binding_to_a_missing_input_is_ignored_not_invented(self):
        nodes = comfy.parse_workflow(API_WORKFLOW)
        out = comfy.apply_bindings(nodes, {"positive": {"node": "6", "input": "nonexistent"}}, {"positive": "x"})
        self.assertNotIn("nonexistent", out["6"]["inputs"])

    def test_link_inputs_cannot_be_bound(self):
        nodes = comfy.parse_workflow(API_WORKFLOW)
        out = comfy.apply_bindings(nodes, {"positive": {"node": "3", "input": "positive"}}, {"positive": "x"})
        self.assertEqual(out["3"]["inputs"]["positive"], ["6", 0])


SDXL_WORKFLOW = {
    "6": {"class_type": "CLIPTextEncodeSDXL", "inputs": {"text_g": "global", "text_l": "local", "clip": ["4", 0]}},
    "7": {"class_type": "CLIPTextEncodeSDXL", "inputs": {"text_g": "bad", "text_l": "bad", "clip": ["4", 0]}},
    "9": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 20, "cfg": 7, "sampler_name": "euler",
                                                "scheduler": "normal", "positive": ["6", 0], "negative": ["7", 0]}},
}


class SdxlBindingTests(unittest.TestCase):
    def test_dual_encoder_binds_an_input_the_node_really_has(self):
        nodes = comfy.parse_workflow(SDXL_WORKFLOW)
        guess = comfy.guess_bindings(nodes)
        self.assertEqual(guess["positive"]["node"], "6")
        self.assertIn(guess["positive"]["input"], nodes["6"]["inputs"])
        out = comfy.apply_bindings(nodes, guess, {"positive": "a cat"})
        self.assertEqual(out["6"]["inputs"][guess["positive"]["input"]], "a cat")
        self.assertNotIn("text", out["6"]["inputs"], "invented a field the node never reads")

    def test_validate_reports_stale_bindings(self):
        nodes = comfy.parse_workflow(SDXL_WORKFLOW)
        self.assertIsNone(comfy.validate_binding(nodes, "seed", {"node": "9", "input": "seed"}))
        self.assertIn("没有节点", comfy.validate_binding(nodes, "seed", {"node": "99", "input": "seed"}) or "")
        self.assertIn("没有输入", comfy.validate_binding(nodes, "seed", {"node": "9", "input": "nope"}) or "")
        self.assertIn("连线", comfy.validate_binding(nodes, "positive", {"node": "9", "input": "positive"}) or "")


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


class GraphTests(unittest.TestCase):
    def test_graph_has_nodes_edges_and_layered_positions(self):
        nodes = comfy.parse_workflow(API_WORKFLOW)
        graph = comfy.build_graph(nodes)
        self.assertEqual(len(graph["nodes"]), 4)
        # KSampler's positive/negative/latent edges are three of them
        targets = {(e["source"], e["target"]) for e in graph["edges"]}
        self.assertIn(("6", "3"), targets)
        self.assertIn(("7", "3"), targets)  # negative
        # loaders (6,7) sit left of the sampler (3)
        by_id = {n["id"]: n for n in graph["nodes"]}
        self.assertLess(by_id["6"]["position"]["x"], by_id["3"]["position"]["x"])

    def test_saved_layout_overrides_computed_positions(self):
        nodes = comfy.parse_workflow(API_WORKFLOW)
        graph = comfy.build_graph(nodes, {"3": {"x": 999, "y": 42}})
        sampler = next(n for n in graph["nodes"] if n["id"] == "3")
        self.assertEqual(sampler["position"], {"x": 999, "y": 42})

    def test_graph_exposes_link_flags_and_literal_values(self):
        nodes = comfy.parse_workflow(API_WORKFLOW)
        graph = comfy.build_graph(nodes)
        sampler = next(n for n in graph["nodes"] if n["id"] == "3")
        steps = next(i for i in sampler["inputs"] if i["name"] == "steps")
        positive = next(i for i in sampler["inputs"] if i["name"] == "positive")
        self.assertEqual(steps["value"], 20)
        self.assertFalse(steps["is_link"])
        self.assertTrue(positive["is_link"])


class ChoiceTests(unittest.IsolatedAsyncioTestCase):
    """Sampler/scheduler dropdowns are fed by ComfyUI's own widget domains."""

    OBJECT_INFO = {
        "KSampler": {"input": {"required": {
            "sampler_name": [["euler", "dpmpp_2m"], {"default": "euler"}],
            "scheduler": [["normal", "karras"], {"default": "normal"}],
            "steps": ["INT", {"default": 20}],
        }}},
    }

    async def test_extracts_domains(self):
        response = mock.Mock(status_code=200, json=mock.Mock(return_value=self.OBJECT_INFO))
        client = mock.AsyncMock()
        client.get.return_value = response
        client.__aenter__.return_value = client
        client.__aexit__.return_value = False
        with mock.patch.object(comfy.httpx, "AsyncClient", return_value=client):
            out = await comfy.fetch_choices("http://127.0.0.1:8188")
        self.assertEqual(out["samplers"], ["euler", "dpmpp_2m"])
        self.assertEqual(out["schedulers"], ["normal", "karras"])

    async def test_offline_degrades_to_empty_lists(self):
        client = mock.AsyncMock()
        client.get.side_effect = comfy.httpx.RequestError("offline")
        client.__aenter__.return_value = client
        client.__aexit__.return_value = False
        with mock.patch.object(comfy.httpx, "AsyncClient", return_value=client):
            out = await comfy.fetch_choices("http://127.0.0.1:1")
        self.assertEqual(out, {"samplers": [], "schedulers": []})

    async def test_unknown_node_yields_empty(self):
        response = mock.Mock(status_code=200, json=mock.Mock(return_value={}))
        client = mock.AsyncMock()
        client.get.return_value = response
        client.__aenter__.return_value = client
        client.__aexit__.return_value = False
        with mock.patch.object(comfy.httpx, "AsyncClient", return_value=client):
            out = await comfy.fetch_choices("http://127.0.0.1:8188")
        self.assertEqual(out["samplers"], [])


class EmptyKeyAuthTests(unittest.TestCase):
    """The local engine has no key; a bare 'Bearer ' header makes it reject us."""

    def test_empty_key_sends_no_authorization_header(self):
        from backend.moss_server import api as moss_api
        self.assertEqual(moss_api._auth_headers(""), {})

    def test_present_key_sends_bearer(self):
        from backend.moss_server import api as moss_api
        self.assertEqual(moss_api._auth_headers("sk-x"), {"Authorization": "Bearer sk-x"})
