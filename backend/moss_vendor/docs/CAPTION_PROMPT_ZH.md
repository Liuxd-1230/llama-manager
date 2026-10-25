# From USERGUIDE_ZH.md — Caption Prompt + Caption Model

#### Caption Prompt

```text
You are an image recaptioner. Return exactly one JSON object with this schema:
{
  "caption": {
    "long": "a detailed image description, including all non-watermark visible text",
    "medium": "a one-paragraph image description",
    "short": "a one-sentence image description"
  },
  "watermark": [
    {"box_2d": [y_min, x_min, y_max, x_max], "label": "watermark text"}
  ],
  "borders": ["none"]
}

Rules:
- caption.long:
    - Describe the composition, key subjects, actions, setting, colors, lighting, and artistic style in detail. Include only information visible in the image.
    - Preserve visible text exactly, excluding watermarks. Do not translate, paraphrase, romanize, or normalize image text.
    - Describe text layout as much as possible: line breaks, ordering, relative position, alignment, size hierarchy, font/style, color, spacing, and how text blocks are arranged.
- caption.medium: compress long into one paragraph.
- caption.short: summarize the main subject, action, or relationship in one sentence.
- Do not describe watermarks in any caption field. Record them only in watermark.
- watermark:
    - Use normalized 0–1000 [y_min, x_min, y_max, x_max] coordinates relative to the full image.
    - Set label to the visible watermark text, or a short description if unreadable.
    - Use [] if there are no watermarks.
- borders:
    - Record evident borders or margins using one or more of "left", "right", "up", and "down".
    - Use ["none"] if there are no evident borders or margins. Do not combine "none" with other directions.
- All three caption fields must be non-empty strings.
- Treat the original caption as a reference. Correct any claims that are not supported by the image.
- Return only the JSON object, without Markdown or explanations.

Here is the original caption reference:
{{reference}}
```

#### Caption Model

MOSS-Image-Base 尝试了多种 VLM 作为 caption model. 在这里我们推荐使用 Gemma 4, Qwen 3.5 27B 或 Qwen 3.5 35B-A3B. 一般的, 我们使用以下的 chat template 进行打标:

```python
body = {
    "model": model_name,
    "messages": [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt_text},
                {"type": "image_url", "image_url": {"url": image_url}},
            ],
        }
    ],
    "n": 1,
    "stream": False,
    "max_tokens": 16384,
    "temperature": 1,
    "top_p": 0.95,
    "extra_body": {"chat_template_kwargs": {"enable_thinking": True}},
}
```

我们推荐开启 thinking 模式, 以获得更好的标注精度.

##
