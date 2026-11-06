import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { encodeWav, prepare, readWav, run } from "../../../tools/voice-compare.ts";

const RATE = 24_000;
const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** `speech` seconds of tone at `level`, with a second of silence on each side */
function recording(speech: number, level = 0.3, hz = 220): Float32Array {
  const pcm = new Float32Array((speech + 2) * RATE);
  for (let i = RATE; i < pcm.length - RATE; i++) pcm[i] = level * Math.sin((2 * Math.PI * hz * i) / RATE);
  return pcm;
}

function workspace(samples: Record<string, Float32Array | string>, lines = "First line.\nSecond line.\n"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-compare-"));
  roots.push(dir);
  mkdirSync(path.join(dir, "samples"));
  writeFileSync(path.join(dir, "lines.txt"), lines);
  for (const [name, v] of Object.entries(samples)) writeFileSync(path.join(dir, "samples", name), typeof v === "string" ? v : encodeWav(v));
  return dir;
}

const MODELS = [
  { id: "pocket", name: "Pocket TTS", installed: true, canClone: true, sample: { min: 3, max: 30, ideal: [10, 15] } },
  { id: "kokoro", name: "Kokoro", installed: true, canClone: false },
  { id: "qwen3", name: "Qwen3-TTS", installed: true, canClone: true, sample: { min: 3, max: 30, ideal: [10, 20] } },
  { id: "voxcpm", name: "VoxCPM2", installed: false, canClone: true, sample: { min: 5, max: 30, ideal: [10, 30] } },
];

