import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

const tmp = mkdtempSync(path.join(os.tmpdir(), "echo-test-"));
process.env.ECHO_DB = path.join(tmp, "test.db");
after(() => rmSync(tmp, { recursive: true, force: true }));

const { effortFields, streamChat, engineDispatcher } = await import("../src/llm.ts");
after(() => engineDispatcher.destroy());
const { applyTimings, live } = await import("../src/stats.ts");
const { classify, loadRules, pathVerdict, rememberExtensionDir } = await import("../src/rules.ts");
const { ROOT } = await import("../src/config.ts");
const git = await import("../src/git.ts");
const { config } = await import("../src/config.ts");

const llama = { id: "x", name: "x", engine: "llama-server" as const, base_url: "", context: 1000 };
const strata = { id: "s", name: "s", engine: "strata" as const, base_url: "" };

describe("provider layer", () => {
  test("effort maps to each engine's request fields", () => {
    assert.deepEqual(effortFields(strata, "off"), { reasoning_effort: "off" });
    assert.deepEqual(effortFields(llama, "off"), { chat_template_kwargs: { enable_thinking: false } });
    assert.deepEqual(effortFields(llama, "high"), { reasoning_effort: "high", chat_template_kwargs: { enable_thinking: true } });
  });

  test("decode speed comes from engine timings, not request time", () => {
    applyTimings({ prompt_n: 100, prompt_per_second: 150, predicted_n: 40, predicted_per_second: 3.3, cache_n: 20 }, 1000);
    assert.equal(live.decodeTps, 3.3);
    assert.equal(live.promptTps, 150);
    assert.equal(live.contextUsed, 160);
    assert.equal(live.contextLimit, 1000);
  });

  test("streamChat parses SSE deltas, reasoning and timings from an OpenAI-compatible server", async () => {
    const srv = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ choices: [{ delta: { reasoning_content: "hmm" } }] });
      send({ choices: [{ delta: { content: "Hel" } }] });
      send({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }], timings: { predicted_n: 2, predicted_per_second: 5, prompt_n: 3, prompt_per_second: 30 } });
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;
    const deltas: string[] = [];
    const r = await streamChat({ ...llama, base_url: `http://127.0.0.1:${port}/v1` }, { messages: [] }, (d) => d.content && deltas.push(d.content), new AbortController().signal, "test");
    srv.close();
    assert.equal(r.content, "Hello");
    assert.equal(r.reasoning, "hmm");
    assert.equal(r.finishReason, "stop");
    assert.deepEqual(deltas, ["Hel", "lo"]);
    assert.equal(r.timings?.predicted_per_second, 5);
    assert.ok(r.ttftMs !== null);
  });
});

