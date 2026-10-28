# Third-party sources in Atelier

Atelier integrates and adapts the following work. Original notices and third-party data licenses continue to apply.

## HF Mirror Downloader

Source: the user's local `D:\funproject\HF Mirror Downloader` project. Pure Python core and associated tests are retained under `backend/hf_download` and `tests/hf_download`; the Qt UI is not included. Atelier adapts connection cleanup, pending-task pause, logging and persistence integration.

The source README states: “仅供学习交流使用，模型文件版权归原发布者所有。” No additional source license was supplied by that project.

## ImageForge

Source: https://github.com/Liuxd-1230/ImageForge at commit `673422f67baf22606b7d2b3891f6382d543e30a9`.

The Anima compiler adapts its fact extraction, explicit-request-over-default policy, character ownership and Tag / natural-language separation. The Anima workflow preset adapts its loader/encode/sample/decode/output chain and omits optional accelerator nodes. The implementation uses Atelier's own storage and provider adapters. ImageForge is MIT licensed; its original license is reproduced in `licenses/ImageForge.txt`.

## Penna

Source: https://github.com/storyAura/Penna at commit `9f0938332f729f5197b1757e408250413e29d4ee`.

Atelier adapts segmented drafting, fixed passages, series-based creative organization and source ideas for shape editing. The compressed Danbooru tag and character dictionaries are retained under `backend/data`. Penna's MIT source license is reproduced in `licenses/Penna.txt`.

The character dataset derives from StoryAura/Danbooru-Dataset-csv and Laxhar/noob-wiki. The original noob-wiki data is Apache-2.0; StoryAura's extensions are MIT. Original Danbooru tags retain their source terms. See the Penna README's data acknowledgements and dataset links. No Penna fonts, avatars, logos or promotional images are bundled.

## Existing MOSS Prompt Studio integration

The existing integration from https://github.com/xiang6150592/-moss-prompt-editor remains. The prior repository README records that its source has no supplied open-source license and is for personal learning use; copyright remains with its author xiang6150592. Atelier retains its existing vendor material and credits.

## open-claude-ui design reference

Source: https://github.com/Caho1/open-claude-ui at commit `c1f923ae0051a871941b98a0e2e3183a545e6a85` (MIT, copyright 2026 Caho1). Atelier independently adapts input-method guards, user-released scroll pinning and control surface/motion ideas. No upstream brand assets or complete components are bundled. The source license is retained in `licenses/open-claude-ui.txt`; inspected files and implementation differences are recorded in `docs/open-claude-ui-reference.md`. This community reference is not an official Anthropic specification.

## Runtime dependencies

MCP uses the official Python SDK: https://github.com/modelcontextprotocol/python-sdk (MIT). Hugging Face downloading uses huggingface_hub; UI icons use Lucide. Fonts and other installed dependencies retain their packaged license files.
