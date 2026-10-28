"""Unit tests for the moss provider bridge: credential resolution, base URL
shaping, and the model fallback chain."""

from __future__ import annotations

import os
import unittest
from unittest import mock

from backend import provider_manager
from backend.moss_server import bridge


def _make_provider(**overrides):
    base = dict(id="p1", name="自建网关", kind="openai_chat", base_url="http://127.0.0.1:8000",
                default_model="m1", models=["m2"], enabled=True)
    base.update(overrides)
    return provider_manager.ProviderConfig(**base)


class BridgeTests(unittest.TestCase):
    def test_resolve_reads_env_key_and_appends_v1(self):
        provider = _make_provider()
        with mock.patch.object(bridge.provider_manager, "get_provider", return_value=provider):
            with mock.patch.dict(os.environ, {"LLAMA_MANAGER_PROVIDER_P1_API_KEY": "sk-test"}):
                resolved = bridge.resolve("p1")
        self.assertEqual(resolved["base_url"], "http://127.0.0.1:8000/v1")
        self.assertEqual(resolved["api_key"], "sk-test")

    def test_resolve_without_key_reports_unset(self):
        provider = _make_provider()
        env = {k: "" for k in os.environ if k.startswith("LLAMA_MANAGER_PROVIDER_")}
        with mock.patch.object(bridge.provider_manager, "get_provider", return_value=provider):
            with mock.patch.dict(os.environ, env, clear=False):
                resolved = bridge.resolve("p1")
        self.assertEqual(resolved["api_key"], "")

    def test_deepseek_base_url_is_kept_bare(self):
        provider = _make_provider(kind="openai_chat", base_url="https://api.deepseek.com")
        with mock.patch.object(bridge.provider_manager, "get_provider", return_value=provider):
            resolved = bridge.resolve("p1")
        self.assertEqual(resolved["base_url"], "https://api.deepseek.com")

    def test_anthropic_provider_is_available_to_shared_adapter(self):
        provider = _make_provider(kind="anthropic", base_url="https://api.anthropic.com")
        with mock.patch.object(bridge.provider_manager, "get_provider", return_value=provider):
            resolved = bridge.resolve("p1")
            self.assertEqual(resolved["provider"].kind, "anthropic")

    def test_model_chain_prefers_settings_then_provider_models_without_duplicates(self):
        provider = _make_provider(models=["m2", "m1"])
        with mock.patch.object(bridge.provider_manager, "get_provider", return_value=provider):
            with mock.patch.object(bridge, "resolve", return_value={"provider": provider, "base_url": "b", "api_key": "k"}):
                with mock.patch.object(bridge, "load_settings", return_value={"model": "m0", "fallback_models": "m1, m3"}):
                    chain = bridge.model_chain("p1")
        self.assertEqual(chain, ["m0", "m2", "m1", "m3"])


class LocalEngineBridgeTests(unittest.TestCase):
    """The managed llama-server participates as the synthetic "local" provider."""

    def test_local_resolve_targets_engine_v1_without_key(self):
        from backend import config_manager
        from backend.process_manager import ProcessManager

        config = config_manager.AppConfig(model_path="D:\models\hermes-35b.gguf")
        config.server.host = "0.0.0.0"
        config.server.port = 8080
        with mock.patch.object(config_manager, "get_config", return_value=config):
            with mock.patch.object(ProcessManager, "get_status", return_value=type("S", (), {"state": "running"})()):
                resolved = bridge.resolve("local")
        self.assertEqual(resolved["base_url"], "http://127.0.0.1:8080/v1")
        self.assertEqual(resolved["api_key"], "")
        self.assertEqual(resolved["provider"].kind, "local")
        self.assertEqual(resolved["provider"].default_model, "hermes-35b.gguf")
        self.assertIn("本地引擎", resolved["provider"].name)
        self.assertNotIn("未运行", resolved["provider"].name)

    def test_local_name_flags_stopped_engine(self):
        from backend import config_manager
        from backend.process_manager import ProcessManager

        config = config_manager.AppConfig(model_path="")
        with mock.patch.object(config_manager, "get_config", return_value=config):
            with mock.patch.object(ProcessManager, "get_status", return_value=type("S", (), {"state": "stopped"})()):
                resolved = bridge.resolve("local")
        self.assertIn("未运行", resolved["provider"].name)
        self.assertEqual(resolved["provider"].models, [])

    def test_model_chain_for_local_fills_engine_model(self):
        with mock.patch.object(bridge, "resolve", return_value={
                "provider": type("P", (), {"default_model": "hermes.gguf", "models": ["hermes.gguf"]})(),
                "base_url": "http://127.0.0.1:8080/v1", "api_key": ""}):
            with mock.patch.object(bridge, "load_settings", return_value={"model": "", "fallback_models": ""}):
                chain = bridge.model_chain("local")
        self.assertEqual(chain, ["hermes.gguf"])


if __name__ == "__main__":
    unittest.main()
