"""Echo decision server: Jebadiah's own prompt renderer in front of a CPU llama-server.

POST /decide  {"state": ..., "questions": {name: {type, instructions, criteria}}}
  -> {"answers": {name: {...}}, "latency_ms": n, "truncated": [names]}
GET  /health  -> {"ok": true, "llama": bool}

The prompt is rendered exactly as AINode does (models/jebadiah/scripts/jebadiah_prompt.py, unchanged),
sent raw to llama-server's /completion, and the answer is read from the option-label log probabilities
with temperatures.json applied. Nothing is generated. Questions are answered in order, one forward pass
each; the shared state prefix stays in llama-server's prompt cache between them.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8091)
ap.add_argument("--llama", default="http://127.0.0.1:8090")
ap.add_argument("--model-dir", required=True, help="folder with tokenizer files, scripts/ and temperatures.json")
ap.add_argument("--n-probs", type=int, default=1000)
args = ap.parse_args()

sys.path.insert(0, os.path.join(args.model_dir, "scripts"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")

from jebadiah_prompt import Renderer, answer_from_probs  # noqa: E402
from transformers import AutoTokenizer  # noqa: E402

tok = AutoTokenizer.from_pretrained(args.model_dir)
if tok.pad_token_id is None:
    tok.pad_token = tok.eos_token
renderer = Renderer(tok, 2048)
TEMPS = {k: float(v) for k, v in
         json.load(open(os.path.join(args.model_dir, "temperatures.json")))["temperatures"].items()}
lock = threading.Lock()  # llama-server runs one slot; keep requests ordered


def post(path: str, body: dict, timeout: float = 900) -> dict:
    req = urllib.request.Request(args.llama.rstrip("/") + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def label_logprobs(prompt: str, cand_ids: list[int]) -> list[float]:
    # cache_prompt on: the state prefix is shared by every question of one decision time
    r = post("/completion", {"prompt": prompt, "n_predict": 1, "n_probs": args.n_probs,
                             "post_sampling_probs": False, "cache_prompt": True, "temperature": 0.0})
    top = r["completion_probabilities"][0]["top_logprobs"]
    lp = {t["id"]: t["logprob"] for t in top}
    floor = min(lp.values())
    return [lp.get(c, floor) for c in cand_ids]


def option_probs(logprobs: list[float], temperature: float) -> list[float]:
    z = [x / temperature for x in logprobs]
    m = max(z)
    e = [math.exp(x - m) for x in z]
    s = sum(e)
    return [x / s for x in e]


def decide(req: dict) -> dict:
    t0 = time.perf_counter()
    answers, truncated, per_q = {}, [], {}
    with lock:
        for qid, q in req["questions"].items():
            q1 = time.perf_counter()
            rd = renderer.render(req["state"], q)
            probs = option_probs(label_logprobs(rd.prompt, rd.cand_ids), TEMPS.get(q["type"], 1.0))
            answers[qid] = answer_from_probs(q, rd.keys, probs)
            per_q[qid] = round((time.perf_counter() - q1) * 1000)
            if rd.truncated:
                truncated.append(qid)
    return {"answers": answers, "latency_ms": round((time.perf_counter() - t0) * 1000),
            "latency_per_question_ms": per_q, "truncated": truncated, "temperatures": TEMPS}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        sys.stderr.write("[decision] " + fmt % a + "\n")

    def send(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            try:
                with urllib.request.urlopen(args.llama + "/health", timeout=2) as r:
                    llama = r.status == 200
            except Exception:
                llama = False
            return self.send(200, {"ok": True, "llama": llama})
        self.send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/decide":
            return self.send(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            if not isinstance(body.get("questions"), dict) or not body["questions"]:
                return self.send(400, {"error": "questions must be a non-empty object"})
            self.send(200, decide(body))
        except urllib.error.URLError as e:
            self.send(503, {"error": f"decision model not reachable: {e}"})
        except (ValueError, KeyError, AssertionError) as e:
            self.send(400, {"error": str(e)})


if __name__ == "__main__":
    print(f"[decision] listening on 127.0.0.1:{args.port}, llama at {args.llama}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
