import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createBridge, API } from "./src/bridge.mjs";
import { configDirectory, importMagpieKey } from "./src/paths.mjs";
import { DEFAULT_MODELS, discoverModels, readBalance } from "./src/models.mjs";

export const PROVIDER_ID = "deepseek-files";
const icon = "data:image/svg+xml;base64," + readFileSync(new URL("./assets/deepseek.svg", import.meta.url)).toString("base64");
export async function DeepSeekFilesPlugin() {
  return {
    auth: {
      provider: PROVIDER_ID,
      icon,
      async usage(getAuth) { return readBalance(getAuth); },
      methods: [
        { type: "api", label: "DeepSeek API key", placeholder: "sk-…" },
        { type: "oauth", label: "Import existing Magpie DeepSeek API key", async authorize() {
          const key = await importMagpieKey();
          return { url: "", method: "auto", instructions: "Importing your existing official DeepSeek key locally. It will not be printed.",
            callback: async () => ({ type: "success", key }) };
        } },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api" || !auth.key) return {};
        return { baseURL: `${API}/v1`, apiKey: auth.key,
          fetch: createBridge({ getAuth, cacheDir: process.env.DEEPSEEK_FILES_CACHE_DIR || join(configDirectory(), "deepseek-files-cache") }) };
      },
    },
    provider: { id: PROVIDER_ID, models: discoverModels },
    async config(config) {
      config.provider ??= {};
      const previous = config.provider[PROVIDER_ID] ?? {};
      config.provider[PROVIDER_ID] = {
        ...previous, name: "DeepSeek Files Bridge", npm: "@ai-sdk/openai", api: `${API}/v1`,
        models: { ...structuredClone(DEFAULT_MODELS), ...previous.models },
      };
    },
  };
}
