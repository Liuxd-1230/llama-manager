# Atelier

## Product truth

Atelier is a Chinese-language, local-first Windows workbench for model management and visual creation. It combines model downloads, inference profiles, chat, segmented prompts, composition, and optional connection to an external ComfyUI service. Atelier connects to and monitors that service; it does not manage its lifecycle. The current brand mark is the user-confirmed geometric A supplied in atelier-logo-demo-package.zip; the earlier Lambda is superseded. The supplied outline is retained as SVG.

The primary journey is download → configure → write → compose → compile → generate → save and reuse. Creation and model management have equal priority. Workspaces are home, creation, models, downloads, assets, chat and settings. A creative project contains series and pages; draft, composition and image views share that page's content without sharing one forced layout.

## Audience and use scene

People working with local inference and AI image creation on Windows. The main scene is a desktop browser used for repeated editing and parameter changes, with narrow windows supported. No commercial positioning or audience research is asserted.

## Confirmed capabilities and limits

- Preserve llama.cpp, KVMem and NInfer, their validation and request differences, external chat providers, search, logs, history, MOSS compilation, camera, lighting, undo and workspaces.
- Add HF resumable downloading, segments and fixed passages, dictionaries and reusable assets, Anima semantic compilation, LoRA workflows, visual GGUF reverse prompting, polygon and comic composition, MCP, notes and Presets.
- Do not include Florence, ONNX taggers, an independent machine-translation chain, multilingual UI or ComfyUI lifecycle management.
- Stop only an Atelier-managed engine, only after an explicit user choice. External ComfyUI services are intended for connection and monitoring; external jobs are not broadly interrupted. A successful live connection is recorded only after it is exercised.
- Back up and migrate user data; keep model files and HF caches at their original paths. Never silently replay interrupted tool or generation work.

## Visual commitments

DESIGN.md is the governing design guide. The earlier liquid-glass positioning is superseded by the user's approved Atelier plan. The current world uses warm neutral light surfaces (#f7f6f2 canvas, #fdfcf8 raised surface), graphite text (#242620), terracotta emphasis (#af563f), and neutral charcoal dark surfaces (#1c1c1b canvas, #242422 raised surface) with a soft terracotta emphasis (#df967b). Both themes and the existing alternate accent settings remain available. The desktop shell uses a 190px sidebar and 68px header; narrow screens use persistent bottom navigation at 390px.

Typography and composition create identity: Newsreader with Noto Serif SC for selective display, Inter with Noto Sans SC for Chinese operational text, and IBM Plex Mono for paths and measurements. The user-supplied geometric A is the current brand mark; Folio open-paper framing supports project and honest empty-state previews, though its current SVG still contains an earlier Lambda-shaped interior stroke; home rows preview the actual saved manuscript text or composition. The image workspace opens on result previews and lets the user switch to workflow nodes. Controls, labels and dense Chinese information use readable sans-serif text.

The concrete reference card and per-surface intent live in docs/atelier-design.md. Ordinary kit buttons use a filled surface with 6px corners; icon buttons stay transparent until hover. Inputs and panels use 4px corners, while modals use 10px corners and keep focus within the topmost overlay. Shared segmented controls support arrow keys and Home/End. Chat and Agent share IME guards and user-controlled scroll pinning; scrolling stays immediate instead of globally smooth. Browser composition events are covered, but this does not claim a complete manual Windows IME acceptance. Navigation selection, geometric A stroke feedback, proposal unfolding, image reveal, buttons and segmented controls follow system and explicit reduced-motion preferences.

Atelier page code is split into Overview, Downloads, Assets, Jobs and ProjectBar modules. Job views can filter by job kind and creation page. The implementation reads the community `Caho1/open-claude-ui` source at the fixed commit recorded in `docs/open-claude-ui-reference.md`; that project is not an official Claude specification.

## Evidence boundaries

Repository tests and controlled external-service fixtures establish deterministic behavior. `docs/atelier-validation.md` records successful local KVMem GGUF launch and health check, a real chat response, Chinese translation, Anima semantic compilation, visual MMProj reverse prompting, and a real 512×512 two-step image returned and shown in the browser through the existing ComfyUI MOSS workflow. That image-generation run verifies the link only; it is not a quality benchmark. The tested GGUF and workflow are the only real engine and image-generation paths claimed here. The current end-to-end pass also left the formal data counts unchanged: 87 conversations, 4 creation pages, 18 revisions, and 5 model profiles.

## 2026-10-27 visual and interaction upgrade

The home construction uses the user-supplied landscape images and geometric A. Its actual vector bounds are 163 by 148 units. First-visit construction lasts about 2.9 seconds; replay is explicit. Operational surfaces use the shared conversation composer (16px), user-message corners (16px with a 4px tail), 160ms feedback and 240ms disclosures. Chinese functionality stays sans serif. Decoration can be full, compact or off; reduced motion follows the system or the explicit preference. The editable caption view is named 文稿.

Agent streaming now uses common adapters for all three API protocols, freezes connection/configuration per task, replays original job events after a disconnect, attaches on refresh, rejects concurrent runs within a session, and deduplicates a repeated request ID. Workflow defaults derive from bound nodes and overrides/layout/bindings save against a workflow ID. Task progress reports observed phases; download ETA uses byte counters. The focused prior audit is historical; current implementation and evidence are recorded in docs/atelier-upgrade-checklist.md and ATELIER_UX.md. This paragraph is implementation context, not a live external-service acceptance claim.
