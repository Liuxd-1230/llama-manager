import asyncio
import re
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend import config_manager as cfg
from backend import provider_manager as providers
from backend.main import (
    _deepseek_chat_payload,
    _external_chat_request,
    _local_chat_payload,
    _looks_like_missed_web_search,
    _messages_with_web_tool_guidance,
    _prepare_chat_tool_followup,
    _search_web,
    _normalize_non_stream_response,
    app,
)
from backend.models import AppConfig, BasicSettings
from backend.process_manager import process_manager


ROOT = Path(__file__).resolve().parents[1]


class SecurityRegressionTests(unittest.TestCase):
    def test_remote_clients_cannot_browse_local_files(self):
        client = TestClient(app, client=("192.168.1.20", 50000))

        response = client.get("/api/browse", params={"dir": "C:\\"})

        self.assertEqual(response.status_code, 403)

    def test_remote_clients_cannot_start_compile_commands(self):
        client = TestClient(app, client=("192.168.1.20", 50000))

        response = client.post("/api/update/compile")

        self.assertEqual(response.status_code, 403)


class OptimizerRegressionTests(unittest.TestCase):
    def test_optimize_start_returns_before_optimization_finishes(self):
        async def slow_optimization(**_kwargs):
            await asyncio.sleep(5)

        client = TestClient(app)
        cfg.save_config(AppConfig(llama_cpp_dir="C:\\llama.cpp", model_path="C:\\model.gguf"))

        with patch("backend.main.optimizer.run_optimization", side_effect=slow_optimization):
            started_at = time.monotonic()
            response = client.post("/api/optimize/start", json={"n_trials": 1})
            elapsed = time.monotonic() - started_at

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})
        self.assertLess(elapsed, 1.0)


