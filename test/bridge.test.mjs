import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge, MIB } from "../src/bridge.mjs";
import { FileCache, sha256 } from "../src/cache.mjs";
import { DeepSeekFilesPlugin } from "../index.mjs";
import { importMagpieKey } from "../src/paths.mjs";

const URL = "https://api.deepseek.com/v1/responses";
const url = bytes => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
const image = bytes => ({ type: "input_image", image_url: url(bytes), detail: "original" });
const body = (...images) => JSON.stringify({ model: "deepseek-flash", input: [{ role: "user", content: [{ type: "input_text", text: "inspect" }, ...images] }] });
const request = (fetch, payload, signal) => fetch(URL, { method: "POST", body: payload, headers: { "content-type": "application/json" }, signal });

async function setup(t, handler, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-files-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], metrics = [];
  let auth = { type: "api", key: "test-key-never-log" }, fileN = 0;
  const fetch = createBridge({ cacheDir: directory, getAuth: async () => auth, onMetric: x => metrics.push(x),
    fetchImpl: async (input, init) => {
      calls.push({ url: input, init });
      if (handler) { const result = await handler(input, init, calls); if (result) return result; }
      if (input.endsWith("/files")) return Response.json({ id: `file-api-${++fileN}`, expires_at: (extra.now?.() ?? Date.now())/1000+604800 });
      return Response.json({ ok: true });
    }, ...extra });
  return { fetch, calls, metrics, directory, setAuth: value => { auth = value; }, uploads: () => calls.filter(x => x.url.endsWith("/files")), inference: () => calls.filter(x => !x.url.endsWith("/files")) };
}

test("uploads exact bytes once; references duplicate and historical tool images without changing call pairs", async t => {
  const s = await setup(t), raw = Buffer.from("original-image-bytes");
  const source = JSON.stringify({ model: "deepseek-flash", instructions: "unchanged", input: [
    { type: "function_call", call_id: "call1", name: "view_image", arguments: "{}" },
    { type: "function_call_output", call_id: "call1", output: [{ type: "input_text", text: "same" }, image(raw)] },
    { type: "custom_tool_call", call_id: "call2", name: "apply_patch", input: "patch" },
    { type: "custom_tool_call_output", call_id: "call2", output: [image(raw)] },
    { role: "user", content: [image(raw)] },
  ] });
  assert.equal((await request(s.fetch, source)).status, 200);
  assert.equal(s.uploads().length, 1);
  assert.deepEqual(Buffer.from(await s.uploads()[0].init.body.get("file").arrayBuffer()), raw);
  assert.equal(s.uploads()[0].init.body.get("expires_after[seconds]"), "604800");
  const result = JSON.parse(s.inference()[0].init.body);
  assert.equal(result.input[1].call_id, "call1");
  assert.equal(result.input[3].call_id, "call2");
  assert.equal(result.input[1].output[1].file_id, "file-api-1");
  assert.equal(result.input[3].output[0].file_id, "file-api-1");
  assert.equal(result.input[4].content[0].file_id, "file-api-1");
  assert.equal(result.instructions, "unchanged");
  assert.equal(JSON.stringify(result).includes("base64"), false);
  assert.equal(source.includes("base64"), true);
  await request(s.fetch, source);
  assert.equal(s.uploads().length, 1);
});

test("disk cache survives a new bridge and contains metadata only", async t => {
  const s = await setup(t), source = body(image("picture"));
  await request(s.fetch, source);
  const again = createBridge({ getAuth: async () => ({ type: "api", key: "test-key-never-log" }), cacheDir: s.directory,
    fetchImpl: async (input, init) => { assert.ok(!input.endsWith("/files")); return Response.json({ ok: true }); } });
  assert.equal((await request(again, source)).status, 200);
  const [scope] = await readdir(s.directory), [name] = await readdir(join(s.directory, scope));
  const text = await readFile(join(s.directory, scope, name), "utf8");
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["bytes", "expiresAt", "id"]);
  assert.equal(text.includes("test-key"), false);
  assert.equal(text.includes("picture"), false);
});

