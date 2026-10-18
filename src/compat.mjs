// The native gateway recognizes these fixes by api.deepseek.com. A plugin's
// plugin:// address bypasses that test, so keep the same narrow corrections here.
export function unicodeNullEscape(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c !== "\\" || i + 1 === pattern.length) { out += c; continue; }
    const next = pattern[++i];
    out += next === "0" && !/[0-9]/.test(pattern[i + 1] ?? "") ? "\\u0000" : `\\${next}`;
  }
  return out;
}

export function fitDeepSeekRequest(body, path) {
  let changed = false;
  const maps = new Set(["properties", "$defs", "definitions", "dependentSchemas", "patternProperties"]);
  const nested = new Set(["items", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "allOf", "anyOf", "oneOf", "prefixItems", "unevaluatedProperties", "unevaluatedItems", "contentSchema"]);
  function schema(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(schema); return; }
    if (typeof node.pattern === "string") {
      const fixed = unicodeNullEscape(node.pattern);
      if (fixed !== node.pattern) { node.pattern = fixed; changed = true; }
    }
    for (const [key, value] of Object.entries(node)) {
      if (maps.has(key) && value && typeof value === "object") Object.values(value).forEach(schema);
      else if (nested.has(key)) schema(value);
    }
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) {
    schema(tool?.parameters);
    schema(tool?.input_schema);
    schema(tool?.function?.parameters);
  }
  if (path === "/chat/completions" || path === "/beta/chat/completions") {
    if (body.max_tokens === undefined && body.max_completion_tokens !== undefined) {
      body.max_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
      changed = true;
    }
    if (body.reasoning_effort === "none" && body.thinking === undefined) {
      body.thinking = { type: "disabled" };
      delete body.reasoning_effort;
      changed = true;
    }
  }
  return changed;
}
