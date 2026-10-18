import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createBridge, API } from "./src/bridge.mjs";
import { configDirectory, importMagpieKey, manualModelIDs } from "./src/paths.mjs";
import { DEFAULT_MODELS, discoverModels, readBalance } from "./src/models.mjs";
import { nativeCatalog, runtimeCost } from "./src/catalog.mjs";

export const PROVIDER_ID = "deepseek-files";
const icon = "data:image/svg+xml;base64," + readFileSync(new URL("./assets/deepseek.svg", import.meta.url)).toString("base64");
export async function DeepSeekFilesPlugin(input = {}) {
  // Magpie passes its real settings directory, including portable installations.
  const directory = process.env.MAGPIE_CONFIG_DIR || (input.magpie && typeof input.directory === "string" ? input.directory : configDirectory());
  let configuredModels = {};
  return {
    auth: {
      provider: PROVIDER_ID,
      icon,
      async usage(getAuth) { return readBalance(getAuth); },
      methods: [
        { type: "api", label: "DeepSeek API key", placeholder: "sk-…" },
        { type: "oauth", label: "Import existing Magpie DeepSeek API key", async authorize() {
          const key = await importMagpieKey(directory);
          return { url: "", method: "auto", instructions: "Importing your existing official DeepSeek key locally. It will not be printed.",
            callback: async () => ({ type: "success", key }) };
        } },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api" || !auth.key) return {};
        return { baseURL: `${API}/v1`, apiKey: auth.key,
          fetch: createBridge({ getAuth, cacheDir: process.env.DEEPSEEK_FILES_CACHE_DIR || join(directory, "deepseek-files-cache") }) };
      },
    },
    provider: { id: PROVIDER_ID, async models(provider, context) {
      const manual = Object.fromEntries((await manualModelIDs(directory, PROVIDER_ID)).map(id => [id, {}]));
      return discoverModels(provider, { ...context, catalog: await nativeCatalog(directory), manualModels: { ...manual, ...configuredModels } });
    } },
    async config(config) {
      const maker = await nativeCatalog(directory), models = structuredClone(DEFAULT_MODELS);
      for (const [id, model] of Object.entries(models)) if (runtimeCost(maker[id]?.cost)) model.cost = maker[id].cost;
      config.provider ??= {};
      const previous = config.provider[PROVIDER_ID] ?? {};
      configuredModels = previous.models ?? {};
      config.provider[PROVIDER_ID] = {
        ...previous, name: "DeepSeek Files Bridge", npm: "@ai-sdk/openai", api: `${API}/v1`, searches: true,
        models: { ...models, ...previous.models },
      };
    },
  };
}
