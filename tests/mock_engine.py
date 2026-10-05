"""Mock OpenAI-compatible engine for pipeline testing (no VRAM needed).

8095: non-stream chat + /v1/models  (for evaluation smoke)
8096: streaming chat with two content chunks (for the webui page tests)
"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ANSWERS = {
    "2+2": "4",
    "量化": "量化模型的优势是显存占用更小，速度更快。",
    "折射": "光进入不同介质时方向发生偏折。",
}


def answer_for(prompt: str) -> str:
    for key, value in ANSWERS.items():
        if key in prompt:
            return value
    return "好的。"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, content_type="application/json"):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            self._send(200, {"data": [{"id": "mock-engine"}], "object": "list"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        data = json.loads(self.rfile.read(length) or b"{}")
        prompt = " ".join(m.get("content", "") if isinstance(m.get("content"), str) else "" for m in data.get("messages", []))
        if self.path.startswith("/v1/chat/completions"):
            answer = answer_for(prompt)
            if data.get("stream") and self.server.server_port == 8096:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                for piece in (answer[:3], answer[3:], ""):
                    chunk = {"choices": [{"delta": {"content": piece}}]}
                    self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
                    self.wfile.flush()
                    time.sleep(0.15)
                self.wfile.write(b"data: [DONE]\n\n")
                return
            self._send(200, {
                "choices": [{"finish_reason": "stop", "index": 0,
                             "message": {"content": answer, "role": "assistant"}}],
                "model": "mock-engine",
                "timings": {"prompt_n": 10, "prompt_ms": 50, "predicted_n": 5, "predicted_ms": 100},
                "usage": {"total_tokens": 15},
            })
        else:
            self._send(404, {"error": "not found"})


def serve(port):
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


threading.Thread(target=serve, args=(8095,), daemon=True).start()
serve(8096)