test("API key changes cannot reuse another credential's file IDs", async t => {
  const s = await setup(t), source = body(image("account-isolation"));
  await request(s.fetch, source);
  s.setAuth({ type: "api", key: "another-account" });
  await request(s.fetch, source);
  assert.equal(s.uploads().length, 2);
  assert.notEqual(JSON.parse(s.inference()[0].init.body).input[0].content[1].file_id, JSON.parse(s.inference()[1].init.body).input[0].content[1].file_id);
});

test("expired cached metadata is reuploaded before inference", async t => {
  let now = Date.now();
  const s = await setup(t, null, { now: () => now });
  assert.equal((await request(s.fetch, body(image("expires")))).status, 200);
  now += 604800000;
  assert.equal((await request(s.fetch, body(image("expires")))).status, 200);
  assert.equal(s.uploads().length, 2);
});

test("deleted remote file refreshes once; no original 413 loop", async t => {
  let inference = 0;
  const s = await setup(t, (input) => {
    if (!input.endsWith("/files") && ++inference === 1) return Response.json({ error: { code: "file_not_found", message: "file_id not found" } }, { status: 404 });
  });
  assert.equal((await request(s.fetch, body(image("stale")))).status, 200);
  assert.equal(s.uploads().length, 2);
  assert.equal(s.inference().length, 2);
});

test("persistent stale-file errors stop after one retry", async t => {
  const s = await setup(t, input => input.endsWith("/files") ? null : Response.json({ error: { message: "file_id expired" } }, { status: 400 }));
  assert.equal((await request(s.fetch, body(image("stale-forever")))).status, 400);
  assert.equal(s.inference().length, 2);
});

test("upstream 413 is returned once without dropping images", async t => {
  const s = await setup(t, input => input.endsWith("/files") ? null : Response.json({ error: { message: "body too large" } }, { status: 413 }));
  assert.equal((await request(s.fetch, body(image("keep-me")))).status, 413);
  assert.equal(s.inference().length, 1);
  assert.ok(JSON.parse(s.inference()[0].init.body).input[0].content[1].file_id);
});

test("upload rejection does not submit a partial conversation or leak upstream text", async t => {
  const s = await setup(t, input => input.endsWith("/files") ? new Response("test-key-never-log PRIVATE", { status: 402 }) : null);
  const response = await request(s.fetch, body(image("private")));
  assert.equal(response.status, 402);
  assert.equal(s.inference().length, 0);
  assert.equal((await response.text()).includes("PRIVATE"), false);
});

test("invalid Base64 cannot silently become an empty or truncated image", async t => {
  const s = await setup(t);
  const response = await request(s.fetch, body({ type: "input_image", image_url: "data:image/png;base64,AA!=" }));
  assert.equal(response.status, 400);
  assert.equal(s.calls.length, 0);
});

test("external URLs, existing IDs, schemas and tool argument strings stay untouched", async t => {
  const s = await setup(t);
  const source = JSON.stringify({ model: "deepseek-flash", tools: [{ example: image("schema") }], input: [
    { role: "user", content: [{ type: "input_image", image_url: "https://example.com/a.png" }, { type: "input_image", file_id: "file-api-existing" }] },
    { type: "function_call", arguments: JSON.stringify(image("arguments")) },
  ] });
  await request(s.fetch, source);
  assert.equal(s.uploads().length, 0);
  assert.equal(s.inference()[0].init.body, source);
});

test("chat completions use official file blocks, including inline file_data", async t => {
  const s = await setup(t);
  const source = JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: url("a") } }, { type: "file", file_data: url("b"), filename: "x.png" }] }] });
  const response = await s.fetch("https://api.deepseek.com/chat/completions", { method: "POST", body: source });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(s.inference()[0].init.body).messages[0].content.map(x => Object.keys(x).sort()), [["file_id", "type"], ["file_id", "type"]]);
});

test("credentials cannot be redirected to a different host", async t => {
  const s = await setup(t);
  assert.equal((await s.fetch("https://evil.example/responses", { method: "POST", body: body(image("secret")) })).status, 400);
  assert.equal(s.calls.length, 0);
});

