import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  // The workspace runs in bubblewrap, which cannot nest (echo_verify runs the tests in a sandbox) and needs the
  // container's security options (docker-compose.yml): skip, rather than fail, where it cannot work.
  // (inside a sandbox the probe can hang rather than fail, hence the timeout)
  const noSandbox = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--die-with-parent", "true"], { timeout: 3000 }).status !== 0;
  test("python workspace keeps state between calls and reports errors", { skip: noSandbox && "bubblewrap cannot create a sandbox here" }, async () => {
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

describe("self-work", () => {
  /** A minimal Echo working copy: what echoCheckout looks for, in a git repository. */
  function fakeCheckout(): string {
    const dir = mkdtempSync(path.join(tmp, "copy-"));
    mkdirSync(path.join(dir, "apps/server/src"), { recursive: true });
    writeFileSync(path.join(dir, "apps/server/src/main.ts"), "");
    writeFileSync(path.join(dir, "echo.yaml"), "ports:\n  ui: 7777\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    return dir;
  }

  test("a working copy is found from any folder inside it, and the live tree never counts", async () => {
    const { echoCheckout } = await import("../src/selfdev.ts");
    const dir = fakeCheckout();
    mkdirSync(path.join(dir, "apps/web/src"), { recursive: true });
    assert.equal(echoCheckout(path.join(dir, "apps/web/src")), dir);
    assert.equal(echoCheckout(dir), dir);
    assert.equal(echoCheckout(tmp), undefined);
    assert.equal(echoCheckout(ROOT), undefined, "the live install is not a working copy");
  });

  test("linking a copy points its git-ignored dependencies at the live install, once", async () => {
    const { linkCheckout } = await import("../src/selfdev.ts");
    const dir = fakeCheckout();
    const r = linkCheckout(dir);
    assert.ok(r.linked.includes("node_modules"));
    assert.equal(readlinkSync(path.join(dir, "node_modules")), path.join(ROOT, "node_modules"));
    assert.match(readFileSync(path.join(dir, ".git/info/exclude"), "utf8"), /^\/node_modules$/m);
    assert.equal(execFileSync("git", ["config", "user.name"], { cwd: dir }).toString().trim(), "Echo (self-work)");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString().includes("node_modules"), false, "links stay out of git status");
    const again = linkCheckout(dir);
    assert.deepEqual(again.linked, []);
    assert.ok(again.kept.includes("node_modules"));
    assert.equal(readFileSync(path.join(dir, ".git/info/exclude"), "utf8").match(/^\/node_modules$/gm)?.length, 1);
    assert.throws(() => linkCheckout(ROOT), /live Echo/);
    assert.throws(() => linkCheckout(tmp), /not an Echo working copy/);
  });

  test("a copy's models/ is its own folder of links, so new models download into the copy", { skip: !existsSync(path.join(ROOT, "models")) && "no models folder here" }, async () => {
    const { linkCheckout } = await import("../src/selfdev.ts");
    const dir = fakeCheckout();
    symlinkSync(path.join(ROOT, "models"), path.join(dir, "models")); // how copies were linked at first
    const r = linkCheckout(dir);
    assert.ok(!lstatSync(path.join(dir, "models")).isSymbolicLink(), "the old single link is replaced by a folder");
    assert.match(r.notes.join(" "), /folder of links/);
    for (const m of readdirSync(path.join(ROOT, "models"))) {
      assert.equal(readlinkSync(path.join(dir, "models", m)), path.join(ROOT, "models", m));
    }
    writeFileSync(path.join(dir, "models", "new-model.bin"), "x"); // lands in the copy, not the live install
    assert.ok(!existsSync(path.join(ROOT, "models", "new-model.bin")));
  });

  test("a dev instance shifts its own ports and keeps the live Echo's shared ones", () => {
    const run = (env: Record<string, string>) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
      `const { config } = await import(${JSON.stringify(path.join(ROOT, "apps/server/src/config.ts"))}); console.log(JSON.stringify(config.echo.ports))`],
    { env: { ...process.env, ...env }, encoding: "utf8" }).trim().split("\n").at(-1)!);
    const live = run({ ECHO_ATTACH: "", ECHO_PORT_OFFSET: "" }); // as the live Echo, whatever runs this test
    const devPorts = run({ ECHO_ATTACH: "1", ECHO_PORT_OFFSET: "1000" });
    assert.equal(devPorts.ui, live.ui + 1000);
    assert.equal(devPorts.tts, live.tts + 1000);
    for (const shared of ["decision", "search", "embed", "rerank", "hugin"]) assert.equal(devPorts[shared], live[shared], shared);
  });

  test("dev.localhost requests reach the dev instance, streaming, and say so when it is not running", async () => {
    const { dev, isDevHost, proxyHttp } = await import("../src/selfdev.ts");
    assert.ok(isDevHost("dev.localhost:7777") && isDevHost("DEV.localhost") && !isDevHost("localhost:7777") && !isDevHost("dev.localhost.evil.com"));
    const target = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "X-Path": req.url ?? "", "X-Host": req.headers.host ?? "", "X-Fwd": String(req.headers["x-forwarded-host"]) });
      res.write("data: 1\n\n");
      setTimeout(() => res.end("data: 2\n\n"), 50);
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const proxy = createServer(proxyHttp);
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(proxy.address() as any).port}/api/x?y=1`;
    try {
      const off = await fetch(url);
      assert.equal(off.status, 503);
      assert.match(await off.text(), /No dev instance is running/);
      Object.assign(dev, { status: "ready", port: (target.address() as any).port });
      const on = await fetch(url, { headers: { "X-Test": "1" } });
      assert.equal(on.headers.get("x-path"), "/api/x?y=1");
      // the dev instance must not see dev.localhost, or it would try to proxy the request onwards itself
      assert.equal(on.headers.get("x-host"), `127.0.0.1:${(target.address() as any).port}`);
      assert.equal(on.headers.get("x-fwd"), `127.0.0.1:${(proxy.address() as any).port}`);
      assert.equal(await on.text(), "data: 1\n\ndata: 2\n\n");
    } finally {
      Object.assign(dev, { status: "stopped", port: 0 });
      proxy.close();
      target.close();
    }
  });

  test("echo_dev_request reports a WAV body's length", async () => {
    const { wavInfo } = await import("../src/tools/echodev.ts");
    const rate = 16000;
    const pcm = Buffer.alloc(rate * 2 * 1.5); // 1.5 s of 16-bit mono
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + pcm.length, 4);
    h.write("WAVEfmt ", 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24);
    h.writeUInt32LE(rate * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36);
    h.writeUInt32LE(pcm.length, 40);
    assert.equal(wavInfo(Buffer.concat([h, pcm])), "WAV 16000 Hz, 1 ch, 16-bit, 1.50 s of audio");
    h.writeUInt32LE(0xffffffff, 40); // streamed: size left open
    assert.match(wavInfo(Buffer.concat([h, pcm])) ?? "", /1\.50 s/);
    assert.equal(wavInfo(Buffer.from("not audio")), undefined);
  });
});

describe("live chat", () => {
  test("the first spoken chunk may end at a clause break, later ones at sentence ends", async () => {
    const { Chunker } = await import("../src/live.ts");
    const c = new Chunker();
    const out: string[] = [];
    for (const piece of "Sure, it will be sunny tomorrow, with a high of twenty. Bring a jacket though! It may get windy".match(/.{1,7}/g)!) out.push(...c.push(piece));
    assert.deepEqual(out, ["Sure, it will be sunny tomorrow,", "with a high of twenty.", "Bring a jacket though!"], "'Sure,' alone is too short to speak first");
    assert.equal(c.flush(), "It may get windy");
    assert.deepEqual(new Chunker().push("Pi is 3.14 exactly. "), ["Pi is 3.14 exactly."], "a decimal point is not a sentence end");
  });

  test("text is spoken without markdown, links or symbols", async () => {
    const { speakable } = await import("../src/live.ts");
    assert.equal(speakable("**Yes** — see https://x.y/z for `code` & more:\n- one\n- two"), "Yes — see a link for code and more: one two");
  });

  test("a spoken decision becomes the Decide tab's question and comes back in words", async () => {
    const { decideQuestions, describeDecision } = await import("../src/live.ts");
    assert.deepEqual(decideQuestions("Rain tomorrow?"), { answer: { type: "noul", instructions: "Rain tomorrow?", criteria: { true: "yes", false: "no" } } });
    assert.deepEqual(decideQuestions("Which?", ["tea", " ", "coffee"]).answer.criteria, { A: "tea", B: "coffee" }, "blank options are dropped");
    assert.equal(decideQuestions("Which?", ["only one"]).answer.type, "noul", "one option is not a choice");
    assert.equal(describeDecision({ type: "noul", noul: 0.27 }), "no (probability of yes: 27 percent)");
    assert.equal(describeDecision({ type: "choice", probabilities: { A: 0.2, B: 0.8 } }, ["tea", "coffee"]), "coffee: 80 percent, tea: 20 percent");
  });

  test("Live answers with the model picked in the tab, else live.model, once downloaded, else with the main model", async () => {
    const { liveModelId } = await import("../src/live.ts");
    const saved = { live: config.echo.live, main: config.models.main };
    const file = path.join(tmp, "small.gguf");
    const big = path.join(tmp, "big.gguf");
    try {
      config.models.main = [{ ...llama, id: "big", model: big }, { ...llama, id: "small", model: file }, { id: "soon", name: "Soon", coming_soon: true }];
      config.echo.live = { ...saved.live, model: "small" };
      assert.equal(liveModelId(), config.echo.default_model, "not downloaded: whatever main model Echo runs");
      writeFileSync(file, "x");
      assert.equal(liveModelId(), "small");
      assert.equal(liveModelId("big"), "small", "a pick that isn't downloaded falls back to live.model");
      writeFileSync(big, "x");
      assert.equal(liveModelId("big"), "big", "the tab's (or the persona's) pick comes first");
      assert.equal(liveModelId("soon"), "small", "a placeholder is never picked");
      assert.equal(liveModelId("nope"), "small");
      config.echo.live = { ...saved.live, model: "missing" };
      assert.equal(liveModelId(), config.echo.default_model, "an id models.yaml doesn't have");
    } finally {
      Object.assign(config.echo, { live: saved.live });
      config.models.main = saved.main;
    }
  });

  test("a persona's instructions sit above Live's spoken rules, and it only gets the helpers it may use", async () => {
    const { systemPrompt, liveTools } = await import("../src/live.ts");
    const { cleanPersona } = await import("../src/personas.ts");
    const echo = systemPrompt();
    assert.ok(echo.startsWith("You are Echo, talking with the user by voice"), "Echo's own prompt is unchanged");
    assert.ok(echo.includes("one to three short sentences") && echo.includes("ask_chat") && !echo.includes("How to talk"));
    assert.equal(liveTools().tools?.length, 2);
    const lambda = cleanPersona({ name: "  Lambda ", prompt: "You are a dry-witted engineer.", length: "long", helpers: { chat: false, decide: true } }, "lambda-1");
    const prompt = systemPrompt(lambda);
    assert.ok(prompt.startsWith("You are Lambda, talking with the user by voice"));
    assert.ok(prompt.indexOf("dry-witted engineer") < prompt.indexOf("No markdown, lists"), "the spoken rules come after the persona's words");
    assert.ok(!prompt.includes("ask_chat") && prompt.includes("decide model") && !prompt.includes("give the gist"));
    assert.deepEqual(liveTools(lambda).tools?.map((t) => t.function.name), ["decide"]);
    assert.deepEqual(liveTools({ ...lambda, helpers: { chat: false, decide: false } }), {}, "no helpers: no tools at all");
  });

  test("personas are checked as they are saved", async () => {
    const { cleanPersona, personasApp } = await import("../src/personas.ts");
    assert.throws(() => cleanPersona({ name: "   " }, "x"), /name/);
    const p = cleanPersona({ name: "Gamma", speed: 3, temperature: -1, effort: "high" as never, length: "huge" as never }, "g");
    assert.deepEqual([p.speed, p.temperature, p.effort, p.length, p.helpers, p.model], [1.3, 0, "off", "short", { chat: true, decide: true }, null]);
    assert.equal(cleanPersona({ name: "Gamma", model: " mimo-v2.6-9b " }, "g").model, "mimo-v2.6-9b");
    assert.equal(cleanPersona({ name: "Gamma", model: 42 as never }, "g").model, null);
    const made = await (await personasApp.request("/", { method: "POST", body: JSON.stringify({ name: "Gamma", greeting: "Hi there." }) })).json();
    assert.match(made.id, /^gamma-[0-9a-f]{6}$/);
    const changed = await (await personasApp.request(`/${made.id}`, { method: "PUT", body: JSON.stringify({ ...made, speed: 1.1 }) })).json();
    assert.equal(changed.speed, 1.1);
    assert.deepEqual((await (await personasApp.request("/")).json()).map((x: { name: string }) => x.name), ["Gamma"]);
    assert.equal((await personasApp.request("/nope", { method: "PUT", body: "{}" })).status, 404);
    await personasApp.request(`/${made.id}`, { method: "DELETE" });
    assert.deepEqual(await (await personasApp.request("/")).json(), []);
  });

  test("the summary names the model it checked", async () => {
    const { mentionsModel } = await import("../src/live.ts");
    assert.ok(mentionsModel("I checked the Chat model.", "chat"));
    assert.ok(mentionsModel("The decision model says yes.", "decide"));
    assert.ok(!mentionsModel("You should decide soon.", "decide"), "the verb alone does not name the model");
    assert.ok(!mentionsModel("I checked the decide model.", "chat"));
  });
});

describe("context", () => {
  test("compaction starts at 70% of the window, keeps a quarter and leaves room for a full turn", async () => {
    const { compactionSettings, compactsAt, contextSettings } = await import("../src/compaction.ts");
    const d = contextSettings({});
    assert.deepEqual(d, { auto: true, at: 0.7, keep: 0.25 });
    assert.deepEqual(compactionSettings(131072, d), { enabled: true, reserveTokens: 39322, keepRecentTokens: 32768 });
    assert.equal(compactsAt(131072, d), 91750);
    assert.deepEqual(compactionSettings(65536, d), { enabled: true, reserveTokens: 19661, keepRecentTokens: 16384 });
    assert.equal(compactionSettings(32768, d).reserveTokens, 10240, "small windows keep room for a whole turn");
    const s = compactionSettings(24576, d); // Strata's window
    assert.ok(s.reserveTokens >= 8192 + 1024 && s.keepRecentTokens < 24576 - s.reserveTokens);
    assert.equal(compactionSettings(131072, contextSettings({ auto_compact: false })).enabled, false);
    assert.deepEqual(contextSettings({ compact_at: 2, keep_recent: 0.9 }), { auto: true, at: 0.9, keep: 0.45 }, "clamped");
    assert.equal(contextSettings({ compact_at: 0.7, keep_recent: 0.6 }).keep, 0.35, "what is kept leaves room to work");
  });

  test("Echo's compaction: Pi's summary with Echo's focus, no thinking, then the plan and messages word for word", async () => {
    const { echoCompaction, echoPart, stripEchoPart, ECHO_PART } = await import("../src/compaction.ts");
    const state = {
      plan: [{ text: "Add the route", status: "done" }, { text: "Test it", status: "in_progress" }, { text: "Docs", status: "pending" }],
      userMessages: [{ ts: Date.UTC(2026, 10, 10, 14, 2), text: "Use port 9000, not 8000." }],
      checkpoints: [{ sha: "0123456789abcdef", label: "before edit batch 1" }],
    };
    const part = echoPart(state);
    assert.match(part, /- \[done\] Add the route\n- \[now\] Test it\n- \[todo\] Docs/);
    assert.match(part, /14:02 UTC: Use port 9000, not 8000\./);
    assert.match(part, /0123456789 before edit batch 1/);
    assert.equal(stripEchoPart(`summary${part}`), "summary");
    assert.equal(stripEchoPart("no part"), "no part");

    let body: any;
    const srv = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        body = JSON.parse(raw);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "## Goal\nShip the route." } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 6, total_tokens: 56 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const model = {
      id: "m", name: "m", api: "openai-completions", provider: "echo", baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/v1`,
      reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsStore: false, thinkingFormat: "chat-template", maxTokensField: "max_tokens",
        chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } } },
    };
    const preparation = {
      firstKeptEntryId: "e5", isSplitTurn: false, turnPrefixMessages: [], tokensBefore: 92000,
      messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "Add a /ping route." }], timestamp: 1 }],
      previousSummary: `## Goal\nOlder work.${ECHO_PART}## Plan\n- [todo] the old plan`,
      fileOps: { read: new Set(["a.ts"]), written: new Set<string>(), edited: new Set(["b.ts"]) },
      settings: { enabled: true, reserveTokens: 39322, keepRecentTokens: 32768 },
    };
    const event = { type: "session_before_compact", preparation, branchEntries: [], reason: "threshold", willRetry: false, signal: new AbortController().signal, customInstructions: "the port" };
    const r = await echoCompaction(event as any, model, state);
    srv.close();
    const prompt = JSON.stringify(body.messages);
    assert.match(prompt, /Additional focus: The summary replaces the conversation for a coding agent/);
    assert.match(prompt, /The user asked to focus on: the port/);
    assert.match(prompt, /Older work\./, "the previous summary is updated");
    assert.ok(!prompt.includes("the old plan"), "Echo's old part is not summarized again");
    assert.equal(body.chat_template_kwargs?.enable_thinking ?? false, false, "no thinking");
    assert.equal(r.firstKeptEntryId, "e5");
    assert.equal(r.tokensBefore, 92000);
    assert.ok(r.summary.startsWith("## Goal\nShip the route."));
    assert.match(r.summary, /<read-files>\na\.ts\n<\/read-files>/);
    assert.match(r.summary, /<modified-files>\nb\.ts\n<\/modified-files>/);
    assert.ok(r.summary.endsWith(part), "Echo's part comes last");
  });
});

