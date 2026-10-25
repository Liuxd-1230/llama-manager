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
        provider = _make_provider(kind="deepseek", base_url="https://api.deepseek.com")
        with mock.patch.object(bridge.provider_manager, "get_provider", return_value=provider):
            resolved = bridge.resolve("p1")
        self.assertEqual(resolved["base_url"], "https://api.deepseek.com")

    def test_anthropic_provider_is_rejected(self):
        provider = _make_provider(kind="anthropic", base_url="https://api.anthropic.com")
        with mock.patch.object(bridge.provider_manager, "get_provider", return_value=provider):
            with self.assertRaises(bridge.ProviderError):
                bridge.resolve("p1")

    def test_model_chain_prefers_settings_then_provider_models_without_duplicates(self):
        provider = _make_provider(models=["m2", "m1"])
        with mock.patch.object(bridge.provider_manager, "get_provider", return_value=provider):
            with mock.patch.object(bridge, "resolve", return_value={"provider": provider, "base_url": "b", "api_key": "k"}):
                with mock.patch.object(bridge, "load_settings", return_value={"model": "m0", "fallback_models": "m1, m3"}):
                    chain = bridge.model_chain("p1")
        self.assertEqual(chain, ["m0", "m2", "m1", "m3"])


if __name__ == "__main__":
    unittest.main()
