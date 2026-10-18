// Opt-in live parity tests. Uses synthetic prompts and mocked tool results only.
// Never runs tools or saves credentials, conversations or reasoning content.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";

const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : fallback; };
const gateway = arg("--gateway", "http://127.0.0.1:3425");
const providers = arg("--providers", "deepseek,deepseek-files").split(",");
const model = arg("--model", "deepseek-flash");
const report = { gateway, model, results: [] };
const headers = { authorization: `Bearer ${process.env.MAGPIE_GATEWAY_KEY || "magpie"}`, "content-type": "application/json", "anthropic-version": "2023-06-01" };

function png(width, height, noise = false) {
  const crc = bytes => { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (name, bytes) => { const type = Buffer.from(name), length = Buffer.alloc(4), sum = Buffer.alloc(4); length.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc(Buffer.concat([type, bytes]))); return Buffer.concat([length, type, bytes, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const start = y * (width * 3 + 1) + 1;
    if (noise) randomBytes(width * 3).copy(rows, start);
    else for (let x = 0; x < width; x++) rows[start + x * 3 + (x < width / 2 ? 0 : 2)] = 255;
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const image = png(64, 32).toString("base64");
const imagePart = protocol => protocol === "responses" ? { type: "input_image", image_url: `data:image/png;base64,${image}` }
  : protocol === "chat" ? { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }
  : { type: "image", source: { type: "base64", media_type: "image/png", data: image } };
const textPart = (protocol, text) => ({ type: protocol === "responses" ? "input_text" : "text", text });
const path = protocol => ({ responses: "/v1/responses", chat: "/v1/chat/completions", anthropic: "/v1/messages" })[protocol];
function requestBody(protocol, text, { thinking = false, stream = false } = {}) {
  const messages = [{ role: "user", content: text }];
  return protocol === "responses" ? { input: messages, reasoning: { effort: thinking ? "low" : "none" }, max_output_tokens: thinking ? 2048 : 128, stream }
    : protocol === "chat" ? { messages, reasoning_effort: thinking ? "low" : "none", max_tokens: thinking ? 2048 : 128, stream }
    : { messages, thinking: { type: thinking ? "enabled" : "disabled" }, ...(thinking ? { output_config: { effort: "low" } } : {}), max_tokens: thinking ? 2048 : 128, stream };
}
const answer = (protocol, data) => protocol === "responses" ? (data.output ?? []).flatMap(x => x.content ?? []).filter(x => x.type === "output_text").map(x => x.text).join("")
  : protocol === "chat" ? data.choices?.[0]?.message?.content ?? "" : (data.content ?? []).filter(x => x.type === "text").map(x => x.text).join("");
async function ask(provider, protocol, body) {
  const response = await fetch(gateway + path(protocol), { method: "POST", headers, body: JSON.stringify({ model: `${provider}/${model}`, ...body }), signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
    let message = "";
    try { message = (await response.json()).error?.message ?? ""; } catch {}
    throw new Error(`HTTP ${response.status}: ${message}`.slice(0, 300));
  }
  return body.stream ? response.text() : response.json();
}
const tests = [];
const add = (name, run) => tests.push({ name, run });
for (const protocol of ["responses", "chat", "anthropic"]) {
  add(`${protocol}: text`, async provider => { assert.match(answer(protocol, await ask(provider, protocol, requestBody(protocol, "Reply only PARITY_OK"))), /PARITY_OK/); });
  add(`${protocol}: SSE`, async provider => {
    const events = await ask(provider, protocol, requestBody(protocol, "Reply only STREAM_OK", { stream: true }));
    assert.match(events, /STREAM|OK/);
    assert.match(events, protocol === "responses" ? /response.completed/ : protocol === "chat" ? /\[DONE\]/ : /message_stop/);
  });
  add(`${protocol}: thinking`, async provider => {
    const data = await ask(provider, protocol, requestBody(protocol, "What is 17 times 19? Reply only the integer.", { thinking: true }));
    assert.match(answer(protocol, data), /323/);
    const reasoning = protocol === "responses" ? data.output?.some(x => x.type === "reasoning")
      : protocol === "chat" ? Boolean(data.choices?.[0]?.message?.reasoning_content) : data.content?.some(x => x.type === "thinking");
    assert.ok(reasoning, "reasoning should survive protocol conversion");
  });
  add(`${protocol}: vision`, async provider => {
    const data = await ask(provider, protocol, requestBody(protocol, [textPart(protocol, "Name the two colors from left to right. Reply only the two English color names."), imagePart(protocol)]));
    assert.match(answer(protocol, data).toLowerCase(), /red[\s\S]*blue/);
  });
  for (const format of ["json_object", "json_schema"]) add(`${protocol}: ${format}`, async provider => {
    const body = requestBody(protocol, "Return JSON with a single boolean property ok equal to true.");
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
    if (protocol === "responses") body.text = { format: format === "json_object" ? { type: format } : { type: format, name: "result", strict: true, schema } };
    else if (protocol === "chat") body.response_format = format === "json_object" ? { type: format } : { type: format, json_schema: { name: "result", strict: true, schema } };
    else body.output_config = { format: { type: "json_schema", schema } };
    assert.equal(JSON.parse(answer(protocol, await ask(provider, protocol, body))).ok, true);
  });
  for (const withImage of [false, true]) add(`${protocol}: thinking tool roundtrip${withImage ? " with image" : ""}`, async provider => {
    const name = withImage ? "get_picture" : "get_number";
    const body = requestBody(protocol, withImage ? "Call get_picture exactly once, then name its two colors from left to right in English." : "Call get_number exactly once. Reply with only the returned integer.", { thinking: true });
    const parameters = { type: "object", properties: {}, additionalProperties: false };
    body.tools = protocol === "responses" ? [{ type: "function", name, parameters }]
      : protocol === "chat" ? [{ type: "function", function: { name, parameters } }] : [{ name, input_schema: parameters }];
    // DeepSeek's thinking mode permits auto tool choice, not a forced function.
    const first = await ask(provider, protocol, body);
    const output = withImage ? [textPart(protocol, "Here is the picture."), imagePart(protocol)] : "23";
    const next = structuredClone(body); delete next.tool_choice;
    if (protocol === "responses") {
      const call = first.output?.find(x => x.type === "function_call"); assert.ok(call, "missing function call");
      next.input.push(...first.output, { type: "function_call_output", call_id: call.call_id, output });
    } else if (protocol === "chat") {
      const message = first.choices?.[0]?.message, call = message?.tool_calls?.[0]; assert.ok(call, "missing tool call");
      next.messages.push(message, { role: "tool", tool_call_id: call.id, content: output });
    } else {
      const call = first.content?.find(x => x.type === "tool_use"); assert.ok(call, "missing tool use");
      next.messages.push({ role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: output }] });
    }
    assert.match(answer(protocol, await ask(provider, protocol, next)).toLowerCase(), withImage ? /red[\s\S]*blue/ : /23/);
  });
  add(`${protocol}: nested schema null escape`, async provider => {
    const body = requestBody(protocol, "Reply only SCHEMA_OK. Do not call tools.");
    const parameters = { type: "object", properties: { value: { type: "string", pattern: String.raw`^[^\0]+$` } } };
    body.tools = protocol === "responses" ? [{ type: "function", name: "validate", parameters }]
      : protocol === "chat" ? [{ type: "function", function: { name: "validate", parameters } }] : [{ name: "validate", input_schema: parameters }];
    assert.match(answer(protocol, await ask(provider, protocol, body)), /SCHEMA_OK/);
  });
}
add("chat: assistant prefix", async provider => {
  const body = requestBody("chat", "Complete the sentence with the word blue.");
  body.messages.push({ role: "assistant", content: "The sky is", prefix: true });
  assert.match(answer("chat", await ask(provider, "chat", body)).toLowerCase(), /blue/);
});
add("chat: max_completion_tokens", async provider => {
  const body = requestBody("chat", "Count from 1 to 100, separated by spaces."); delete body.max_tokens; body.max_completion_tokens = 8;
  const data = await ask(provider, "chat", body);
  assert.ok(data.usage?.completion_tokens <= 8, "reply limit was ignored");
});
add("responses: native web search (Pro)", async provider => {
  const body = requestBody("responses", "Search the web for the official DeepSeek API documentation and reply with its domain.");
  body.max_output_tokens = 256; body.tools = [{ type: "web_search" }]; body.tool_choice = "required";
  body.model = `${provider}/deepseek-v4-pro`;
  let data = await ask(provider, "responses", body);
  assert.ok(data.output?.some(x => x.type === "web_search_call"), "search was not performed natively");
  if (!answer("responses", data)) {
    body.input.push(...data.output);
    body.tool_choice = "none";
    data = await ask(provider, "responses", body);
  }
  assert.match(answer("responses", data), /api-docs.deepseek.com/);
});
add("responses: namespaced function roundtrip", async provider => {
  const body = requestBody("responses", "Call functions.get_number exactly once, then reply with only its returned integer.");
  body.tools = [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "get_number", parameters: { type: "object", properties: {} } }] }];
  const first = await ask(provider, "responses", body), call = first.output?.find(x => x.type === "function_call");
  assert.ok(call, "missing namespaced function call");
  body.input.push(...first.output, { type: "function_call_output", call_id: call.call_id, output: "23" });
  assert.match(answer("responses", await ask(provider, "responses", body)), /23/);
});
add("responses: custom apply_patch roundtrip (mock only)", async provider => {
  const body = requestBody("responses", "Call apply_patch exactly once to add hello.txt containing hello, then reply PATCH_OK after the tool succeeds.");
  body.max_output_tokens = 512;
  body.tools = [{ type: "custom", name: "apply_patch", description: "Apply a patch to edit files. Use *** Begin Patch, *** Add File: hello.txt, +hello, *** End Patch.", format: { type: "text" } }];
  const first = await ask(provider, "responses", body), call = first.output?.find(x => x.type === "custom_tool_call");
  assert.ok(call, "missing custom tool call");
  assert.equal(call.name, "apply_patch");
  body.input.push(...first.output, { type: "custom_tool_call_output", call_id: call.call_id, output: "Success. Updated files: A hello.txt" });
  assert.match(answer("responses", await ask(provider, "responses", body)), /PATCH_OK/);
});
add("responses: SSE thinking tool roundtrip", async provider => {
  const body = requestBody("responses", "Call get_number exactly once and reply with only its returned integer.", { thinking: true, stream: true });
  body.tools = [{ type: "function", name: "get_number", parameters: { type: "object", properties: {} } }];
  const terminal = events => events.split(/\r?\n/).filter(x => x.startsWith("data: {")).map(x => JSON.parse(x.slice(6))).find(x => x.type === "response.completed")?.response;
  const first = terminal(await ask(provider, "responses", body)), call = first?.output?.find(x => x.type === "function_call");
  assert.ok(call, "missing streamed tool call");
  body.input.push(...first.output, { type: "function_call_output", call_id: call.call_id, output: "23" });
  const second = terminal(await ask(provider, "responses", body));
  assert.match(answer("responses", second), /23/);
});
if (process.argv.includes("--manual-alias")) add("manually added legacy model alias", async provider => {
  const body = requestBody("responses", "Reply only ALIAS_OK.");
  body.model = `${provider}/deepseek-v4-flash-vision-exp`;
  assert.match(answer("responses", await ask(provider, "responses", body)), /ALIAS_OK/);
});
if (process.argv.includes("--large")) add("files bridge: over 48 MiB without image eviction", async provider => {
  if (provider === "deepseek") return { skipped: "Native inline request size limit is the defect this bridge fixes." };
  const dataURL = `data:image/png;base64,${png(1024, 1024, true).toString("base64")}`;
  const parts = [textPart("responses", "Transport test: reply only LARGE_OK.")];
  while (Buffer.byteLength(JSON.stringify(parts)) < 49 * 1024 * 1024) parts.push({ type: "input_image", image_url: dataURL });
  assert.match(answer("responses", await ask(provider, "responses", requestBody("responses", parts))), /LARGE_OK/);
  return { images: parts.length - 1, beforeBytes: Buffer.byteLength(JSON.stringify(parts)) };
});
for (const test of tests.filter(test => !arg("--filter", "") || test.name.includes(arg("--filter", "")))) {
  const results = await Promise.all(providers.map(async provider => {
    const start = Date.now();
    try { return { name: test.name, provider, pass: true, ...await test.run(provider), elapsedMs: Date.now() - start }; }
    catch (error) { return { name: test.name, provider, pass: false, error: error.message.slice(0, 300), elapsedMs: Date.now() - start }; }
  }));
  report.results.push(...results);
  for (const result of results) console.log(JSON.stringify(result));
}
await mkdir("validation", { recursive: true });
await writeFile(arg("--report", "validation/parity.json"), JSON.stringify(report, null, 2) + "\n");
const failures = report.results.filter(r => !r.pass);
console.log(JSON.stringify({ total: report.results.length, passed: report.results.length - failures.length, failed: failures.length }));
if (failures.length) process.exitCode = 1;
