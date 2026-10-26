"""Skills: verbatim storage/injection, legacy migration, corrupt-file safety."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.moss_server import skills


class SkillVerbatimTests(unittest.TestCase):
    """User skill text must survive untouched end to end."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "skills.json"
        self.flag = self.path.with_name(".skills-migrated")
        self.patches = [
            mock.patch.object(skills, "SKILLS_PATH", self.path),
            mock.patch.object(skills, "MIGRATED_FLAG", self.flag),
            mock.patch.object(skills, "_legacy_skill_sources", return_value=[]),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def test_custom_prompt_round_trips_byte_for_byte(self):
        prompt = "第一行\n\n  缩进的第二行  \n\n\n结尾没有换行"
        saved = skills.save_skills({
            "skills": [{"id": "c1", "name": "自定义", "kind": "caption", "builtin": False,
                        "description": "", "system_prompt": prompt}],
            "active": {"caption": "c1", "layout": "official-layout", "context": "official-context"},
        })
        loaded = skills.load_skills()
        self.assertEqual(loaded["skills"][-1]["system_prompt"], prompt)
        self.assertEqual(loaded["active"]["caption"], "c1")
        self.assertTrue(saved)

    def test_edited_builtin_is_not_reset_from_code(self):
        edited = "我改过的官方提示词，不该被代码常量覆盖"
        raw = {"skills": [{"id": "official-caption", "name": "MOSS 官方 Caption",
                           "kind": "caption", "builtin": True, "system_prompt": edited}],
               "active": {"caption": "official-caption", "layout": "official-layout", "context": "official-context"}}
        self.path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        loaded = skills.load_skills()
        caption = next(s for s in loaded["skills"] if s["id"] == "official-caption")
        self.assertEqual(caption["system_prompt"], edited)

    def test_legacy_store_is_imported_verbatim(self):
        legacy = Path(self.tmp.name) / "legacy.json"
        big = "长文本" * 5000
        legacy.write_text(json.dumps({"skills": [
            {"id": "custom-big", "name": "大 Skill", "kind": "caption", "system_prompt": big},
        ], "active": {"caption": "custom-big", "layout": "official-layout", "context": "official-context"}}, ensure_ascii=False), encoding="utf-8")
        with mock.patch.object(skills, "_legacy_skill_sources", return_value=[legacy]):
            loaded = skills.load_skills()
        imported = next(s for s in loaded["skills"] if s["id"] == "custom-big")
        self.assertEqual(imported["system_prompt"], big)
        self.assertEqual(loaded["active"]["caption"], "custom-big")
        self.assertTrue(self.flag.exists(), "migration marker not written")

    def test_corrupt_file_is_backed_up_not_overwritten(self):
        self.path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(Exception):
            skills.load_skills()
        backups = list(self.path.parent.glob("skills.corrupt-*.json"))
        self.assertEqual(len(backups), 1, "corrupt store was not backed up")
        self.assertEqual(backups[0].read_text(encoding="utf-8"), "{not json")
        self.assertEqual(self.path.read_text(encoding="utf-8"), "{not json", "original was overwritten")


class SkillInjectionTests(unittest.TestCase):
    def setUp(self):
        # Isolate from the real store: these tests assert on exact text.
        self.tmp = tempfile.TemporaryDirectory()
        path = Path(self.tmp.name) / "skills.json"
        self.patches = [
            mock.patch.object(skills, "SKILLS_PATH", path),
            mock.patch.object(skills, "MIGRATED_FLAG", path.with_name(".skills-migrated")),
            mock.patch.object(skills, "_legacy_skill_sources", return_value=[]),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def test_skill_text_is_injected_without_a_disclaimer(self):
        prompt = "只输出 JSON\n第二行"
        store = {"skills": [{"id": "x", "name": "严格格式", "kind": "caption", "builtin": False,
                             "description": "", "system_prompt": prompt}],
                 "active": {"caption": "x", "layout": "official-layout", "context": "official-context"}}
        from backend.moss_server import agent
        with mock.patch.object(agent, "load_skills", return_value=store):
            block = agent._skills_block("caption", [])
        self.assertIn(prompt, block)
        self.assertNotIn("一律忽略", block, "disclaimer still trims the skill's intent")
        self.assertNotIn("只采纳", block)


if __name__ == "__main__":
    unittest.main()