class CommandRegressionTests(unittest.TestCase):
    def test_fit_mode_leaves_ngl_unset_for_llama_cpp_auto_fit(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            server_bin = root / "build" / "bin" / "llama-server.exe"
            server_bin.parent.mkdir(parents=True)
            server_bin.write_text("", encoding="utf-8")
            config = AppConfig(
                llama_cpp_dir=str(root),
                model_path="C:\\models\\model.gguf",
                basic=BasicSettings(ngl_enabled=True, ngl=99, fit_enabled=True, fit_target=2048),
            )

            cmd = process_manager.build_command(config)

        self.assertIn("--fit", cmd)
        self.assertIn("on", cmd)
        self.assertIn("--fit-target", cmd)
        self.assertIn("2048", cmd)
        self.assertNotIn("-ngl", cmd)


class FrontendRegressionTests(unittest.TestCase):
    def test_ui_from_cfg_restores_mtp_draft_min(self):
        app_js = (ROOT / "frontend" / "app.js").read_text(encoding="utf-8")
        ui_from_cfg = app_js.split("function uiFromCfg(c){", 1)[1].split("async function loadInitCfg", 1)[0]

        self.assertIn("mtpDraftNMin", ui_from_cfg)
        self.assertRegex(ui_from_cfg, r"mtpDraftNMin'\)\.value\s*=\s*m\.draft_n_min\?\?0")

    def test_lucide_init_is_guarded(self):
        app_js = (ROOT / "frontend" / "app.js").read_text(encoding="utf-8")

        self.assertIsNone(re.search(r"^lucide\.createIcons\(\);$", app_js, re.MULTILINE))
        self.assertIn("typeof lucide!=='undefined'", app_js)

    def test_chat_toolbar_uses_config_sampling_instead_of_duplicate_controls(self):
        index_html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")

        self.assertNotIn("chatTemp", index_html)
        self.assertNotIn("chatMaxTokens", index_html)

    def test_chat_toolbar_exposes_streaming_regenerate_and_web_search_tool_controls(self):
        index_html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
        app_js = (ROOT / "frontend" / "app.js").read_text(encoding="utf-8")

        self.assertIn("chatStream", index_html)
        self.assertIn("regenerateLastTurn", index_html)
        self.assertIn("chatWebSearch", index_html)
        self.assertIn("web_search_tool", app_js)
        self.assertIn("prevCandidate", app_js)
        self.assertIn("nextCandidate", app_js)

    def test_password_inputs_share_liquid_glass_field_styles(self):
        style_css = (ROOT / "frontend" / "style.css").read_text(encoding="utf-8")

        self.assertRegex(style_css, r"input\[type=\"text\"\].*input\[type=\"password\"\].*select,\s*textarea")

    def test_chat_loads_markdown_and_latex_renderers(self):
        index_html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
        app_js = (ROOT / "frontend" / "app.js").read_text(encoding="utf-8")

        self.assertIn("marked", index_html)
        self.assertIn("katex", index_html)
        self.assertIn("DOMPurify", index_html)
        self.assertIn("renderMarkdown", app_js)
        self.assertIn("tool_event", app_js)
        self.assertIn("工具调用", app_js)


class ChatProxyRegressionTests(unittest.TestCase):
    def test_local_chat_payload_uses_saved_sampling_and_omits_reasoning_controls(self):
        config = AppConfig()
        payload = _local_chat_payload(
            {
                "model": "local-model",
                "messages": [{"role": "user", "content": "hi"}],
                "thinking_enabled": True,
                "reasoning_effort": "max",
            },
            config,
            [{"role": "user", "content": "hi"}],
        )

        self.assertEqual(payload["temperature"], config.sampling.temperature)
        self.assertNotIn("thinking", payload)
        self.assertNotIn("reasoning_effort", payload)

    def test_deepseek_thinking_payload_only_sends_high_or_max(self):
        payload = _deepseek_chat_payload(
            {
                "model": "deepseek-v4-flash",
                "messages": [{"role": "user", "content": "hi"}],
                "thinking_enabled": True,
                "reasoning_effort": "low",
            },
            [{"role": "user", "content": "hi"}],
        )

        self.assertEqual(payload["thinking"], {"type": "enabled"})
        self.assertEqual(payload["reasoning_effort"], "high")

    def test_non_stream_provider_responses_are_normalized_for_frontend(self):
        openai = _normalize_non_stream_response("openai_responses", {
            "output": [{"content": [{"type": "output_text", "text": "hello"}]}],
        })
        anthropic = _normalize_non_stream_response("anthropic", {
            "content": [{"type": "text", "text": "hi"}],
        })

        self.assertEqual(openai["choices"][0]["message"]["content"], "hello")
        self.assertEqual(anthropic["choices"][0]["message"]["content"], "hi")

    def test_chat_completion_provider_gets_web_search_tool_definition(self):
        provider = providers.ProviderConfig(
            id="compat",
            name="Compat",
            kind="openai_compatible",
            base_url="https://example.com/v1",
            default_model="test-model",
        )

        _target, payload = _external_chat_request(
            provider,
            {"model": "test-model", "web_search": True, "stream": False},
            [{"role": "user", "content": "need current info"}],
        )

        self.assertEqual(payload["tool_choice"], "auto")
        self.assertEqual(payload["tools"][0]["function"]["name"], "web_search")

    def test_local_chat_payload_can_expose_web_search_tool_definition(self):
        payload = _local_chat_payload(
            {"model": "local-model", "web_search_tool": True, "stream": False},
            AppConfig(),
            [{"role": "user", "content": "need current info"}],
        )

        self.assertEqual(payload["tool_choice"], "auto")
        self.assertEqual(payload["tools"][0]["function"]["name"], "web_search")

    def test_web_search_tool_guidance_tells_model_to_search_when_uncertain(self):
        messages = _messages_with_web_tool_guidance([{"role": "user", "content": "这周的新闻"}], True)

        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("uncertain", messages[0]["content"])
        self.assertIn("call `web_search`", messages[0]["content"])

    def test_missed_web_search_detector_catches_uncertain_connectivity_answers(self):
        self.assertTrue(_looks_like_missed_web_search("抱歉，我目前无法联网搜索实时的本周新闻。"))

    def test_normalized_external_response_preserves_tool_events(self):
        normalized = _normalize_non_stream_response(
            "anthropic",
            {"content": [{"type": "text", "text": "hi"}], "tool_events": [{"type": "skip", "message": "no call"}]},
        )

        self.assertEqual(normalized["tool_events"][0]["type"], "skip")

    def test_chat_tool_followup_keeps_final_answer_streaming(self):
        requests = []

        class FakeResponse:
            def __init__(self, payload):
                self._payload = payload

            def raise_for_status(self):
                pass

            def json(self):
                return self._payload

        async def fake_post(_self, _url, json=None, headers=None):
            requests.append(json)
            if len(requests) == 1:
                return FakeResponse({
                    "choices": [{"message": {"role": "assistant", "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "web_search", "arguments": "{\"query\":\"today news\"}"},
                    }]}}],
                })
            self.fail("final response should be streamed by caller, not fetched in prepare step")

        payload = {
            "model": "m",
            "messages": [{"role": "user", "content": "today news"}],
            "tools": [{"type": "function", "function": {"name": "web_search", "parameters": {"type": "object"}}}],
            "tool_choice": "auto",
        }
        with patch("httpx.AsyncClient.post", new=fake_post), patch("backend.main._run_web_search_tool", new=AsyncMock(return_value="[1] ok")):
            events, followup = asyncio.run(_prepare_chat_tool_followup("https://example.test", {}, payload, max_rounds=1))

        self.assertTrue(any(event["type"] == "call" for event in events))
        self.assertTrue(followup["stream"])
        self.assertNotIn("tools", followup)

    def test_search_web_falls_back_to_bing_when_duckduckgo_fails(self):
        class FakeResponse:
            def __init__(self, text, content_type="text/html"):
                self.text = text
                self.headers = {"content-type": content_type}

            def raise_for_status(self):
                pass

        async def fake_get(_self, url, **_kwargs):
            if "duckduckgo" in url:
                raise RuntimeError("duck timeout")
            if "bing.com/search" in url:
                return FakeResponse('<li class="b_algo"><h2><a href="https://example.com/news">Example News</a></h2><p>Snippet text</p></li>')
            return FakeResponse("<html><body>Full article text</body></html>")

        with patch("httpx.AsyncClient.get", new=fake_get):
            results = asyncio.run(_search_web("news", limit=1))

        self.assertEqual(results[0]["title"], "Example News")
        self.assertEqual(results[0]["url"], "https://example.com/news")


