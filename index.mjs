import { join } from "node:path";
import { createBridge, API } from "./src/bridge.mjs";
import { configDirectory, importMagpieKey } from "./src/paths.mjs";

export const PROVIDER_ID = "deepseek-files";
export async function DeepSeekFilesPlugin() {
  return {
    auth: {
      provider: PROVIDER_ID,
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
    async config(config) {
      config.provider ??= {};
      const previous = config.provider[PROVIDER_ID] ?? {};
      config.provider[PROVIDER_ID] = {
        ...previous, name: "DeepSeek Files Bridge", npm: "@ai-sdk/openai", api: `${API}/v1`,
        models: { ...previous.models,
          "deepseek-flash": { name: "DeepSeek Flash · Files Bridge", attachment: true, reasoning: true, tool_call: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1000000, output: 393216 },
            cost: { input: 0.3, output: 1.2, cache_read: 0.006 } },
        },
      };
    },
  };
}
