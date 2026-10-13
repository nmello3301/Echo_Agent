"""Score a decision model on evals/decision-set.jsonl through Echo's running decision server.

  python3 evals/decision_eval.py [--url http://127.0.0.1:8091]

expect: true/false for noul (P(true) > 0.5), a list of acceptable keys for choice,
a list of acceptable level indices for score (the most probable level).
"""
import argparse, json, pathlib, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://127.0.0.1:8091")
a = ap.parse_args()
items = [json.loads(l) for l in (pathlib.Path(__file__).parent / "decision-set.jsonl").read_text().splitlines() if l.strip()]
ok = 0
for it in items:
    body = json.dumps({"state": it["state"], "questions": {"q": it["question"]}}).encode()
    r = json.loads(urllib.request.urlopen(urllib.request.Request(a.url + "/decide", body, {"Content-Type": "application/json"}), timeout=600).read())
    ans = r["answers"]["q"]
    if ans["type"] == "noul":
        got, hit = round(ans["noul"], 3), (ans["noul"] > 0.5) == it["expect"]
    elif ans["type"] == "choice":
        got, hit = ans["choice"], ans["choice"] in it["expect"]
    else:
        top = int(max(ans["probabilities"], key=ans["probabilities"].get))
        got, hit = top, top in it["expect"]
    ok += hit
    print(f"{'PASS' if hit else 'FAIL'}  {it['id']:<20} got={got!s:<10} expect={it['expect']}  {r['latency_ms']} ms")
print(f"\n{ok}/{len(items)} correct")
