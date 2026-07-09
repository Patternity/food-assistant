import type { LlmProvider } from "./provider.js";
import { OpenAiCompatibleProvider } from "./openai-provider.js";

// Provider registry. Selection is env-driven (LLM_PROVIDER) so a different
// backend can be wired in without touching business code. Add new providers
// here as they are implemented.
let cached: LlmProvider | null = null;

export function getProvider(): LlmProvider {
  if (cached) return cached;
  const id = process.env.LLM_PROVIDER || "openai-compatible";
  switch (id) {
    case "openai-compatible":
      cached = new OpenAiCompatibleProvider();
      break;
    // case "anthropic":  cached = new AnthropicProvider(); break;
    // case "local":      cached = new LocalProvider(); break;
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${id}`);
  }
  return cached;
}

export type { ChatMessage, ContentPart, LlmProvider } from "./provider.js";
