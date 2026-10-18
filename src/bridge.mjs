import { FileCache, Semaphore, sha256 } from "./cache.mjs";

export const API = "https://api.deepseek.com";
export const MIB = 1024 * 1024;
const MIME = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const uploads = new Semaphore(4);
const inFlight = new Map();

export class BridgeError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
const failure = error => Response.json({ error: { type: "deepseek_files_bridge_error", message: error.message } }, { status: error.status ?? 502 });

function abortable(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(x => { cleanup(); resolve(x); }, e => { cleanup(); reject(e); });
  });
}

export function decodeImage(url) {
  if (!url.startsWith("data:")) return null;
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!match || match[2].length % 4 !== 0) throw new BridgeError("Malformed or unsupported inline image; no images were removed.", 400);
  if (match[2].length > Math.ceil(64 * MIB / 3) * 4) throw new BridgeError("Image exceeds DeepSeek Files API's 64 MiB limit.", 413);
  const raw = Buffer.from(match[2], "base64");
  if (!raw.length || raw.toString("base64") !== match[2]) throw new BridgeError("Invalid image Base64; no images were removed.", 400);
  return { raw, mime: match[1], digest: sha256(raw) };
}

export function imageParts(body, path) {
  const parts = [];
  if (path === "/responses" && Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue;
      const content = ["function_call_output", "custom_tool_call_output"].includes(item.type) ? item.output : item.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) if (part?.type === "input_image" && typeof part.image_url === "string")
        parts.push({ part, url: part.image_url, kind: "responses" });
    }
  } else if (path === "/chat/completions" && Array.isArray(body.messages)) {
    for (const item of body.messages) if (Array.isArray(item?.content)) {
      for (const part of item.content) {
        if (part?.type === "image_url" && typeof part.image_url?.url === "string") parts.push({ part, url: part.image_url.url, kind: "chat" });
        else if (part?.type === "file" && typeof part.file_data === "string") parts.push({ part, url: part.file_data, kind: "chat" });
      }
    }
  }
  return parts;
}

export function staleFileError(status, error) {
  if (![400, 404, 410, 422].includes(status)) return false;
  const text = `${error?.error?.message ?? ""} ${error?.error?.code ?? ""}`.toLowerCase();
  return /file[_ -]?(?:id|api)|uploaded file/.test(text) && /expired|not found|not_found|does not exist|invalid file|deleted/.test(text);
}

