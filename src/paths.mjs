import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { API } from "./bridge.mjs";

export const configDirectory = () => process.env.MAGPIE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie");

export async function importMagpieKey(directory = configDirectory()) {
  let saved;
  try { saved = JSON.parse(await readFile(join(directory, "providers.json"), "utf8")); }
  catch { throw new Error("Cannot read Magpie providers.json. Sign in using the API key method instead."); }
  const provider = saved.providers?.find(p => p.id === "deepseek");
  const endpoints = [provider?.chat, provider?.responses].filter(Boolean);
  if (!provider || !endpoints.length || !endpoints.every(x => {
    try { return new URL(x).origin === API; } catch { return false; }
  })) throw new Error("Import requires an existing official api.deepseek.com provider named deepseek.");
  const selected = provider.keys?.find(k => typeof k === "string" || !k.off);
  const key = provider.key || (typeof selected === "string" ? selected : selected?.key);
  if (typeof key !== "string" || !key) throw new Error("No DeepSeek API key found. Use the API key method instead.");
  return key;
}
