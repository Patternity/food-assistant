import { AsyncLocalStorage } from "node:async_hooks";

// Per-request token accounting. One HTTP request may make several LLM calls
// (e.g. /api/message = classify + a dispatched primitive). We sum the usage of
// all of them so the caller can charge the session/day budget once. Using
// AsyncLocalStorage keeps this correct under concurrent requests — each request
// runs in its own store, and the provider adds to whichever store is current.

type Accumulator = { tokens: number };

const storage = new AsyncLocalStorage<Accumulator>();

/** Run `fn` in a fresh usage scope; return its result plus the tokens spent. */
export async function withUsage<T>(fn: () => Promise<T>): Promise<{ result: T; tokens: number }> {
  const acc: Accumulator = { tokens: 0 };
  const result = await storage.run(acc, fn);
  return { result, tokens: acc.tokens };
}

/** Add tokens to the current request's scope (no-op outside a withUsage run). */
export function addUsage(tokens: number): void {
  if (!tokens) return;
  const acc = storage.getStore();
  if (acc) acc.tokens += tokens;
}