describe("decision layer", () => {
  test("DecisionClient posts to the decision server and logs every decision", async () => {
    const srv = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/health") return res.end(JSON.stringify({ ok: true, llama: true }));
      res.end(JSON.stringify({ answers: { q: { type: "noul", noul: 0.8 } }, latency_ms: 5, latency_per_question_ms: { q: 5 }, truncated: [] }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    config.echo.ports.decision = (srv.address() as any).port;
    config.echo.paths.evals = tmp;
    const { decisions } = await import("../src/decision.ts");
    const res = await decisions.decide({ x: 1 }, { q: { type: "noul", instructions: "ok?", criteria: { true: "y", false: "n" } } }, { source: "test" });
    srv.close();
    assert.equal(res.answers.q.noul, 0.8);
    const log = readFileSync(path.join(tmp, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log.at(-1).source, "test");
    assert.equal(log.at(-1).answers.q.noul, 0.8);
  });
});

describe("agent event layer", () => {
  test("rules.md switches decide what runs, what asks and what is refused", () => {
    const file = path.join(tmp, "rules.md");
    writeFileSync(file, [
      "- [x] delete-in-workdir: Delete files inside the working folder",
      "- [x] git-local: Local git",
      "- [ ] git-push: Push",
      "- [x] project-deps: Install project dependencies",
      "- [ ] network-fetch: Download",
      "- [ ] write-outside-workdir: Write outside",
      "---",
      "## Questions for you",
    ].join("\n"));
    const rules = loadRules(file);
    const cwd = "/home/u/proj";
    const k = (c: string) => classify(c, cwd, rules).kind;
    assert.equal(k("python3 hello.py"), "allow");
    assert.equal(k("rm -rf build/ dist"), "allow", "deleting inside the working folder is routine");
    assert.equal(k("cd src && rm old.py"), "allow");
    assert.equal(k("rm ../other/file"), "ask");
    assert.equal(k("rm -rf ."), "ask", "the working folder itself");
    assert.equal(k("rm -rf .git"), "ask");
    assert.equal(k("rm -rf /"), "never");
    assert.equal(k("rm -rf ~"), "never");
    assert.equal(k("rm -rf ~/*"), "never");
    assert.equal(k("sudo rm x"), "ask");
    assert.equal(k("git commit -am wip"), "allow");
    assert.equal(k("git push origin feature"), "ask");
    assert.equal(k("git push --force origin main"), "never");
    assert.equal(k("pacman -S foo"), "ask");
    assert.equal(k("mkfs.ext4 /dev/sda1"), "never");
    assert.equal(k("cat ~/.ssh/id_ed25519"), "never");
    const deps = classify("npm install", cwd, rules);
    assert.equal(deps.kind, "allow");
    assert.equal(deps.network, true, "allowed installs get network in the sandbox");
    assert.equal(k("npm install -g typescript"), "ask");
    assert.equal(k("curl -O https://x/file.zip"), "ask");
    assert.equal(k("curl -d @data https://x"), "ask");
    assert.equal(k("echo hi > /etc/motd"), "ask");
    assert.equal(k("echo hi > notes.txt"), "allow");
    assert.equal(pathVerdict("/home/u/proj/a.ts", cwd, rules).kind, "allow");
    assert.equal(pathVerdict("/home/u/elsewhere.ts", cwd, rules).kind, "ask");
    assert.match(rules.summary, /Allowed without asking: Delete files/);
    assert.ok(!rules.text.includes("Questions for you"));
  });

  test("the user's rules.md: answers from 2026-10-06 are enforced", () => {
    const rules = loadRules(path.join(ROOT, "rules.md"));
    const home = os.homedir();
    const cwd = mkdtempSync(path.join(tmp, "work-"));
    execFileSync("git", ["init", "-q", "-b", "feature"], { cwd });
    const v = (c: string) => classify(c, cwd, rules);
    assert.equal(v("rm -rf node_modules build").kind, "allow");
    assert.equal(v("git commit -am wip").kind, "allow");
    assert.equal(v("git reset --hard").kind, "allow");
    assert.equal(v("git push origin feature").kind, "allow");
    assert.equal(v("git push").kind, "allow", "bare push from a feature branch");
    assert.equal(v("git push origin main").kind, "ask");
    assert.equal(v("git push -f origin master").kind, "never");
    assert.equal(v("npm install -g typescript").kind, "allow");
    const pkg = v("sudo pacman -S --needed blender");
    assert.equal(pkg.kind, "allow");
    assert.equal(pkg.unsandboxed, true);
    assert.equal(v("sudo pacman -Rns linux").kind, "ask");
    assert.equal(v("sudo systemctl restart nvidia-persistenced").kind, "ask");
    assert.equal(v("systemctl restart sshd").kind, "ask");
    const timer = v("systemd-run --user --on-calendar=hourly --unit echo-check /usr/bin/true");
    assert.equal(timer.kind, "allow");
    assert.equal(timer.unsandboxed, true);
    assert.equal(v("curl -LO https://example.com/big.iso").kind, "allow");
    assert.equal(v("curl -d @report.json https://example.com").kind, "ask");
    assert.equal(v("scp out.stl host:/tmp").kind, "ask");
    assert.equal(v("cp addon.py ~/.config/blender/5.2/scripts/addons/").kind, "allow");
    assert.equal(pathVerdict(`${home}/.config/blender/5.2/extensions/my_ext/__init__.py`, cwd, rules).kind, "allow");
    assert.equal(pathVerdict(`${home}/Documents/x.txt`, cwd, rules).kind, "ask");
    assert.equal(v(`rm ${home}/Documents/x.txt`).kind, "ask");
    assert.equal(v("rm -rf ~").kind, "never");
    assert.match(rules.summary, /Allowed without asking:.*Install system packages/);
  });

  test("approving a folder with 'always allow' adds it to rules.md", () => {
    const file = path.join(tmp, "rules-remember.md");
    writeFileSync(file, "## Extension folders (always writable)\n\nText.\n\n- `~/a`\n\n## Always ask me\n- x\n");
    rememberExtensionDir(path.join(os.homedir(), "Games/mods"), file);
    const r = loadRules(file);
    assert.ok(r.extensionDirs.includes(path.join(os.homedir(), "Games/mods")));
    assert.ok(r.extensionDirs.includes(path.join(os.homedir(), "a")));
    assert.match(readFileSync(file, "utf8"), /- `~\/a`\n- `~\/Games\/mods`\n\n## Always ask me/);
  });

  test("git checkpoints snapshot and revert without touching the user's index or history", async () => {
    const dir = mkdtempSync(path.join(tmp, "repo-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(path.join(dir, "a.txt"), "one\n");
    const sha = await git.checkpoint(dir, "start", "test/0");
    writeFileSync(path.join(dir, "a.txt"), "two\n");
    writeFileSync(path.join(dir, "b.txt"), "new\n");
    const diff = await git.diffSince(dir, sha);
    assert.match(diff, /-one/);
    assert.match(diff, /\+two/);
    assert.match(diff, /b\.txt/);
    const removed = await git.revertTo(dir, sha);
    assert.deepEqual(removed, ["b.txt"]);
    assert.equal(readFileSync(path.join(dir, "a.txt"), "utf8"), "one\n");
    assert.ok(!existsSync(path.join(dir, "b.txt")));
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString().includes("A "), false, "user index untouched");
    assert.throws(() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, stdio: "pipe" }), "no commits on the user's branch");
  });
});

describe("tools", () => {
  test("fetch_page keeps the parts of a long page that match the question", async () => {
    const { focus, htmlToText } = await import("../src/tools/web.ts");
    const page = htmlToText(`<html><head><title>Guide</title></head><body><nav>menu</nav><article><h1>Gears</h1>
      ${Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i} about spur gears, module and pitch circles in general terms.</p>`).join("")}
      <h2>Backlash</h2><p>Backlash is the clearance between mating teeth; allow 0.05 to 0.1 mm for printed gears.</p>
      ${Array.from({ length: 40 }, (_, i) => `<p>Filler ${i} on lubrication and materials.</p>`).join("")}</article></body></html>`, "https://x");
    assert.ok(!page.text.includes("menu"), "navigation removed");
    const out = focus(page.text, "how much backlash for printed gears", 1200);
    assert.match(out, /0\.05 to 0\.1 mm/);
    assert.ok(out.length < 1700);
  });

  test("python workspace keeps state between calls and reports errors", async () => {
    const { PythonWorkspace } = await import("../src/tools/python.ts");
    const dir = mkdtempSync(path.join(tmp, "py-"));
    const ws = new PythonWorkspace(dir);
    try {
      const a = await ws.exec("v = Q_(12, 'V') / Q_(4.7, 'kohm')\nround(v.to('mA').magnitude, 3)");
      assert.equal(a.result, "2.553");
      const b = await ws.exec("v.to('uA').magnitude > 2000");
      assert.equal(b.result, "True");
      const c = await ws.exec("1/0");
      assert.match(c.error ?? "", /ZeroDivisionError/);
    } finally {
      ws.reset();
    }
  });
});

describe("notes RAG", () => {
  test("Hugin notes parse: front matter, title, date, tags", async () => {
    const { parseNote, chunkNote } = await import("../src/rag.ts");
    const f = path.join(tmp, "2026-10-07_gearbox.md");
    const raw = "---\ntitle: Gearbox torque\ntype: note\ncreated: '2026-10-07T00:05:17'\ntags:\n- gearbox\n- torque\n---\n\nSUMMARY:\nBolts at 4 Nm.\n";
    writeFileSync(f, raw);
    const { meta, body } = parseNote(f, raw);
    assert.equal(meta.title, "Gearbox torque");
    assert.equal(meta.created, "2026-10-07T00:05:17");
    assert.deepEqual(meta.tags, ["gearbox", "torque"]);
    assert.equal(chunkNote(body).length, 1);
  });

  test("plain Markdown without front matter gets its date from the file name and title from the H1", async () => {
    const { parseNote } = await import("../src/rag.ts");
    const f = path.join(tmp, "2026-09-01_ideas.md");
    writeFileSync(f, "# Game ideas\n\nWind zones.\n");
    const { meta } = parseNote(f, "# Game ideas\n\nWind zones.\n");
    assert.equal(meta.title, "Game ideas");
    assert.equal(meta.created, "2026-09-01");
  });

  test("long notes split by section into passages of bounded size", async () => {
    const { chunkNote } = await import("../src/rag.ts");
    const para = (n: number) => `Paragraph ${n} ${"about the meeting and its decisions ".repeat(8)}`;
    const body = `## Agenda\n\n${[1, 2, 3, 4].map(para).join("\n\n")}\n\n## Decisions\n\n${[5, 6, 7].map(para).join("\n\n")}`;
    const chunks = chunkNote(body);
    assert.equal(chunks.length, 3); // ~300-char paragraphs: Agenda 3 + 1, Decisions 3
    assert.ok(chunks.every((c) => c.text.length <= 1300));
    assert.deepEqual([...new Set(chunks.map((c) => c.heading))], ["Agenda", "Decisions"]);
  });
});