export function createBridge({ getAuth, cacheDir, fetchImpl = globalThis.fetch, now = Date.now, onMetric = () => {}, ttlSeconds = 604800, uploadTimeoutMs = 120000 }) {
  const cache = new FileCache(cacheDir, { now });
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 3600 || ttlSeconds > 2592000) throw new Error("File lifetime must be 1 hour to 30 days");

  async function upload(key, scope, image, signal) {
    const stored = await cache.get(scope, image.digest);
    if (stored) { onMetric({ event: "cache_hit" }); return stored.id; }
    const identity = `${scope}/${image.digest}`;
    let pending = inFlight.get(identity);
    if (pending?.controller.signal.aborted) pending = undefined;
    if (!pending) {
      const controller = new AbortController();
      pending = { controller, users: 0 };
      pending.promise = uploads.run(async () => {
        const hit = await cache.get(scope, image.digest);
        if (hit) return hit.id;
        const form = new FormData();
        form.set("purpose", "user_data");
        form.set("expires_after[anchor]", "created_at");
        form.set("expires_after[seconds]", String(ttlSeconds));
        form.set("file", new Blob([image.raw], { type: image.mime }), `${image.digest.slice(0, 24)}.${MIME[image.mime]}`);
        const uploadSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(uploadTimeoutMs)]);
        const response = await fetchImpl(`${API}/files`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: uploadSignal, redirect: "error" });
        if (!response.ok) {
          await response.body?.cancel();
          throw new BridgeError(`DeepSeek Files upload returned HTTP ${response.status}; no images were removed.`, response.status >= 400 && response.status < 600 ? response.status : 502);
        }
        let data;
        try { data = await response.json(); } catch { throw new BridgeError("DeepSeek Files returned an invalid upload response."); }
        if (!/^file-api-[A-Za-z0-9_-]+$/.test(data?.id)) throw new BridgeError("DeepSeek Files returned an invalid file ID.");
        const expiresAt = Math.min(Number(data.expires_at ?? now()/1000+ttlSeconds)*1000, now()+ttlSeconds*1000);
        if (!Number.isFinite(expiresAt) || expiresAt <= now()+120000) throw new BridgeError("DeepSeek Files returned an invalid expiration.");
        await cache.put(scope, image.digest, { id: data.id, expiresAt, bytes: image.raw.length });
        onMetric({ event: "uploaded", bytes: image.raw.length });
        return data.id;
      }, controller.signal).finally(() => { if (inFlight.get(identity) === pending) inFlight.delete(identity); });
      // A disconnected caller must not leave an unhandled rejection.
      pending.promise.catch(() => {});
      inFlight.set(identity, pending);
    }
    pending.users++;
    try { return await abortable(pending.promise, signal); }
    finally { if (--pending.users === 0) pending.controller.abort(); }
  }

  async function transform(original, path, key, signal) {
    let body;
    try { body = JSON.parse(original); } catch { throw new BridgeError("Expected a JSON request body.", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeError("Expected a JSON object.", 400);
    const images = imageParts(body, path).map(item => ({ ...item, image: decodeImage(item.url) })).filter(item => item.image);
    if (!images.length) return { payload: original, digests: [], scope: null };
    const scope = sha256(`${API}\0${key}`);
    const unique = [...new Map(images.map(item => [item.image.digest, item.image])).values()];
    const group = new AbortController();
    const groupSignal = signal ? AbortSignal.any([signal, group.signal]) : group.signal;
    let pairs;
    try { pairs = await Promise.all(unique.map(async image => [image.digest, await upload(key, scope, image, groupSignal)])); }
    finally { group.abort(); }
    signal?.throwIfAborted();
    const ids = new Map(pairs);
    for (const { part, kind, image } of images) {
      if (kind === "responses") { delete part.image_url; delete part.detail; part.file_id = ids.get(image.digest); }
      else { for (const key of Object.keys(part)) delete part[key]; part.type = "file"; part.file_id = ids.get(image.digest); }
    }
    const payload = JSON.stringify(body), size = Buffer.byteLength(payload);
    if (size >= 48 * MIB) throw new BridgeError("Text/tool history still exceeds DeepSeek's 48 MiB request limit after image references; compact the conversation.", 413);
    onMetric({ event: "prepared", beforeBytes: Buffer.byteLength(original), afterBytes: size, images: images.length, uniqueImages: unique.length });
    return { payload, digests: unique.map(x => x.digest), scope };
  }

  return async function bridgeFetch(input, init = {}) {
    const request = input instanceof Request ? input : null;
    const signal = init.signal ?? request?.signal;
    signal?.throwIfAborted();
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== API || url.username || url.password) return failure(new BridgeError("This provider sends credentials only to api.deepseek.com.", 400));
    const path = url.pathname.replace(/^\/v1(?=\/)/, "");
    if (!["/responses", "/chat/completions", "/models", "/user/balance"].includes(path)) return failure(new BridgeError("Unsupported DeepSeek endpoint.", 404));
    const auth = await getAuth();
    if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key) return failure(new BridgeError("Sign in to DeepSeek Files Bridge with a DeepSeek API key.", 401));
    const headers = new Headers(init.headers ?? request?.headers);
    headers.set("authorization", `Bearer ${auth.key}`);
    for (const name of ["content-length", "host", "cookie", "proxy-authorization"]) headers.delete(name);
    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    const raw = init.body ?? (request && !["GET", "HEAD"].includes(method) ? await request.clone().text() : undefined);
    const original = typeof raw === "string" ? raw : raw == null ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(raw);
    try {
      let converted = original !== undefined && ["/responses", "/chat/completions"].includes(path)
        ? await transform(original, path, auth.key, signal) : { payload: original, digests: [] };
      for (let attempt = 0; attempt < 2; attempt++) {
        signal?.throwIfAborted();
        const response = await fetchImpl(`${API}${path}${url.search}`, { ...init, method, headers, body: converted.payload, signal, redirect: "error" });
        if (attempt === 0 && converted.digests.length && [400, 404, 410, 422].includes(response.status)) {
          let error;
          try { error = await response.clone().json(); } catch {}
          if (staleFileError(response.status, error)) {
            await response.body?.cancel();
            await Promise.all(converted.digests.map(digest => cache.remove(converted.scope, digest)));
            onMetric({ event: "refresh_stale", files: converted.digests.length });
            converted = await transform(original, path, auth.key, signal);
            continue;
          }
        }
        // Streaming is passed through untouched. Never replay after inference has started.
        return response;
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof BridgeError) return failure(error);
      return failure(new BridgeError("DeepSeek file preparation failed or timed out; original images were retained. Check network/cache permissions."));
    }
  };
}
