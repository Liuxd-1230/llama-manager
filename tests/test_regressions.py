import asyncio
import json
import re
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend import config_manager as cfg
from backend import provider_manager as providers
from backend import search_manager
from backend.chat_state import CandidateContext, ConversationStore
from backend.main import (
    _deepseek_chat_payload,
    _external_chat_request,
    _local_chat_payload,
    _messages_with_web_tool_guidance,
    _normalize_non_stream_response,
    _normalize_v2_stream,
    _parse_dsml_tool_calls,
    _stream_anthropic_with_tools,
    _stream_chat_with_tools,
    _stream_responses_with_tools,
    _strip_dsml_tool_blocks,
    app,
)
from backend.models import AppConfig, BasicSettings
from backend.process_manager import process_manager


ROOT = Path(__file__).resolve().parents[1]


async def collect(iterator):
    return [item async for item in iterator]


class FakeStreamResponse:
    status_code = 200

    def __init__(self, chunks):
        self.chunks = chunks

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def aiter_text(self):
        for chunk in self.chunks:
            yield chunk

    async def aiter_lines(self):
        for chunk in self.chunks:
            for line in chunk.splitlines():
                yield line

    async def aiter_bytes(self):
        for chunk in self.chunks:
            yield chunk.encode("utf-8")

    async def aread(self):
        return "".join(self.chunks).encode()


def sse(payload):
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


class SecurityRegressionTests(unittest.TestCase):
    def test_remote_clients_cannot_browse_local_files(self):
        response = TestClient(app, client=("192.168.1.20", 50000)).get("/api/browse", params={"dir": "C:\\"})
        self.assertEqual(response.status_code, 403)

    def test_remote_clients_cannot_start_compile_commands(self):
        response = TestClient(app, client=("192.168.1.20", 50000)).post("/api/update/compile")
        self.assertEqual(response.status_code, 403)

    def test_unknown_provider_does_not_fall_back_to_local_server(self):
        response = TestClient(app).post("/api/chat", json={"provider": "missing", "messages": [], "stream": False})
        self.assertEqual(response.status_code, 404)

    def test_disabled_and_unconfigured_providers_return_conflict(self):
        disabled = providers.ProviderConfig(id="disabled", name="Disabled", kind="openai_chat", enabled=False)
        missing_key = providers.ProviderConfig(id="missing-key", name="Missing Key", kind="openai_chat", enabled=True)
        with patch("backend.main.providers.get_provider", return_value=disabled):
            self.assertEqual(TestClient(app).post("/api/chat", json={"provider": "disabled", "messages": [], "stream": False}).status_code, 409)
        with patch("backend.main.providers.get_provider", return_value=missing_key), patch("backend.main.providers.resolve_api_key", return_value=""):
            self.assertEqual(TestClient(app).post("/api/chat", json={"provider": "missing-key", "messages": [], "stream": False}).status_code, 409)


class OptimizerRegressionTests(unittest.TestCase):
    def test_optimize_start_returns_before_optimization_finishes(self):
        async def slow_optimization(**_kwargs):
            await asyncio.sleep(5)

        client = TestClient(app)
        cfg.save_config(AppConfig(llama_cpp_dir="C:\\llama.cpp", model_path="C:\\model.gguf"))
        with patch("backend.main.optimizer.run_optimization", side_effect=slow_optimization):
            started_at = time.monotonic()
            response = client.post("/api/optimize/start", json={"n_trials": 1})
        self.assertEqual(response.status_code, 200)
        self.assertLess(time.monotonic() - started_at, 1.0)