describe("TLDR for requests", () => {
  const base = {
    task: "Add a Live chat mode to Echo", plan: [{ text: "STT endpoint", status: "in_progress" }, { text: "Live tab", status: "pending" }],
    recent: [{ tool: "echo_dev_request", args: "POST /api/live/stt", result: "502 fetch failed (connect ECONNREFUSED 127.0.0.1:8089)", error: false }],
    messages: ["STT isn't exposed on the host."], stepBudget: 16,
  };

  test("a needs-you request: the trigger, the concrete error, and what each answer really does, revert included", async () => {
    const { explainPrompt } = await import("../src/agent.ts");
    const p = explainPrompt({
      ...base,
      request: { kind: "hitl", ts: 0, id: "h1", probability: 0.54, next: "revert", progress: "steady", trigger: "step budget (16 tool calls)", options: [] },
      checkpoint: { sha: "4e2f6281234", label: "before edits (4)" }, undo: " apps/server/src/main.ts | 12 ++++++------\n 1 file changed",
    });
    assert.match(p, /ECONNREFUSED 127\.0\.0\.1:8089/);
    assert.match(p, /next step "revert", progress "steady", probability that a human is needed 0\.54/);
    assert.match(p, /every 16 tool calls/);
    assert.match(p, /- revert: the working folder goes back to checkpoint 4e2f6281 \("before edits \(4\)"\), undoing these changes:\napps\/server\/src\/main\.ts \| 12/);
    assert.match(p, /- re-plan: .*new plan/);
    assert.match(p, /\[now\] STT endpoint/);
    assert.match(p, /at most 120 words/);
  });

  test("an approval request: the command, why Echo asks, and that approving runs it outside the sandbox", async () => {
    const { explainPrompt } = await import("../src/agent.ts");
    const p = explainPrompt({ ...base, request: { kind: "approval", ts: 0, id: "a1", action: "git push origin main", reason: "pushing main", rule: "always-ask", decision: { noul: 0.31 } }, undo: "" });
    assert.match(p, /wants to run: git push origin main/);
    assert.match(p, /because: pushing main \(the user's rule "always-ask"\)/);
    assert.match(p, /probability 0\.31/);
    assert.match(p, /approve: the command runs \(outside the sandbox\)/);
    assert.doesNotMatch(p, /- revert:/);
  });
});

describe("git tab", () => {
  test("refs: local branches with slashes, remote branches, tags and pull requests", async () => {
    const { parseRefs } = await import("../src/gitview.ts");
    assert.deepEqual(parseRefs("HEAD -> main, origin/main, origin/HEAD, feat/live-chat, tag: v1.0, refs/pull/3/head", ["origin"]), [
      { name: "HEAD", kind: "head" }, { name: "main", kind: "branch" }, { name: "origin/main", kind: "remote" },
      { name: "feat/live-chat", kind: "branch" }, { name: "v1.0", kind: "tag" }, { name: "#3", kind: "pr" },
    ]);
  });

  test("the graph shows branches and merges but not the agent's checkpoints; a merge's diff is what it brought in", async () => {
    const { commitDetail, graph, localRepos } = await import("../src/gitview.ts");
    const parent = mkdtempSync(path.join(tmp, "projects-"));
    const dir = path.join(parent, "proj");
    mkdirSync(dir);
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" }).trim();
    g("init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    g("add", "-A");
    g("commit", "-qm", "A");
    g("switch", "-qc", "feat/x");
    writeFileSync(path.join(dir, "b.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "B on feat/x");
    g("switch", "-q", "main");
    writeFileSync(path.join(dir, "c.txt"), "c\n");
    g("add", "-A");
    g("commit", "-qm", "C");
    g("merge", "-q", "--no-ff", "-m", "Merge feat/x", "feat/x");
    // an agent checkpoint: a commit kept under refs/echo/, on no branch
    const tree = g("write-tree");
    const checkpoint = g("commit-tree", tree, "-m", "checkpoint");
    g("update-ref", "refs/echo/run/0", checkpoint);

    const repos = localRepos([parent]);
    assert.deepEqual(repos.map((r) => r.name), ["proj"]);
    const out = await graph(repos[0], 50);
    assert.deepEqual(out.commits.map((c) => c.subject), ["Merge feat/x", "C", "B on feat/x", "A"]);
    assert.ok(!out.commits.some((c) => c.sha === checkpoint), "checkpoints stay out of the graph");
    assert.equal(out.commits[0].parents.length, 2);
    assert.deepEqual(out.commits[0].refs.map((r) => r.name), ["HEAD", "main"]);
    assert.equal(out.head, "main");
    assert.deepEqual([...out.branches].sort(), ["feat/x", "main"]);
    const merge = await commitDetail(repos[0], out.commits[0].sha);
    assert.deepEqual(merge.files.map((f) => f.path), ["b.txt"]);
    assert.match(merge.patch, /\+b/);
    const root = await commitDetail(repos[0], out.commits[3].sha);
    assert.deepEqual(root.files.map((f) => f.path), ["a.txt"]);
    await assert.rejects(commitDetail(repos[0], "not-a-sha"), /not a commit/);
  });

  test("only listed repositories can be read: an id is never taken as a path", async () => {
    const { repoById } = await import("../src/gitview.ts");
    assert.throws(() => repoById("local:/etc"), /unknown repository/);
    assert.throws(() => repoById("gh:someone/else"), /unknown repository/);
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

