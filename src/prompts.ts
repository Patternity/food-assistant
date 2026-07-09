import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Prompts are versioned as plain text under /prompts so experiments are
// reproducible and diffable (see EVALUATION.md).
const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

const cache = new Map<string, string>();

/** Load a prompt file by base name (without extension), cached. */
export function loadPrompt(name: string): string {
  const hit = cache.get(name);
  if (hit) return hit;
  const text = readFileSync(join(promptsDir, `${name}.md`), "utf8").trim();
  cache.set(name, text);
  return text;
}

/** The shared persona, prepended to every task prompt as the system message. */
export function persona(): string {
  return loadPrompt("persona");
}
