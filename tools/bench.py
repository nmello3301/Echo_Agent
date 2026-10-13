import json, sys, time, urllib.request
url = sys.argv[1]; n_ctx_words = int(sys.argv[2]); effort = sys.argv[3]
filler = " ".join(f"item{i} is a part number in the warehouse inventory list." for i in range(n_ctx_words // 10))
msgs = [{"role": "user", "content": (f"Here is a list:\n{filler}\n\n" if n_ctx_words else "") + "Write two sentences about gears."}]
body = {"messages": msgs, "max_tokens": 200, "stream": False, "reasoning_effort": effort,
        "chat_template_kwargs": {"enable_thinking": effort != "off"}, "cache_prompt": False}
t = time.time()
r = json.loads(urllib.request.urlopen(urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"}), timeout=3600).read())
tm = r["timings"]
print(json.dumps({"wall_s": round(time.time() - t, 1), "prompt_n": tm["prompt_n"], "prompt_tps": round(tm["prompt_per_second"], 1),
  "decode_n": tm["predicted_n"], "decode_tps": round(tm["predicted_per_second"], 2),
  "reasoning_chars": len(r["choices"][0]["message"].get("reasoning_content") or ""), "text": r["choices"][0]["message"]["content"][:120]}))
