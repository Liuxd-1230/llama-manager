import asyncio
import re
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import config_manager as cfg
from backend import provider_manager as providers
from backend.main import _deepseek_chat_payload, _local_chat_payload, app
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
