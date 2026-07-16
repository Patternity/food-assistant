import { settingsRepo } from "./store.js";

// LLM connection config (provider endpoint, model, key). The env values are
// DEFAULTS only; the effective config is stored in the settings table and
// editable at runtime via the admin API, so an operator can switch the model,
// gateway, or key from the bot's admin panel without redeploying.
//
// The API key is a secret: it is stored here but NEVER returned to a client.
// Reads go through llmPublicView(), which masks it; the admin form is
// write-only (an empty key in a patch leaves the stored one untouched).

const trimmed = (v: string | undefined): string => (v ?? "").trim();

// Env-provided defaults (used until an admin overrides them at runtime).
const DEFAULTS = {
  apiKey: trimmed(process.env.LLM_API_KEY),
  baseUrl: trimmed(process.env.LLM_BASE_URL),
  model: trimmed(process.env.LLM_MODEL) || "gpt-4o-mini",
  visionModel: trimmed(process.env.LLM_VISION_MODEL),
  maxTokens: Number(process.env.LLM_MAX_TOKENS) || 2048,
};

// Settings keys (persisted overrides of the env defaults).
const KEYS = {
  apiKey: "llm_api_key",
  baseUrl: "llm_base_url",
  model: "llm_model",
  visionModel: "llm_vision_model",
  maxTokens: "llm_max_tokens",
} as const;

export type LlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  visionModel: string;
  maxTokens: number;
};

/** Masked, client-safe view — never carries the raw API key. */
export type LlmPublicView = {
  apiKeySet: boolean;
  apiKeyHint: string; // "" or "…1234"
  baseUrl: string;
  model: string;
  visionModel: string;
  maxTokens: number;
};

/** Effective config: stored settings over env defaults. Read fresh each call. */
export function llmConfig(): LlmConfig {
  const s = settingsRepo.all();
  const model = trimmed(s[KEYS.model]) || DEFAULTS.model;
  const maxN = Number(s[KEYS.maxTokens]);
  return {
    apiKey: s[KEYS.apiKey] ?? DEFAULTS.apiKey,
    baseUrl: s[KEYS.baseUrl] ?? DEFAULTS.baseUrl,
    model,
    // Vision falls back to the text model when neither store nor env set it.
    visionModel: trimmed(s[KEYS.visionModel]) || DEFAULTS.visionModel || model,
    maxTokens: Number.isFinite(maxN) && maxN > 0 ? maxN : DEFAULTS.maxTokens,
  };
}

/** Mask the key: presence + last 4 chars only, never the secret itself. */
export function llmPublicView(): LlmPublicView {
  const c = llmConfig();
  const key = c.apiKey && c.apiKey !== "not-configured" ? c.apiKey : "";
  return {
    apiKeySet: Boolean(key),
    apiKeyHint: key.length >= 4 ? `…${key.slice(-4)}` : "",
    baseUrl: c.baseUrl,
    model: c.model,
    visionModel: c.visionModel,
    maxTokens: c.maxTokens,
  };
}

/**
 * Apply an admin patch to the LLM config (partial). String fields are written
 * when present; the API key is write-only (a blank/absent key is ignored so it
 * is never wiped by an empty form). Returns the new masked view.
 */
export function setLlmConfig(patch: Record<string, unknown>): LlmPublicView {
  // Write-only: only overwrite the key when a real value is provided.
  if (typeof patch.apiKey === "string" && patch.apiKey.trim()) {
    settingsRepo.set(KEYS.apiKey, patch.apiKey.trim());
  }
  // baseUrl may be cleared (empty -> back to the OpenAI default endpoint).
  if (typeof patch.baseUrl === "string") settingsRepo.set(KEYS.baseUrl, patch.baseUrl.trim());
  if (typeof patch.model === "string" && patch.model.trim()) {
    settingsRepo.set(KEYS.model, patch.model.trim());
  }
  if (typeof patch.visionModel === "string") settingsRepo.set(KEYS.visionModel, patch.visionModel.trim());
  if (patch.maxTokens !== undefined) {
    const n = Number(patch.maxTokens);
    if (Number.isFinite(n) && n > 0) settingsRepo.set(KEYS.maxTokens, String(Math.floor(n)));
  }
  return llmPublicView();
}
