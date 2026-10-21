import { prepareInlineRequest, TransformCache } from "./opencode-inline.mjs";

const cache = new TransformCache();
const paths = { chat: "/chat/completions", responses: "/responses", anthropic: "/messages", gemini: "/generateContent" };

// Runs before routing. Only an explicitly selected built-in Go DeepSeek
// model is eligible; a routing group's eventual provider is not known here.
export async function onRequest(body, ctx) {
  if (!/^opencode-go\/deepseek[^/]*$/.test(ctx.model ?? "")) return;
  const path = paths[ctx.protocol];
  if (!path) return;
  const prepared = await prepareInlineRequest(JSON.stringify(body), path, {
    signal: ctx.signal, transformCache: cache,
  });
  return JSON.parse(prepared.payload);
}
