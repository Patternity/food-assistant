// LLM provider abstraction.
//
// The prototype is provider-agnostic: business code depends only on this
// interface, never on a concrete SDK. Today only an OpenAI-compatible provider
// is implemented (works with OpenAI directly or via an aggregator/gateway).
// Additional providers (Anthropic, local models, other gateways) can be added
// by implementing LlmProvider and registering them in ./index.ts.

/** A piece of user content: plain text, or an image passed as a data URL. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  // string for text-only turns, or parts for multimodal (e.g. an uploaded image)
  content: string | ContentPart[];
};

export type CompleteOptions = {
  temperature?: number;
  json?: boolean;
};

export interface LlmProvider {
  /** Human-readable provider id, e.g. "openai-compatible". */
  readonly id: string;
  /** True when credentials are present and real calls can be made. */
  isConfigured(): boolean;
  /** Free-form text completion. */
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string>;
  /** JSON completion. Returns a parsed object (or {} on parse failure). */
  completeJSON<T = Record<string, unknown>>(
    messages: ChatMessage[],
    opts?: Omit<CompleteOptions, "json">
  ): Promise<T>;
}