class CommandRegressionTests(unittest.TestCase):
    def test_fit_mode_leaves_ngl_unset_for_llama_cpp_auto_fit(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            server_bin = root / "build" / "bin" / "llama-server.exe"
            server_bin.parent.mkdir(parents=True)
            server_bin.write_text("", encoding="utf-8")
            config = AppConfig(llama_cpp_dir=str(root), model_path="C:\\models\\model.gguf", basic=BasicSettings(ngl_enabled=True, ngl=99, fit_enabled=True, fit_target=2048))
            command = process_manager.build_command(config)
        self.assertIn("--fit", command)
        self.assertIn("--fit-target", command)
        self.assertNotIn("-ngl", command)


class FrontendRegressionTests(unittest.TestCase):
    def test_react_stack_and_safe_markdown_are_declared(self):
        package = json.loads((ROOT / "frontend-src" / "package.json").read_text(encoding="utf-8"))
        markdown = (ROOT / "frontend-src" / "src" / "features" / "chat" / "Markdown.tsx").read_text(encoding="utf-8")
        self.assertIn("react", package["dependencies"])
        self.assertIn("motion", package["dependencies"])
        self.assertIn("rehype-sanitize", package["dependencies"])
        self.assertIn("rehypeSanitize", markdown)

    def test_only_light_and_dark_theme_tokens_exist(self):
        tokens = (ROOT / "frontend-src" / "src" / "styles" / "tokens.css").read_text(encoding="utf-8")
        app = (ROOT / "frontend-src" / "src" / "App.tsx").read_text(encoding="utf-8")
        self.assertIn("data-theme='dark'", tokens)
        self.assertNotIn("apple", tokens.lower())
        self.assertIn("Theme", app)

    def test_all_five_workspaces_are_routed(self):
        app = (ROOT / "frontend-src" / "src" / "App.tsx").read_text(encoding="utf-8")
        for page in ("config", "run", "optimize", "maintenance", "chat"):
            self.assertIn(f'path="/{page}"', app)

    def test_chat_is_id_addressed_and_blocks_enter_during_generation(self):
        reducer = (ROOT / "frontend-src" / "src" / "features" / "chat" / "chatReducer.ts").read_text(encoding="utf-8")
        chat = (ROOT / "frontend-src" / "src" / "features" / "chat" / "ChatPage.tsx").read_text(encoding="utf-8")
        self.assertIn("candidate.id", reducer)
        self.assertIn("turn.id", reducer)
        self.assertIn("请先停止当前生成", chat)
        self.assertIn("parent_candidate_id", chat)

    def test_settings_never_render_api_key_input(self):
        settings = (ROOT / "frontend-src" / "src" / "components" / "SettingsDrawer.tsx").read_text(encoding="utf-8")
        self.assertNotRegex(settings, r'type=["\']password')
        self.assertIn("api_key_env", settings)

    def test_production_build_is_committed_surface(self):
        index = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
        self.assertIn("/static/assets/", index)
        self.assertTrue((ROOT / "frontend" / "assets").exists())


class ProviderConfigRegressionTests(unittest.TestCase):
    def test_environment_key_is_reported_but_never_returned(self):
        with TemporaryDirectory() as tmp, patch.object(providers, "PROVIDERS_PATH", Path(tmp) / "providers.json"), patch.object(providers, "SECRETS_DIR", Path(tmp)), patch.dict("os.environ", {"DEEPSEEK_API_KEY": "sk-test"}):
            public = providers.list_providers()[0]
            private = providers.get_provider("deepseek")
        self.assertTrue(public["api_key_set"])
        self.assertNotIn("api_key", public)
        self.assertFalse(hasattr(private, "api_key"))

    def test_provider_save_rejects_submitted_keys(self):
        with self.assertRaises(ValueError):
            providers.save_provider({"id": "x", "kind": "openai_chat", "api_key": "sk-secret"})

    def test_legacy_key_is_migrated_then_removed_from_json(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            path.write_text(json.dumps([{"id": "compat", "name": "Compat", "kind": "openai_compatible", "base_url": "https://example.test/v1", "api_key": "sk-old"}]), encoding="utf-8")
            with patch.object(providers, "PROVIDERS_PATH", path), patch.object(providers, "SECRETS_DIR", Path(tmp)), patch("backend.provider_manager.set_user_env") as migrate:
                providers.list_providers()
            migrate.assert_called_once_with("LLAMA_MANAGER_PROVIDER_COMPAT_API_KEY", "sk-old")
            self.assertNotIn("api_key", path.read_text(encoding="utf-8"))

    def test_failed_legacy_key_migration_keeps_json_and_blocks_provider(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            path.write_text(json.dumps([{"id": "compat", "name": "Compat", "kind": "openai_compatible", "base_url": "https://example.test/v1", "api_key": "sk-old"}]), encoding="utf-8")
            with patch.object(providers, "PROVIDERS_PATH", path), patch.object(providers, "SECRETS_DIR", Path(tmp)), patch("backend.provider_manager.set_user_env", side_effect=OSError("ACL failed")):
                public = next(item for item in providers.list_providers() if item["id"] == "compat")
                private = providers.get_provider("compat")
            self.assertIn("api_key", path.read_text(encoding="utf-8"))
            self.assertFalse(public["enabled"])
            self.assertFalse(public["api_key_set"])
            self.assertIn("迁移失败", public["migration_error"])
            self.assertFalse(private.enabled)

    def test_saved_metadata_round_trips_without_secret(self):
        with TemporaryDirectory() as tmp, patch.object(providers, "PROVIDERS_PATH", Path(tmp) / "providers.json"), patch.object(providers, "SECRETS_DIR", Path(tmp)):
            saved = providers.save_provider({"id": "openai-main", "name": "OpenAI", "kind": "openai_responses", "base_url": "https://api.openai.com/v1", "default_model": "gpt-4.1", "models": ["gpt-4.1"], "enabled": True})
            raw = (Path(tmp) / "providers.json").read_text(encoding="utf-8")
        self.assertEqual(saved["default_model"], "gpt-4.1")
        self.assertNotIn("api_key", raw)


class SearchRegressionTests(unittest.TestCase):
    def test_tavily_uses_fixed_api_endpoint_without_redirects(self):
        requests = []

        class Response:
            def raise_for_status(self): pass
            def json(self): return {"results": [{"title": "Result", "url": "https://example.com", "content": "Summary", "score": .9}]}

        async def post(_self, url, **kwargs): requests.append((url, kwargs)); return Response()
        with patch.object(search_manager, "_read_settings", return_value=search_manager.SearchSettings(provider="tavily")), patch("backend.search_manager.env_value", return_value="tvly-test"), patch("httpx.AsyncClient.post", new=post):
            provider, results = asyncio.run(search_manager.search_web("query", 3))
        self.assertEqual(provider, "tavily")
        self.assertEqual(requests[0][0], "https://api.tavily.com/search")
        self.assertEqual(results[0]["snippet"], "Summary")

    def test_brave_uses_fixed_api_endpoint(self):
        requests = []

        class Response:
            def raise_for_status(self): pass
            def json(self): return {"web": {"results": [{"title": "Result", "url": "https://example.com", "description": "Summary"}]}}

        async def get(_self, url, **kwargs): requests.append((url, kwargs)); return Response()
        with patch.object(search_manager, "_read_settings", return_value=search_manager.SearchSettings(provider="brave")), patch("backend.search_manager.env_value", return_value="brave-test"), patch("httpx.AsyncClient.get", new=get):
            provider, results = asyncio.run(search_manager.search_web("query", 3))
        self.assertEqual(provider, "brave")
        self.assertEqual(requests[0][0], "https://api.search.brave.com/res/v1/web/search")
        self.assertEqual(results[0]["title"], "Result")

    def test_missing_search_key_fails_without_html_fallback(self):
        with patch.object(search_manager, "_read_settings", return_value=search_manager.SearchSettings(provider="tavily")), patch("backend.search_manager.env_value", return_value=""):
            with self.assertRaises(search_manager.SearchNotConfigured):
                asyncio.run(search_manager.search_web("query"))


class ChatProxyRegressionTests(unittest.TestCase):
    def test_local_payload_uses_config_sampling(self):
        config = AppConfig()
        payload = _local_chat_payload({"model": "local", "thinking_enabled": True}, config, [{"role": "user", "content": "hi"}])
        self.assertEqual(payload["temperature"], config.sampling.temperature)
        self.assertNotIn("thinking", payload)

    def test_deepseek_keeps_thinking_enabled_with_web_search(self):
        payload = _deepseek_chat_payload({"thinking_enabled": True, "reasoning_effort": "max", "web_search_tool": True}, [{"role": "user", "content": "hi"}])
        self.assertEqual(payload["thinking"], {"type": "enabled"})
        self.assertEqual(payload["reasoning_effort"], "max")

    def test_web_guidance_requires_native_tool_calls(self):
        messages = _messages_with_web_tool_guidance([{"role": "user", "content": "news"}], True)
        self.assertIn("native tool_calls", messages[0]["content"])

    def test_chat_completion_provider_gets_web_tool(self):
        provider = providers.ProviderConfig(id="compat", name="Compat", kind="openai_compatible", base_url="https://example.com/v1", default_model="m")
        _target, payload = _external_chat_request(provider, {"web_search_tool": True}, [{"role": "user", "content": "news"}])
        self.assertEqual(payload["tool_choice"], "auto")

    def test_stream_tool_round_preserves_reasoning_content(self):
        requests = []

        def stream(_self, _method, _url, json=None, headers=None):
            requests.append(json)
            if len(requests) == 1:
                return FakeStreamResponse([sse({"choices": [{"delta": {"reasoning_content": "need web"}}]}), sse({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": "web_search", "arguments": "{\"query\":\"news\"}"}}]}, "finish_reason": "tool_calls"}]}), "data: [DONE]\n\n"])
            return FakeStreamResponse([sse({"choices": [{"delta": {"content": "answer"}}]}), "data: [DONE]\n\n"])

        payload = {"model": "m", "messages": [{"role": "user", "content": "news"}], "tools": [{"type": "function", "function": {"name": "web_search"}}]}
        state = {}
        with patch("httpx.AsyncClient.stream", new=stream), patch("backend.main._run_web_search_tool", new=AsyncMock(return_value="[1] ok")):
            chunks = asyncio.run(collect(_stream_chat_with_tools("https://example.test", {}, payload, on_complete=state.update)))
        self.assertEqual(requests[1]["messages"][1]["reasoning_content"], "need web")
        self.assertIn("answer", "".join(chunks))
        self.assertEqual(state["kind"], "chat_messages")

    def test_cancelled_chat_stream_closes_provider_response(self):
        exited = False

        class Response(FakeStreamResponse):
            async def __aexit__(self, exc_type, exc, tb):
                nonlocal exited
                exited = True
                return False

        async def run():
            generator = _stream_chat_with_tools("https://example.test", {}, {"model": "m", "messages": []})
            with patch("httpx.AsyncClient.stream", return_value=Response([sse({"choices": [{"delta": {"content": "part"}}]})])):
                first = await anext(generator)
                await generator.aclose()
                return first

        self.assertIn("part", asyncio.run(run()))
        self.assertTrue(exited)

    def test_anthropic_tools_stream_final_content(self):
        requests = []

        def stream(_self, _method, _url, json=None, headers=None):
            requests.append(json)
            if len(requests) == 1:
                return FakeStreamResponse([sse({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "tool_1", "name": "web_search", "input": {}}}), sse({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"query\":\"news\"}"}})])
            return FakeStreamResponse([sse({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}), sse({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "final"}})])

        payload = {"model": "claude", "messages": [{"role": "user", "content": "news"}], "tools": [{"name": "web_search"}]}
        with patch("httpx.AsyncClient.stream", new=stream), patch("backend.main._run_web_search_tool", new=AsyncMock(return_value="ok")):
            output = "".join(asyncio.run(collect(_stream_anthropic_with_tools("https://example.test", {}, payload))))
        self.assertIn("final", output)
        self.assertEqual(len(requests), 2)

    def test_responses_tools_stream_final_content(self):
        requests = []

        def stream(_self, _method, _url, json=None, headers=None):
            requests.append(json)
            if len(requests) == 1:
                return FakeStreamResponse([sse({"type": "response.created", "response": {"id": "resp_1"}}), sse({"type": "response.output_item.added", "item": {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "web_search", "arguments": "{\"query\":\"news\"}"}})])
            return FakeStreamResponse([sse({"type": "response.created", "response": {"id": "resp_2"}}), sse({"type": "response.output_text.delta", "delta": "final"})])

        payload = {"model": "gpt", "input": "news", "tools": [{"type": "function", "name": "web_search"}]}
        with patch("httpx.AsyncClient.stream", new=stream), patch("backend.main._run_web_search_tool", new=AsyncMock(return_value="ok")):
            output = "".join(asyncio.run(collect(_stream_responses_with_tools("https://example.test", {}, payload))))
        self.assertIn("final", output)
        self.assertEqual(requests[1]["previous_response_id"], "resp_1")

    def test_v2_normalizer_emits_incremental_event_types(self):
        async def source():
            yield sse({"choices": [{"delta": {"content": "hello"}}]})
            yield "data: [DONE]\n\n"

        output = "".join(asyncio.run(collect(_normalize_v2_stream(source(), "candidate"))))
        self.assertIn('"type": "start"', output)
        self.assertIn('"type": "content_delta"', output)
        self.assertIn('"type": "done"', output)

    def test_dsml_helpers_remain_defensive(self):
        text = '<|DSML| tool_calls><|DSML| invoke name="web_search"><|DSML| parameter name="query">abc</|DSML| parameter></|DSML| invoke></|DSML| tool_calls>'
        self.assertEqual(_strip_dsml_tool_blocks(text), "")
        self.assertEqual(_parse_dsml_tool_calls(text)[0]["function"]["name"], "web_search")

    def test_non_stream_external_responses_normalize(self):
        openai = _normalize_non_stream_response("openai_responses", {"output": [{"content": [{"type": "output_text", "text": "hello"}]}]})
        anthropic = _normalize_non_stream_response("anthropic", {"content": [{"type": "text", "text": "hi"}]})
        self.assertEqual(openai["choices"][0]["message"]["content"], "hello")
        self.assertEqual(anthropic["choices"][0]["message"]["content"], "hi")


class ConversationStoreTests(unittest.TestCase):
    def test_candidate_context_is_branch_addressable(self):
        store = ConversationStore(ttl_seconds=60, max_conversations=2)
        context = CandidateContext(provider_id="deepseek", model="m", kind="chat_messages", state={"messages": [{"role": "user", "content": "hi"}]}, updated_at=time.time())
        store.put("conversation", "candidate", context)
        loaded = store.get("conversation", "candidate")
        self.assertEqual(loaded.state["messages"][0]["content"], "hi")
        self.assertTrue(store.delete("conversation"))


if __name__ == "__main__":
    unittest.main()
