// Opt-in local history replay. Only images are read; no prompts/tools are executed.
// Default is offline. --live uploads planned images and asks for one diagnostic word.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import sharp from "sharp";
import { planImages } from "../src/image-budget.mjs";
import { decodeImage, createBridge } from "../src/bridge.mjs";
import { FileCache, sha256 } from "../src/cache.mjs";

const index = process.argv.indexOf("--rollout");
if (index < 0) throw Error("Pass --rollout <local rollout.jsonl>; optional --live calls DeepSeek and incurs API usage.");
const images = [], seen = new Map();
function walk(value) {
  if (Array.isArray(value)) for (const item of value) walk(item);
  else if (value && typeof value === "object") {
    if (value.type === "input_image" && value.image_url?.startsWith("data:")) {
      const decoded = decodeImage(value.image_url);
      if (!seen.has(decoded.digest)) seen.set(decoded.digest, decoded);
      images.push({ image: seen.get(decoded.digest) });
    } else for (const item of Object.values(value)) if (item && typeof item === "object") walk(item);
  }
}
for await (const line of createInterface({ input: createReadStream(process.argv[index + 1]), crlfDelay: Infinity })) {
  if (!line) continue;
  const row = JSON.parse(line);
  if (row.type === "response_item") walk(row.payload);
}
const start = Date.now();
const live = process.argv.includes("--live");
const config = join(homedir(), ".config", "magpie");
const auth = live ? JSON.parse(await readFile(join(config, "plugin-auth.json"), "utf8"))["deepseek-files"] : null;
const cache = live ? new FileCache(join(config, "deepseek-files-cache")) : null;
const scope = auth ? sha256(`https://api.deepseek.com\0${auth.key}`) : null;
console.log(JSON.stringify({ event: "budget_start", images: images.length, bytes: images.reduce((n, x) => n + x.image.raw.length, 0) }));
const result = await planImages(images, { onMetric: console.log, cacheGet: cache ? async d => await cache.get(scope, d) ?? await cache.getSize(scope, d) : undefined, cachePut: cache ? (d, n) => cache.putSize(scope, d, n) : undefined });
let pixelExact = 0, resized = 0;
for (let i = 0; i < images.length; i++) {
  const original = images[i].image.raw, prepared = result.images[i].image.raw ?? (await result.images[i].image.materialize()).raw;
  if (original === prepared) { pixelExact++; continue; }
  const [a, b] = await Promise.all([sharp(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), sharp(prepared).ensureAlpha().raw().toBuffer({ resolveWithObject: true })]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) resized++;
  if (a.info.channels === b.info.channels && a.data.equals(b.data)) pixelExact++;
}
const report = { images: images.length, originalBytes: result.originalBytes, imageBytes: result.bytes, changed: result.changed, pixelExact, resized, elapsedMs: Date.now() - start };
if (live) {
  const bridge = createBridge({ getAuth: async () => auth, cacheDir: join(config, "deepseek-files-cache") });
  const content = [{ type: "input_text", text: "Transport test: reply only IMAGE_BUDGET_OK." }];
  for (const item of result.images) {
    if (!item.image.raw) Object.assign(item.image, await item.image.materialize());
    content.push({ type: "input_image", image_url: `data:${item.image.mime};base64,${item.image.raw.toString("base64")}` });
  }
  console.log(JSON.stringify({ event: "live_upload_start", images: images.length, bytes: result.bytes }));
  const response = await bridge("https://api.deepseek.com/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-flash", input: [{ role: "user", content }], reasoning: { effort: "none" }, max_output_tokens: 48 }), signal: AbortSignal.timeout(240000) });
  const data = await response.json();
  const answer = (data.output ?? []).flatMap(x => x.content ?? []).map(x => x.text ?? "").join("");
  report.live = { status: response.status, success: response.ok && answer.includes("IMAGE_BUDGET_OK"), usage: data.usage };
  if (!report.live.success) report.live.error = data.error?.message ?? "Missing diagnostic answer";
  for (const { image } of result.images) {
    const stored = await cache.get(scope, sha256(image.raw));
    if (stored) await cache.put(scope, image.digest, stored);
  }
}
await mkdir("validation", { recursive: true });
await writeFile("validation/image-budget.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (report.live && !report.live.success) process.exitCode = 1;
