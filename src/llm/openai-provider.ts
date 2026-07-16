import OpenAI from "openai";
import { addUsage } from "../usage.js";
import { llmConfig } from "../llm-config.js";
import type {
  ChatMessage,
  CompleteOptions,
  ContentPart,
  LlmProvider,
} from "./provider.js";

// OpenAI-compatible provider. Auto-connects to whatever base URL the config
// points at, so it works with OpenAI directly or with any compatible gateway.
// Config is read fresh from llmConfig() (env defaults + runtime admin overrides)
// so a key/model/endpoint change from the admin panel takes effect without a
// restart; the OpenAI client is rebuilt only when the key or base URL changes.

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = "openai-compatible";
  private client: OpenAI | null = null;
  private signature = "";

  /** Reuse the client while the key/base URL are unchanged; rebuild otherwise. */
  private clientFor(apiKey: string, baseUrl: string): OpenAI {
    const signature = `${apiKey}\n${baseUrl}`;
    if (!this.client || signature !== this.signature) {
      this.client = new OpenAI({ apiKey: apiKey || "not-configured", baseURL: baseUrl || undefined });
      this.signature = signature;
    }
    return this.client;
  }

  isConfigured(): boolean {
    return Boolean(llmConfig().apiKey);
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<string> {
    const cfg = llmConfig();
    const client = this.clientFor(cfg.apiKey, cfg.baseUrl);
    const hasImage = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image")
    );
    const res = await client.chat.completions.create({
      model: hasImage ? cfg.visionModel : cfg.model,
      temperature: opts.temperature ?? 0.5,
      // Cap output tokens. Our responses are short JSON; without a cap the model's
      // full default (e.g. 16384) is requested, which some gateways reject up
      // front for lack of credit.
      max_tokens: cfg.maxTokens,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      messages: messages.map(toOpenAiMessage),
    });
    // Charge the request's token budget (prompt + completion). Summed across all
    // LLM calls in the request by the usage scope; harmless outside one.
    addUsage(res.usage?.total_tokens ?? 0);
    return res.choices[0]?.message?.content?.trim() ?? "";
  }

  async completeJSON<T = Record<string, unknown>>(
    messages: ChatMessage[],
    opts: Omit<CompleteOptions, "json"> = {}
  ): Promise<T> {
    const raw = await this.complete(messages, { ...opts, json: true });
    try {
      return JSON.parse(raw || "{}") as T;
    } catch {
      return {} as T;
    }
  }
}

// Map our provider-neutral messages to the OpenAI chat format.
function toOpenAiMessage(m: ChatMessage): any {
  if (typeof m.content === "string") {
    return { role: m.role, content: m.content };
  }
  return { role: m.role, content: m.content.map(toOpenAiPart) };
}

function toOpenAiPart(p: ContentPart): any {
  if (p.type === "text") return { type: "text", text: p.text };
  return { type: "image_url", image_url: { url: p.dataUrl } };
}