class ProviderConfigRegressionTests(unittest.TestCase):
    def test_default_deepseek_provider_uses_environment_key_without_exposing_it(self):
        with TemporaryDirectory() as tmp, patch.object(providers, "PROVIDERS_PATH", Path(tmp) / "providers.json"), patch.object(providers, "SECRETS_DIR", Path(tmp)), patch.dict("os.environ", {"DEEPSEEK_API_KEY": "sk-test"}):
            public = providers.list_providers()
            private = providers.get_provider("deepseek")

        self.assertEqual(public[0]["id"], "deepseek")
        self.assertEqual(public[0]["kind"], "deepseek")
        self.assertTrue(public[0]["api_key_set"])
        self.assertEqual(public[0]["api_key"], "")
        self.assertEqual(private.api_key, "sk-test")

    def test_saved_provider_round_trips_models_and_masks_key(self):
        with TemporaryDirectory() as tmp, patch.object(providers, "PROVIDERS_PATH", Path(tmp) / "providers.json"), patch.object(providers, "SECRETS_DIR", Path(tmp)):
            saved = providers.save_provider({
                "id": "openai-main",
                "name": "OpenAI",
                "kind": "openai_responses",
                "base_url": "https://api.openai.com/v1",
                "api_key": "sk-openai",
                "default_model": "gpt-4.1",
                "models": ["gpt-4.1", "gpt-4.1-mini"],
            })
            private = providers.get_provider("openai-main")

        self.assertTrue(saved["api_key_set"])
        self.assertEqual(saved["api_key"], "")
        self.assertEqual(private.default_model, "gpt-4.1")
        self.assertEqual(private.models, ["gpt-4.1", "gpt-4.1-mini"])


if __name__ == "__main__":
    unittest.main()
