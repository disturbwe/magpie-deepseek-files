import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

let cached;
export async function readMakerCatalog(filename = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "magpie", "models.json")) {
  try {
    const info = await stat(filename);
    if (cached?.filename === filename && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.models;
    const data = JSON.parse(await readFile(filename, "utf8"));
    const models = data.deepseek?.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) return {};
    cached = { filename, mtimeMs: info.mtimeMs, size: info.size, models };
    return models;
  } catch { return {}; }
}

export async function nativeCatalog(directory) {
  const filenames = [
    ...(directory ? [join(directory, "cache", "models.json")] : []),
    join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "magpie", "models.json"),
    join(homedir(), ".cache", "opencode", "models.json"),
  ];
  for (const filename of filenames) {
    const models = await readMakerCatalog(filename);
    if (Object.keys(models).length) return models;
  }
  return {};
}

export function runtimeCost(cost) {
  if (!cost || ![cost.input, cost.output].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) return undefined;
  return { input: cost.input, output: cost.output,
    cache: { read: Number.isFinite(cost.cache_read) ? cost.cache_read : 0, write: Number.isFinite(cost.cache_write) ? cost.cache_write : 0 } };
}
