import OpenAI from "openai";
import type {
  ChatMessage,
  CompleteOptions,
  ContentPart,
  LlmProvider,
} from "./provider.js";

// OpenAI-compatible provider. Auto-connects to whatever LLM_BASE_URL points at,
// so it works with OpenAI directly or with any compatible aggregator/gateway.
// A placeholder key lets the server boot and serve the UI without credentials;
// real calls are gated by isConfigured() in the controller layer.

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = "openai-compatible";
  private client: OpenAI;
  private model: string;
  private visionModel: string;

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.LLM_API_KEY || "not-configured",
      baseURL: process.env.LLM_BASE_URL || undefined,
    });
    this.model = process.env.LLM_MODEL || "gpt-4o-mini";
    this.visionModel = process.env.LLM_VISION_MODEL || this.model;
  }

  isConfigured(): boolean {
    return Boolean(process.env.LLM_API_KEY);
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<string> {
    const hasImage = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image")
    );
    const res = await this.client.chat.completions.create({
      model: hasImage ? this.visionModel : this.model,
      temperature: opts.temperature ?? 0.5,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      messages: messages.map(toOpenAiMessage),
    });
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
