import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/cache.mjs";
import { planImages } from "../src/image-budget.mjs";
import { createBridge } from "../src/bridge.mjs";

const image = raw => ({ raw, mime: "image/png", digest: sha256(raw) });
const slots = (...raws) => raws.map(raw => ({ image: image(raw) }));
const png = () => sharp({ create: { width: 800, height: 600, channels: 3, background: "#8a91ff" } }).png({ compressionLevel: 0 }).toBuffer();

test("under-budget requests retain original bytes without touching the encoder or cache", async () => {
  const items = slots(Buffer.from("not-decoded-under-budget"));
  const result = await planImages(items, { budget: 100, cacheGet: () => { throw Error("unexpected cache"); } });
  assert.equal(result.images, items);
  assert.equal(result.changed, 0);
});

test("lossless budgeting preserves pixels and every repeated image occurrence", async () => {
  const raw = await png(), original = slots(raw, raw, raw);
  const result = await planImages(original, { budget: raw.length });
  assert.equal(result.images.length, 3);
  assert.ok(result.bytes <= raw.length);
  assert.equal(result.bytes, result.images.reduce((n, x) => n + (x.image.bytes ?? x.image.raw.length), 0));
  for (const item of result.images) {
    assert.deepEqual(await sharp(item.image.raw).raw().toBuffer(), await sharp(raw).raw().toBuffer());
    const meta = await sharp(item.image.raw).metadata();
    assert.equal(meta.width, 800);
    assert.equal(meta.height, 600);
  }
  assert.ok(original.every(x => x.image.raw === raw));
});

test("historical downscaling precedes any resolution reduction of the newest four images", async () => {
  const pixels = Buffer.alloc(800 * 600 * 3);
  let state = 17;
  for (let i = 0; i < pixels.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) | 0; pixels[i] = state >>> 24; }
  const raw = await sharp(pixels, { raw: { width: 800, height: 600, channels: 3 } }).png().toBuffer();
  const budget = Math.floor(raw.length * 4.2);
  const result = await planImages(slots(...Array(8).fill(raw)), { budget });
  assert.ok(result.bytes <= budget);
  assert.equal(result.images.length, 8);
  assert.ok((await sharp(result.images[0].image.raw).metadata()).width < 800);
  for (const item of result.images.slice(-4)) assert.equal((await sharp(item.image.raw).metadata()).width, 800);
});

test("lossless compression retains alpha and RGB behind transparent pixels", async () => {
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 123; pixels[i + 1] = 45; pixels[i + 2] = 67; pixels[i + 3] = i % 8 ? 0 : 255; }
  const raw = await sharp(pixels, { raw: { width: 32, height: 32, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
  const result = await planImages(slots(raw, raw), { budget: raw.length });
  for (const item of result.images) assert.deepEqual(await sharp(item.image.raw).raw().toBuffer(), pixels);
});

test("variant metadata cache avoids re-encoding and survives stale-file recovery", async t => {
  const dir = await mkdtemp(join(tmpdir(), "budget-cache-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const raw = await png();
  let uploads = 0, inferences = 0, stale = false;
  const payload = JSON.stringify({ model: "deepseek-flash", input: [{ role: "user", content: Array.from({ length: 6 }, () => ({ type: "input_image", image_url: `data:image/png;base64,${raw.toString("base64")}` })) }] });
  const bridge = createBridge({ cacheDir: dir, imageBudgetBytes: raw.length * 2, getAuth: async () => ({ type: "api", key: "test-budget" }), fetchImpl: async (url, init) => {
    if (url.endsWith("/files")) { uploads++; return Response.json({ id: `file-api-${uploads}` }); }
    inferences++;
    const content = JSON.parse(init.body).input[0].content;
    assert.equal(content.length, 6);
    assert.ok(content.every(x => x.file_id && !x.image_url));
    if (stale) { stale = false; return Response.json({ error: { message: "file_id expired" } }, { status: 400 }); }
    return Response.json({ ok: true });
  } });
  const send = () => bridge("https://api.deepseek.com/responses", { method: "POST", body: payload });
  assert.equal((await send()).status, 200);
  const firstUploads = uploads;
  assert.equal((await send()).status, 200);
  assert.equal(uploads, firstUploads);
  stale = true;
  assert.equal((await send()).status, 200);
  assert.equal(uploads, firstUploads * 2);
  assert.equal(inferences, 4);
});

test("image-count limit keeps the newest 600 IDs and marks earlier positions", async () => {
  const bridge = createBridge({ cacheDir: ".unused", getAuth: async () => ({ type: "api", key: "test" }), fetchImpl: async (url, init) => {
    assert.ok(!url.endsWith("/files"));
    const parts = JSON.parse(init.body).input[0].content;
    assert.equal(parts[0].type, "input_text");
    assert.match(parts[0].text, /omitted/);
    assert.equal(parts.filter(x => x.type === "input_image").length, 600);
    return Response.json({ ok: true });
  } });
  const response = await bridge("https://api.deepseek.com/responses", { method: "POST", body: JSON.stringify({ input: [{ role: "user", content: Array.from({ length: 601 }, () => ({ type: "input_image", file_id: "file-api-existing" })) }] }) });
  assert.equal(response.status, 200);
});

test("upstream image-total rejection retries once with a lower budget, then stops", async t => {
  const dir = await mkdtemp(join(tmpdir(), "budget-retry-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const raw = await png();
  let inference = 0, uploads = 0;
  const bridge = createBridge({ cacheDir: dir, imageBudgetBytes: raw.length * 7, getAuth: async () => ({ type: "api", key: "test" }), fetchImpl: async url => {
    if (url.endsWith("/files")) return Response.json({ id: `file-api-${++uploads}` });
    inference++;
    return Response.json({ error: { message: "Total image size exceeds the limit: max 200 MB per request" } }, { status: 400 });
  } });
  const response = await bridge("https://api.deepseek.com/responses", { method: "POST", body: JSON.stringify({ input: [{ role: "user", content: Array.from({ length: 6 }, () => ({ type: "input_image", image_url: `data:image/png;base64,${raw.toString("base64")}` })) }] }) });
  assert.equal(response.status, 400);
  assert.equal(inference, 2);
  assert.equal(uploads, 1); // same file, fewer occurrences in the bounded retry
});

test("when compression cannot fit, oldest images are omitted before the newest", async () => {
  // Two-frame GIF: animations intentionally bypass transcoding.
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAIfkEAAAAAAAsAAAAAAEAAQAAAgJEAQA7", "base64");
  const result = await planImages(slots(gif, gif, gif), { budget: gif.length + 1 });
  assert.equal(result.images.length, 1);
  assert.equal(result.omitted.length, 2);
  assert.equal(result.bytes, gif.length);
});

test("persistent transform-size metadata avoids re-encoding unselected profiles", async t => {
  const dir = await mkdtemp(join(tmpdir(), "budget-sizes-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const { FileCache } = await import("../src/cache.mjs");
  const cache = new FileCache(dir), scope = sha256("scope"), raw = await png();
  const first = await planImages(slots(raw, raw, raw), { budget: raw.length, cacheGet: d => cache.getSize(scope, d), cachePut: (d, n) => cache.putSize(scope, d, n) });
  const second = await planImages(slots(raw, raw, raw), { budget: raw.length, cacheGet: d => cache.getSize(scope, d) });
  assert.equal(second.bytes, first.bytes);
  assert.ok(second.images.every(x => !x.image.raw && typeof x.image.materialize === "function"));
});
