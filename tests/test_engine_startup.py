import copy
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.inference import _local_chat_payload
from backend.models import AppConfig
from backend.process_manager import ProcessManager


class EngineStartupTests(unittest.TestCase):
    def test_profile_system_prompt_is_not_a_server_cli_argument(self):
        config = AppConfig(system_prompt='Keep the configured default instruction.')
        with patch('backend.process_manager.detect_server_binary', return_value='llama-server.exe'), \
                patch('backend.process_manager.resolve_engine_dir', return_value='engine'):
            command = ProcessManager().build_command(config)
        self.assertNotIn('--system-prompt', command)
        self.assertNotIn(config.system_prompt, command)

    def test_default_system_prompt_reaches_each_local_chat_protocol(self):
        for engine in ('llama.cpp', 'kvmem', 'ninfer'):
            with self.subTest(engine=engine):
                config = AppConfig(engine=engine, system_prompt='Answer concisely.')
                messages = [{'role': 'user', 'content': 'Hello'}]
                original = copy.deepcopy(messages)
                payload = _local_chat_payload({}, config, messages)
                self.assertEqual(payload['messages'][0], {'role': 'system', 'content': config.system_prompt})
                self.assertEqual(payload['messages'][1:], original)
                self.assertEqual(messages, original)

    def test_explicit_system_or_developer_instruction_has_priority(self):
        for role in ('system', 'developer'):
            with self.subTest(role=role):
                messages = [{'role': role, 'content': 'Explicit request instruction.'}, {'role': 'user', 'content': 'Hello'}]
                result = _local_chat_payload({}, AppConfig(system_prompt='Profile default.'), messages)
                self.assertEqual(result['messages'], messages)

    def test_missing_dll_exit_is_actionable_and_keeps_profile(self):
        for code in (0xC0000135, -1073741515):
            with self.subTest(code=code):
                manager = ProcessManager()
                manager._profile_name = 'Hermes'
                manager._process = SimpleNamespace(returncode=code, pid=12345)
                status = manager.get_status()
                self.assertIn('DLL', status.error)
                self.assertIn('0xC0000135', status.error)
                self.assertEqual(status.profile, 'Hermes')


if __name__ == '__main__':
    unittest.main()
