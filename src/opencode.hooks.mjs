import { prepareInlineRequest, TransformCache } from "./opencode-inline.mjs";

const cache = new TransformCache();
const paths = { chat: "/chat/completions", responses: "/responses", anthropic: "/messages", gemini: "/generateContent" };

// Runs before routing, so budget group requests before ANY candidate is
// selected. This also covers nested groups and provider failover without
// copying the host's routing rules or reading private provider settings.
export async function onRequest(body, ctx) {
  const model = ctx.model ?? "";
  if (!/^opencode-go\/deepseek[^/]*$/.test(model) && !/^(?:group|auto)\/.+/.test(model)) return;
  const path = paths[ctx.protocol];
  if (!path) return;
  const prepared = await prepareInlineRequest(JSON.stringify(body), path, {
    signal: ctx.signal, transformCache: cache,
  });
  return JSON.parse(prepared.payload);
}