test("text-only requests preserve exact bytes and streaming response identity", async t => {
  const streaming = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: hello\n\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
  const s = await setup(t, () => streaming);
  const source = '{ "model": "deepseek-flash", "input": "hi", "stream": true }';
  const response = await request(s.fetch, source);
  assert.equal(response, streaming);
  assert.equal(s.inference()[0].init.body, source);
  assert.equal(await response.text(), "data: hello\n\n");
});

test("concurrent requests deduplicate uploads", async t => {
  const s = await setup(t, async input => { if (input.endsWith("/files")) await new Promise(r => setTimeout(r, 20)); });
  await Promise.all(Array.from({ length: 6 }, () => request(s.fetch, body(image("shared")))));
  assert.equal(s.uploads().length, 1);
  assert.equal(s.inference().length, 6);
});

test("aborting one waiter does not abort another request sharing the upload", async t => {
  const s = await setup(t, async (input, init) => {
    if (input.endsWith("/files")) { await new Promise(r => setTimeout(r, 40)); init.signal.throwIfAborted(); }
  });
  const controller = new AbortController();
  const canceled = request(s.fetch, body(image("shared-abort")), controller.signal);
  const survived = request(s.fetch, body(image("shared-abort")));
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(canceled, e => e.name === "AbortError");
  assert.equal((await survived).status, 200);
  assert.equal(s.uploads().length, 1);
  assert.equal(s.inference().length, 1);
});

test("a canceled upload never starts inference", async t => {
  const s = await setup(t, async (input, init) => {
    if (input.endsWith("/files")) await new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  });
  const controller = new AbortController(), pending = request(s.fetch, body(image("cancel")), controller.signal);
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(pending, e => e.name === "AbortError");
  assert.equal(s.inference().length, 0);
});

test("over-48-MiB image request becomes small without deleting any images", async t => {
  const s = await setup(t), large = image(Buffer.alloc(19*MIB, 7));
  const source = body(large, structuredClone(large));
  assert.ok(Buffer.byteLength(source) > 48*MIB);
  assert.equal((await request(s.fetch, source)).status, 200);
  assert.ok(Buffer.byteLength(s.inference()[0].init.body) < 1024);
  assert.equal(JSON.parse(s.inference()[0].init.body).input[0].content.filter(x => x.file_id).length, 2);
  assert.equal(s.uploads().length, 1);
});

test("native plugin advertises Responses and imports only an official configured key", async t => {
  const s = await setup(t), hooks = await DeepSeekFilesPlugin(), config = {};
  await hooks.config(config);
  assert.equal(hooks.auth.provider, "deepseek-files");
  assert.match(hooks.auth.icon, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(hooks.auth.icon.split(",")[1], "base64").toString(), /<title>DeepSeek<\/title>/);
  assert.equal(config.provider["deepseek-files"].npm, "@ai-sdk/openai");
  assert.ok(config.provider["deepseek-files"].models["deepseek-flash"].modalities.input.includes("image"));
  await writeFile(join(s.directory, "providers.json"), JSON.stringify({ providers: [{ id: "deepseek", key: "local-key", responses: "https://api.deepseek.com/v1" }] }));
  assert.equal(await importMagpieKey(s.directory), "local-key");
  await writeFile(join(s.directory, "providers.json"), JSON.stringify({ providers: [{ id: "deepseek", key: "local-key", responses: "https://relay.example/v1" }] }));
  await assert.rejects(importMagpieKey(s.directory), /official/);
  await writeFile(join(s.directory, "providers.json"), JSON.stringify({ providers: [{ id: "deepseek", key: "local-key" }] }));
  await assert.rejects(importMagpieKey(s.directory), /official/);
});

test("cache identity does not allow path traversal", async t => {
  const s = await setup(t), cache = new FileCache(s.directory);
  assert.throws(() => cache.path("../private", sha256("x")), /identity/);
});

test("entry exports exactly one callable plugin for Magpie's loader", async () => {
  const entry = await import("../index.mjs");
  assert.deepEqual(Object.entries(entry).filter(([,value]) => typeof value === "function").map(([name])=>name), ["DeepSeekFilesPlugin"]);
});
