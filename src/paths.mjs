import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { API } from "./bridge.mjs";

export const configDirectory = () => process.env.MAGPIE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie");

export async function manualModelIDs(directory, providerID) {
  let provider;
  try {
    const saved = JSON.parse(await readFile(join(directory, "providers.json"), "utf8"));
    provider = saved.providers?.find(p => p.id === providerID);
  } catch { return []; }
  const filename = join(directory, "deepseek-files-manual-models.json");
  let kept = [];
  try { const data = JSON.parse(await readFile(filename, "utf8")); if (Array.isArray(data[providerID])) kept = data[providerID]; } catch {}
  const ids = (provider?.models ?? []).filter(id => typeof id === "string" && id && (kept.includes(id) || !(provider.pickedFrom ?? []).includes(id)));
  // A refresh writes the complete plugin list into pickedFrom. Keep the user's
  // manual declarations separately so the next refresh doesn't forget them.
  if (JSON.stringify(ids) !== JSON.stringify(kept)) {
    const temp = `${filename}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify({ [providerID]: ids }) + "\n", { mode: 0o600 }); await rename(temp, filename); }
    finally { await rm(temp, { force: true }); }
  }
  return ids;
}

export async function importMagpieKey(directory = configDirectory()) {
  let saved;
  try { saved = JSON.parse(await readFile(join(directory, "providers.json"), "utf8")); }
  catch { throw new Error("Cannot read Magpie providers.json. Sign in using the API key method instead."); }
  const provider = saved.providers?.find(p => p.id === "deepseek");
  const endpoints = [provider?.chat, provider?.responses, provider?.anthropic].filter(Boolean);
  if (!provider || !endpoints.length || !endpoints.every(x => {
    try { return new URL(x).origin === API; } catch { return false; }
  })) throw new Error("Import requires an existing official api.deepseek.com provider named deepseek.");
  const selected = provider.keys?.find(k => typeof k === "string" || !k.off);
  const key = provider.key || (typeof selected === "string" ? selected : selected?.key);
  if (typeof key !== "string" || !key) throw new Error("No DeepSeek API key found. Use the API key method instead.");
  return key;
}