/** Echo's voice API as the tool uses it: Pocket TTS without its gated weights, VoxCPM2 not downloaded. */
async function fakeEcho() {
  const log = {
    cloned: [] as { name: string; engine: string; audio: string; transcript?: string }[],
    said: [] as { text: string; voice: string }[],
    deleted: [] as string[],
  };
  const voices: { id: string }[] = [];
  let n = 0;
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (b: Buffer) => chunks.push(b));
    req.on("end", () => {
      const json = (code: number, o: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (req.method === "GET" && req.url === "/api/read/voices") return json(200, { models: MODELS, voices });
      if (req.method === "POST" && req.url === "/api/read/voices") {
        log.cloned.push(body);
        if (body.engine === "pocket") return json(400, { error: "Voice cloning needs Kyutai's cloning weights" });
        const v = { id: `clone:${body.name}-${body.engine}-${++n}` };
        voices.push(v);
        return json(200, v);
      }
      if (req.method === "POST" && req.url === "/api/read/tts") {
        log.said.push(body);
        if (String(body.text).includes("BREAK")) return json(500, { error: "worker stopped" });
        res.writeHead(200, { "Content-Type": "audio/wav" });
        return res.end(encodeWav(new Float32Array(2 * RATE)));
      }
      if (req.method === "DELETE" && req.url?.startsWith("/api/read/voices/")) {
        const id = decodeURIComponent(req.url.slice("/api/read/voices/".length));
        log.deleted.push(id);
        voices.splice(voices.findIndex((v) => v.id === id), 1);
        return json(200, { ok: true });
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  after(() => srv.close());
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, log, voices };
}

const options = (dir: string, url: string) => ({ dir, url, engines: ["pocket", "qwen3", "voxcpm"], log: () => {} });
const results = (dir: string, file: string) => path.join(dir, "results", file);

describe("voice comparison", () => {
  test("prepares a sample like the Read tab: trimmed, normalized, capped", () => {
    const short = prepare(recording(12), 30);
    assert.ok(Math.abs(short.seconds - 12.4) < 0.01, `12 s of speech + 0.2 s of padding each side, got ${short.seconds}`);
    const wav = readWav(short.wav)!;
    assert.deepEqual([wav.format, wav.channels, wav.rate, wav.bits], [1, 1, RATE, 16]);
    let peak = 0;
    for (let i = 0; i < wav.data.length; i += 2) peak = Math.max(peak, Math.abs(wav.data.readInt16LE(i)) / 0x7fff);
    assert.ok(Math.abs(peak - 0.95) < 0.01, `peak ${peak}`);
    assert.equal(prepare(recording(40), 30).seconds, 30);
    assert.throws(() => prepare(new Float32Array(RATE), 30), /silent/);
  });

  test("clones each sample in each model that can, says every line, and writes the page", async () => {
    const echo = await fakeEcho();
    const dir = workspace({ "alice.wav": recording(12), "alice.txt": "﻿Word for word.\r\n", "bob_smith.wav": recording(15, 0.5, 180) });
    const out = await run(options(dir, echo.url));

    const qwen = echo.log.cloned.filter((c) => c.engine === "qwen3");
    assert.deepEqual(qwen.map((c) => c.name), ["alice", "bob smith"]);
    assert.equal(qwen[0].transcript, "Word for word.");
    assert.equal(qwen[1].transcript, undefined, "left for Echo to transcribe");
    const sent = readWav(Buffer.from(qwen[0].audio.replace("data:audio/wav;base64,", ""), "base64"))!;
    assert.ok(Math.abs(sent.data.length / 2 / RATE - 12.4) < 0.01, "the prepared sample is what gets cloned");

    assert.equal(echo.log.said.filter((s) => s.voice.startsWith("clone:")).length, 4, "2 voices, 2 lines, only Qwen3-TTS can run");
    assert.equal(echo.log.said.filter((s) => s.voice === "kokoro:af_heart").length, 2, "the preset is made once, not per voice");

    assert.match(out.failed.get("alice/pocket") ?? "", /cloning weights/);
    assert.match(out.skipped.get("voxcpm") ?? "", /not downloaded/);
    for (const f of ["alice/reference.wav", "alice/qwen3-1.wav", "bob-smith/qwen3-2.wav", "preset/kokoro-1.wav"]) assert.ok(existsSync(results(dir, f)), f);

    const html = readFileSync(out.page, "utf8");
    for (const src of ["alice/reference.wav", "alice/qwen3-1.wav", "bob-smith/qwen3-2.wav", "preset/kokoro-2.wav"]) assert.ok(html.includes(`src="${src}"`), src);
    assert.ok(html.includes("Pocket TTS: Voice cloning needs Kyutai's"), "says why Pocket TTS made nothing");
    assert.ok(html.includes("VoxCPM2: not downloaded"));
    assert.equal(html.match(/Voice cloning needs/g)?.length, 1, "the same reason for two voices is listed once");
    assert.ok(html.includes("Word for word."));
  });

  test("a second run only makes what is missing or changed", async () => {
    const echo = await fakeEcho();
    const dir = workspace({ "alice.wav": recording(12), "bob.wav": recording(15, 0.5, 180) });
    await run(options(dir, echo.url));
    const count = () => ({ qwen: echo.log.cloned.filter((c) => c.engine === "qwen3").length, said: echo.log.said.length });

    let before = count();
    await run(options(dir, echo.url));
    assert.deepEqual(count(), before, "nothing changed, nothing redone");

    before = count();
    writeFileSync(path.join(dir, "lines.txt"), "First line.\nA new second line.\n");
    await run(options(dir, echo.url));
    assert.deepEqual(count(), { qwen: before.qwen, said: before.said + 3 }, "the new line in 2 clones and the preset");

    before = count();
    const oldAlice = echo.voices.find((v) => v.id.startsWith("clone:alice-qwen3"))!.id;
    writeFileSync(path.join(dir, "samples", "alice.wav"), encodeWav(recording(14)));
    await run(options(dir, echo.url));
    assert.deepEqual(echo.log.deleted, [oldAlice], "the clone of the old recording goes, and only that one");
    assert.deepEqual(count(), { qwen: before.qwen + 1, said: before.said + 2 }, "Alice is cloned again and repeats both lines");

    before = count();
    echo.voices.splice(echo.voices.findIndex((v) => v.id.startsWith("clone:bob-qwen3")), 1); // deleted in the voice picker
    await run(options(dir, echo.url));
    assert.deepEqual(count(), { qwen: before.qwen + 1, said: before.said + 2 }, "a clone removed in Echo is made again");
  });

  test("a failed line doesn't stop the others, and is retried on the next run", async () => {
    const echo = await fakeEcho();
    const dir = workspace({ "alice.wav": recording(12) }, "BREAK here.\nThis one works.\n");
    const out = await run(options(dir, echo.url));
    assert.equal(out.failed.get("alice/qwen3/0"), "worker stopped");
    assert.ok(existsSync(results(dir, "alice/qwen3-2.wav")));
    assert.ok(!existsSync(results(dir, "alice/qwen3-1.wav")));
    const html = readFileSync(out.page, "utf8");
    assert.ok(html.includes("Qwen3-TTS: worker stopped"));
    assert.ok(html.includes("<small>not made</small>"));

    const before = echo.log.said.length;
    await run(options(dir, echo.url));
    assert.equal(echo.log.said.length, before + 2, "the failed line in the clone and in the preset, not the finished ones");
  });

  test("a sample too short for a model is refused without asking Echo", async () => {
    const echo = await fakeEcho();
    const dir = workspace({ "tiny.wav": recording(2) });
    const out = await run(options(dir, echo.url));
    assert.match(out.failed.get("tiny/qwen3") ?? "", /at least 3 s/);
    assert.equal(echo.log.cloned.length, 0);
  });

  test("stops early with a useful message", async () => {
    const echo = await fakeEcho();
    await assert.rejects(run(options(workspace({ "quiet.wav": new Float32Array(5 * RATE) }), echo.url)), /quiet\.wav: this recording is silent/);

    const empty = mkdtempSync(path.join(os.tmpdir(), "voice-compare-"));
    roots.push(empty);
    await assert.rejects(run(options(empty, echo.url)), /no recordings in .*about 15 s each/);
    assert.ok(existsSync(path.join(empty, "samples")), "the folder is there to drop them into");

    await assert.rejects(run(options(workspace({ "a.wav": recording(12), "A.flac": recording(12) }), echo.url)), /share the name a/);

    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      await assert.rejects(run(options(workspace({ "voice.mp3": "not really an mp3" }), echo.url)), /voice\.mp3 needs ffmpeg/);
    } finally {
      process.env.PATH = saved;
    }

    const down = createServer();
    await new Promise<void>((r) => down.listen(0, "127.0.0.1", r));
    const port = (down.address() as AddressInfo).port;
    await new Promise((r) => down.close(r));
    await assert.rejects(run(options(workspace({ "a.wav": recording(12) }), `http://127.0.0.1:${port}`)), /Echo isn't answering at .*start it first/);
  });
});
