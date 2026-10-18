import { API } from "./bridge.mjs";
import { readMakerCatalog, runtimeCost } from "./catalog.mjs";

// Offline bootstrap only. Once signed in, /models is the source of truth.
// Prices are USD / million tokens, official peak-price snapshot 2026-10-18.
export const DEFAULT_MODELS = {
  "deepseek-flash": {
    name: "DeepSeek-V4.1-Flash", attachment: true, reasoning: true, tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1048576, output: 393216 },
    cost: { input: 0.3, output: 1.2, cache_read: 0.006 },
  },
  "deepseek-v4-pro": {
    name: "DeepSeek-V4-Pro", attachment: false, reasoning: true, tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 1048576, output: 393216 },
    cost: { input: 1.32, output: 3.96, cache_read: 0.044 },
  },
};
for (const model of Object.values(DEFAULT_MODELS)) {
  model.variants = Object.fromEntries(["none", "low", "high", "max"].map(level => [level, { reasoningEffort: level }]));
}

async function officialJSON(path, auth, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      headers: { authorization: `Bearer ${auth.key}`, accept: "application/json" },
      signal: AbortSignal.timeout(20000), redirect: "error",
    });
  } catch {
    throw new Error(`DeepSeek ${path} could not be reached; keeping the previous list and settings.`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`DeepSeek ${path} returned HTTP ${response.status}.`);
    if (response.status === 401) error.signIn = "expired";
    throw error;
  }
  try { return await response.json(); }
  catch { throw new Error(`DeepSeek ${path} returned invalid JSON.`); }
}

const positive = value => Number.isSafeInteger(value) && value > 0;
const kinds = list => Object.fromEntries(["text", "image", "audio", "video", "pdf"].map(kind => [kind, list.includes(kind)]));

export async function discoverModels(provider, { auth, catalog, manualModels = {} } = {}, fetchImpl = globalThis.fetch) {
  if (auth?.type !== "api" || !auth.key) return provider.models;
  const data = await officialJSON("/models", auth, fetchImpl);
  if (!Array.isArray(data?.data) || data.data.some(m => !m || typeof m.id !== "string" || !m.id.trim()))
    throw new Error("DeepSeek /models returned an invalid model list.");
  const maker = catalog ?? await readMakerCatalog();
  const officialIDs = new Set(data.data.map(model => model.id));
  const manual = Object.entries(manualModels).filter(([id]) => !officialIDs.has(id)).map(([id, config]) => {
    const known = maker[id];
    return { id, name: config?.name ?? provider.models?.[id]?.name ?? known?.name ?? id,
      context_window: known?.limit?.context, max_output_tokens: known?.limit?.output,
      input_modalities: known?.modalities?.input, output_modalities: known?.modalities?.output,
      ...(known?.reasoning ? { effort: { supported_levels: ["low", "high", "max"] } } : {}) };
  });
  return Object.fromEntries([...data.data, ...manual].map(model => {
    const id = model.id, old = provider.models?.[id] ?? {}, fallback = DEFAULT_MODELS[id];
    const inputs = model.input_modalities ?? fallback?.modalities.input ?? ["text"];
    const outputs = model.output_modalities ?? fallback?.modalities.output ?? ["text"];
    const levels = model.effort?.supported_levels ?? Object.keys(old.variants ?? fallback?.variants ?? {}).filter(x => x !== "none");
    if (!Array.isArray(inputs) || !Array.isArray(outputs) || !Array.isArray(levels) ||
        [...inputs, ...outputs, ...levels].some(x => typeof x !== "string"))
      throw new Error("DeepSeek /models returned invalid capabilities.");
    const cost = runtimeCost(maker[id]?.cost) ?? old.cost ?? runtimeCost(fallback?.cost);
    return [id, {
      ...old, id, providerID: provider.id,
      name: typeof model.name === "string" && model.name ? model.name : old.name ?? id,
      api: { ...old.api, id, url: provider.api, npm: provider.npm },
      limit: { ...(old.limit ?? {}),
        context: positive(model.context_window) ? model.context_window : old.limit?.context ?? fallback?.limit.context ?? 0,
        output: positive(model.max_output_tokens) ? model.max_output_tokens : old.limit?.output ?? fallback?.limit.output ?? 0 },
      ...(cost ? { cost } : {}),
      capabilities: { ...(old.capabilities ?? {}), temperature: true, toolcall: true,
        reasoning: levels.length > 0, attachment: inputs.includes("image"), input: kinds(inputs), output: kinds(outputs) },
      variants: Object.fromEntries((levels.length ? [...new Set(["none", ...levels])] : []).map(level => [level, { reasoningEffort: level }])),
    }];
  }));
}

export async function readBalance(getAuth, fetchImpl = globalThis.fetch) {
  const auth = await getAuth();
  if (auth?.type !== "api" || !auth.key) throw new Error("Sign in with a DeepSeek API key.");
  let data;
  try { data = await officialJSON("/user/balance", auth, fetchImpl); }
  catch (error) {
    // Magpie's usage RPC only carries signIn on the returned value, not errors.
    return { error: error.message, ...(error.signIn ? { signIn: error.signIn } : {}) };
  }
  if (!Array.isArray(data?.balance_infos) || !data.balance_infos.length)
    throw new Error("DeepSeek /user/balance returned an invalid balance.");
  const money = (currency, amount) => `${({ CNY: "¥", USD: "$" })[currency] ?? `${currency} `}${Number(amount).toFixed(2)}`;
  const amounts = data.balance_infos.map(item => {
    const amount = item.total_balance;
    if (!["string", "number"].includes(typeof amount) || String(amount).trim() === "" || !Number.isFinite(Number(amount)) || typeof item.currency !== "string")
      throw new Error("DeepSeek /user/balance returned an invalid amount.");
    return { ...item, currency: item.currency.toUpperCase(), total: Number(amount) };
  }).sort((a, b) => Number(b.total > 0) - Number(a.total > 0) || a.currency.localeCompare(b.currency));
  const windows = [];
  for (const item of amounts) {
    const granted = item.granted_balance, topped = item.topped_up_balance;
    if (granted != null && topped != null && Number.isFinite(Number(granted)) && Number.isFinite(Number(topped)) && Number(granted) !== 0)
      windows.push({ name: `${item.currency} balance details`, used: 0, aside: true,
        display: `Granted ${money(item.currency, granted)} · Topped up ${money(item.currency, topped)}` });
  }
  if (data.is_available === false || amounts.every(item => item.total <= 0))
    windows.push({ name: "Balance", used: 100, display: "Insufficient balance" });
  return { balance: amounts.map(item => money(item.currency, item.total)).join(" · "), signIn: "kept", ...(windows.length ? { windows } : {}) };
}
