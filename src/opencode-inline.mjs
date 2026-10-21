import { decodeImage, imageParts } from "./bridge.mjs";
import { planImages } from "./image-budget.mjs";
import { sha256 } from "./cache.mjs";

// Local safety policy, not a claimed OpenCode service limit. Leave room for
// text/tool history and Base64 expansion; bound the FINAL serialized body too.
export const GO_REQUEST_BUDGET = 16 * 1024 * 1024;
export const GO_IMAGE_BUDGET = 8 * 1024 * 1024;
export const GO_IMAGE_COUNT = 128;
const OMITTED = "[Earlier image omitted from this request to fit the OpenCode image budget; original retained in local history. Do not infer its contents; reopen the image if needed.]";

export class TransformCache {
  constructor(limit = 32 * 1024 * 1024) { this.limit = limit; this.bytes = 0; this.items = new Map(); }
  get(key) {
    const value = this.items.get(key);
    if (value) { this.items.delete(key); this.items.set(key, value); }
    return value;
  }
  set(key, value) {
    if (value.raw.length > this.limit) return;
    if (this.items.has(key)) this.bytes -= this.items.get(key).raw.length;
    this.items.delete(key); this.items.set(key, value); this.bytes += value.raw.length;
    while (this.bytes > this.limit) {
      const oldest = this.items.keys().next().value;
      this.bytes -= this.items.get(oldest).raw.length; this.items.delete(oldest);
    }
  }
}

function omit({ part, kind }) {
  for (const key of Object.keys(part)) delete part[key];
  if (kind !== "gemini") part.type = kind === "responses" ? "input_text" : "text";
  part.text = OMITTED;
}

function partsOf(body, path) {
  if (path === "/messages") {
    const images = [];
    const visit = content => {
      if (!Array.isArray(content)) return;
      for (const part of content) {
        if (part?.type === "image" && part.source?.type === "base64")
          images.push({ part, kind: "anthropic", url: `data:${part.source.media_type};base64,${part.source.data}` });
        else if (part?.type === "image" && part.source?.type === "url")
          images.push({ part, kind: "anthropic", url: part.source.url });
        else if (part?.type === "tool_result") visit(part.content);
      }
    };
    for (const message of body.messages ?? []) visit(message.content);
    return images;
  }
  if (path === "/generateContent") {
    const images = [];
    for (const content of body.contents ?? []) for (const part of content.parts ?? []) {
      const data = part.inlineData ?? part.inline_data;
      const mime = data?.mimeType ?? data?.mime_type;
      if (typeof mime === "string" && mime.startsWith("image/"))
        images.push({ part, kind: "gemini", url: `data:${mime};base64,${data.data}`, field: part.inlineData ? "inlineData" : "inline_data", mimeField: data.mimeType ? "mimeType" : "mime_type" });
    }
    return images;
  }
  return imageParts(body, path);
}

export async function prepareInlineRequest(original, path, {
  signal, imageBudget = GO_IMAGE_BUDGET, requestBudget = GO_REQUEST_BUDGET,
  maxImages = GO_IMAGE_COUNT, transformCache, onMetric = () => {},
} = {}) {
  signal?.throwIfAborted();
  const body = JSON.parse(original);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object.");
  if (!Number.isSafeInteger(maxImages) || maxImages < 1) throw new Error("Invalid image count budget.");
  const all = partsOf(body, path);
  const overCount = all.slice(0, Math.max(0, all.length - maxImages));
  overCount.forEach(omit);
  const retained = all.slice(overCount.length);
  const decoded = new Map();
  const inline = retained.map(item => {
    if (!item.url?.startsWith("data:")) return null;
    if (!decoded.has(item.url)) decoded.set(item.url, decodeImage(item.url));
    return { ...item, image: decoded.get(item.url) };
  }).filter(item => item?.image);
  const overhead = Buffer.byteLength(JSON.stringify(body)) - inline.reduce((sum, item) => sum + Buffer.byteLength(item.url), 0);
  const available = Math.floor((requestBudget - overhead - 4096) * 3 / 4);
  if (inline.length && available <= 0) {
    const error = new Error("Text/tool history exceeds the protected OpenCode request budget. Compact the conversation.");
    error.status = 413; throw error;
  }
  const plan = await planImages(inline, { budget: Math.min(imageBudget, Math.max(1, available)), signal, transformCache, onMetric });
  plan.omitted.forEach(omit);
  for (const item of plan.images) {
    const { part, kind, image } = item;
    const encoded = image.raw ? image : await image.materialize(signal);
    const url = `data:${encoded.mime};base64,${encoded.raw.toString("base64")}`;
    if (kind === "anthropic") part.source = { type: "base64", media_type: encoded.mime, data: encoded.raw.toString("base64") };
    else if (kind === "gemini") part[item.field] = { [item.mimeField]: encoded.mime, data: encoded.raw.toString("base64") };
    else if (kind === "responses") part.image_url = url;
    else if (part.type === "file") part.file_data = url;
    else part.image_url.url = url;
  }
  // Text, tool schemas, URL images and file references also occupy wire bytes.
  // Never silently truncate text or disturb tool-call/result pairs.
  let payload = JSON.stringify(body), omitted = overCount.length + plan.omitted.length;
  const active = retained.filter(({ part }) => part.type === "input_image" || part.type === "image_url" || part.type === "file" || part.type === "image" || part.inlineData || part.inline_data);
  while (Buffer.byteLength(payload) > requestBudget && active.length > 1) {
    omit(active.shift()); omitted++; payload = JSON.stringify(body);
  }
  const bytes = Buffer.byteLength(payload);
  if (bytes > requestBudget) {
    const error = new Error("Text/tool history or the newest image exceeds the protected OpenCode request budget. Compact the conversation or reduce the latest attachment.");
    error.status = 413; throw error;
  }
  const metric = { event: "opencode_prepared", beforeBytes: Buffer.byteLength(original), afterBytes: bytes,
    images: all.length - omitted, changed: plan.changed, omitted };
  onMetric(metric);
  return { payload, ...metric };
}
