import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

export const sha256 = value => createHash("sha256").update(value).digest("hex");

export class FileCache {
  constructor(root, { now = Date.now } = {}) { this.root = root; this.now = now; }
  path(scope, digest) {
    if (!/^[a-f0-9]{64}$/.test(scope) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid cache identity");
    return join(this.root, scope, `${digest}.json`);
  }
  async get(scope, digest) {
    try {
      const entry = JSON.parse(await readFile(this.path(scope, digest), "utf8"));
      if (!/^file-api-[A-Za-z0-9_-]+$/.test(entry.id) || !(entry.expiresAt > this.now() + 120_000)) return null;
      return entry;
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code) || error instanceof SyntaxError) return null;
      throw new Error("Cannot read DeepSeek file cache; check its directory permissions");
    }
  }
  async put(scope, digest, entry) {
    const target = this.path(scope, digest), temp = `${target}.${randomUUID()}.tmp`;
    await mkdir(join(this.root, scope), { recursive: true, mode: 0o700 });
    try {
      // Cache metadata only: no API keys, image bytes, paths, prompts, or conversations.
      await writeFile(temp, JSON.stringify({ id: entry.id, expiresAt: entry.expiresAt, bytes: entry.bytes }), { mode: 0o600, flag: "wx" });
      await rename(temp, target);
    } finally { await unlink(temp).catch(() => {}); }
  }
  async remove(scope, digest) { await unlink(this.path(scope, digest)).catch(e => { if (e.code !== "ENOENT") throw e; }); }
}

export class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  async run(fn, signal) {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      waiter.abort = () => { this.queue = this.queue.filter(x => x !== waiter); reject(signal.reason); };
      if (this.active < this.limit) { this.active++; resolve(); }
      else { this.queue.push(waiter); signal?.addEventListener("abort", waiter.abort, { once: true }); }
    });
    try { signal?.throwIfAborted(); return await fn(); }
    finally {
      this.active--;
      while (this.queue.length && this.active < this.limit) {
        const waiter = this.queue.shift();
        waiter.signal?.removeEventListener("abort", waiter.abort);
        if (waiter.signal?.aborted) { waiter.reject(waiter.signal.reason); continue; }
        this.active++; waiter.resolve();
      }
    }
  }
}
