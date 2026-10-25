import React from "react";

/** 轻量 Markdown：段落、标题、列表、引用、代码块、行内粗体/代码/斜体。只生成 React 节点，不注入 HTML。 */
function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|「[^」]{1,40}」)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("**")) out.push(<b key={k}>{t.slice(2, -2)}</b>);
    else if (t.startsWith("`")) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("「")) out.push(<span key={k} className="md-ref">{t}</span>);
    else out.push(<i key={k}>{t.slice(1, -1)}</i>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 模型有时把整段中文回复包在 ``` 里（或标成 markdown），这种按正文渲染，别显示成等宽代码。 */
function proseFence(lang: string, body: string[]): boolean {
  const l = lang.trim().toLowerCase();
  if (l === "markdown" || l === "md") return true;
  if (l && !["text", "txt", "plain", "plaintext"].includes(l)) return false;
  if (body.some((x) => /^\s*[{[]/.test(x))) return false;
  const t = body.join("").replace(/\s+/g, "");
  if (!t) return false;
  const cjk = (t.match(/[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/g) || []).length;
  return cjk / t.length >= 0.2;
}

export const Markdown = React.memo(function Markdown({ text, caret }: { text: string; caret?: boolean }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      if (proseFence(lang, buf)) blocks.push(<Markdown key={k++} text={buf.join("\n")} />);
      else blocks.push(<pre key={k++} className="md-pre mono">{buf.join("\n")}</pre>);
      continue;
    }
    if (/^\s*([-*•]|\d+[.、)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.、)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.、)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.、)])\s+/, ""));
      const Tag = ordered ? "ol" : "ul";
      blocks.push(<Tag key={k++}>{items.map((t, j) => <li key={j}>{inline(t, `${k}-${j}`)}</li>)}</Tag>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(<div key={k++} className="md-h">{inline(h[2], `h${k}`)}</div>);
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={k++}>{inline(buf.join(" "), `q${k}`)}</blockquote>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>|\s*([-*•]|\d+[.、)])\s+)/.test(lines[i])) buf.push(lines[i++]);
    blocks.push(
      <p key={k++}>
        {buf.map((b, j) => (
          <React.Fragment key={j}>
            {j > 0 && <br />}
            {inline(b, `p${k}-${j}`)}
          </React.Fragment>
        ))}
      </p>,
    );
  }
  return (
    <div className="md">
      {blocks}
      {caret && <span className="caret" />}
    </div>
  );
});
